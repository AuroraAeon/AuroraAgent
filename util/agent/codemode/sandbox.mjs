/**
 * 沙箱宿主侧（迁移 pi packages/codemode/src/runtime/host.ts）。
 *
 * 一次 execute() = 一个 worker + 一个 QuickJS VM。每次执行都新建 worker 让「终止」变简单：
 * 失控脚本（包括只空转微任务队列的那种）被 terminate() 杀掉，不会污染后续执行。
 * 沙箱对象本身只持有工具表与默认值，可复用于多次执行。
 *
 * 脚本能看到的全部能力：tools.<name>(args)、ALL_TOOLS、text / image / exit / console、
 * store / load 与配置的全局函数——没有定时器、fetch、process、require、模块与 WebAssembly。
 * execute() 永不因脚本失败而 reject：失败以 { ok: false, error } 返回。
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { toCodemodeIdentifier } from './identifier.mjs';
import { loadQuickJSWasm } from './wasm.mjs';
import { isWorkerToHostMessage } from './protocol.mjs';

const DEFAULT_TIMEOUT_MS = 300000;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** 脚本内全局名的保留字：与 prelude 装到 globalThis 上的东西冲突即拒绝注册 */
const RESERVED_GLOBALS = new Set(['tools', 'ALL_TOOLS', 'console', 'text', 'image', 'exit', 'globalThis', 'store', 'load']);

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

function serializeStore(store) {
  const serialized = {};
  for (const [key, value] of Object.entries(store ?? {})) {
    const json = JSON.stringify(value);
    if (json !== undefined) serialized[key] = json;
  }
  return serialized;
}

function parseStoreWrites(json) {
  const writes = { set: {}, delete: [] };
  for (const [key, value] of JSON.parse(json)) {
    if (value === undefined) writes.delete.push(key);
    else writes.set[key] = JSON.parse(value);
  }
  return writes;
}

/** worker 入口：本目录下的 worker.mjs（可用环境变量覆盖，Bundle 场景用） */
export function defaultWorkerUrl() {
  return process.env.AURORAAGENT_CODEMODE_WORKER
    || fileURLToPath(new URL('./worker.mjs', import.meta.url));
}

class Execution {
  constructor(options) {
    this.promise = new Promise((resolve) => { this.resolveResult = resolve; });
    this.options = options;
    this.tools = options.tools;
    this.globals = options.globals;
    this.signal = options.signal;
    this.worker = undefined;
    this.interrupt = new SharedArrayBuffer(4);
    this.output = [];
    this.calls = [];
    this.pending = new Map();
    this.finished = false;

    if (Number.isFinite(options.timeoutMs)) {
      this.timer = setTimeout(() => {
        this.finish({ kind: 'timeout', message: `执行超时（${options.timeoutMs} ms）` });
      }, options.timeoutMs);
    }
    if (options.signal) {
      if (options.signal.aborted) this.onAbort();
      else options.signal.addEventListener('abort', this.onAbort, { once: true });
    }
    options.wasm.then(
      (wasm) => this.start(options, wasm),
      (error) => { this.finish({ kind: 'sandbox', message: `QuickJS 加载失败：${errorMessage(error)}` }); },
    );
  }

  abort(message) {
    this.finish({ kind: 'aborted', message });
    return this.promise;
  }

  start(options, wasm) {
    if (this.finished) return;
    const workerData = {
      code: options.code,
      tools: [...options.tools.values()].map((tool) => ({
        name: tool.name,
        jsName: toCodemodeIdentifier(tool.name),
        description: String(tool.description ?? ''),
      })),
      globals: [...options.globals.values()].map((global) => ({ name: global.name, spread: global.spread === true })),
      wasm,
      memoryLimitBytes: options.memoryLimitBytes,
      store: options.store,
      interrupt: this.interrupt,
    };
    let worker;
    try {
      worker = new Worker(options.workerUrl, { workerData });
    } catch (error) {
      this.finish({ kind: 'sandbox', message: `worker 启动失败：${errorMessage(error)}` });
      return;
    }
    this.worker = worker;
    worker.on('message', (message) => this.handleMessage(message));
    worker.on('error', (error) => {
      this.finish({ kind: 'sandbox', name: error instanceof Error ? error.name : undefined, message: errorMessage(error) });
    });
    worker.on('exit', (code) => {
      this.finish({ kind: 'sandbox', message: `worker 以退出码 ${code} 结束，脚本尚未结算` });
    });
  }

  onAbort = () => {
    const reason = this.signal?.reason;
    this.finish({ kind: 'aborted', message: reason instanceof Error ? reason.message : '执行被中止' });
  };

  post(message) { this.worker?.postMessage(message); }

  handleMessage(message) {
    if (this.finished || !isWorkerToHostMessage(message)) return;
    switch (message.type) {
      case 'output': this.output.push(message.item); break;
      case 'call': void this.handleCall(message); break;
      case 'done': this.handleDone(message); break;
      case 'crash': this.finish({ kind: 'sandbox', message: message.message }); break;
    }
  }

  handleDone(message) {
    if (!message.ok) {
      const parsed = JSON.parse(message.error);
      this.finish({ kind: 'script', ...parsed });
      return;
    }
    this.finish(undefined, message.value === undefined ? undefined : JSON.parse(message.value), message.writes);
  }

  async handleCall(message) {
    const { id, name } = message;
    const isTool = message.target === 'tool';
    const record = isTool ? { name, status: 'cancelled', durationMs: 0 } : undefined;
    if (record) this.calls.push(record);
    const pending = { record, startedAt: performance.now(), controller: new AbortController() };
    this.pending.set(id, pending);

    let status;
    let reply;
    try {
      const tool = (isTool ? this.tools : this.globals).get(name);
      if (!tool) throw new Error(`未知${isTool ? '工具' : '全局函数'}「${name}」`);
      const args = message.args === undefined ? undefined : JSON.parse(message.args);
      const value = await tool.execute(args, { signal: pending.controller.signal });
      reply = { type: 'result', id, ok: true, payload: value === undefined ? undefined : JSON.stringify(value) };
      status = 'ok';
    } catch (error) {
      reply = { type: 'result', id, ok: false, payload: errorMessage(error) };
      status = 'error';
      // 失败原因记进 record：宿主侧也接得住（脚本内 try/catch 时尤其需要），
      // 否则调用清单里只剩一个光秃秃的 error 状态，模型看不出发生了什么
      if (record) record.error = errorMessage(error);
    }

    // 已被 finish() 取消：记录保持 cancelled，worker 也即将消失
    if (!this.pending.delete(id)) return;
    if (record) {
      record.status = status;
      record.durationMs = performance.now() - pending.startedAt;
    }
    this.post(reply);
  }

  finish(error, value, writes) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    this.signal?.removeEventListener('abort', this.onAbort);

    const now = performance.now();
    for (const pending of this.pending.values()) {
      if (pending.record) pending.record.durationMs = now - pending.startedAt;
      pending.controller.abort();
    }
    this.pending.clear();

    const result = error
      ? { ok: false, error, output: this.output, calls: this.calls }
      : { ok: true, value, output: this.output, calls: this.calls, storeWrites: writes === undefined ? { set: {}, delete: [] } : parseStoreWrites(writes) };
    if (!this.worker) {
      this.resolveResult(result);
      return;
    }
    // 先翻中断标志再 terminate： spinning 中的 wasm 只有中断处理函数能叫停
    Atomics.store(new Int32Array(this.interrupt), 0, 1);
    this.worker.terminate().catch(() => undefined).then(() => this.resolveResult(result));
  }
}

export class CodemodeSandbox {
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.memoryLimitBytes = options.memoryLimitBytes;
    this.wasm = options.wasm;
    this.workerUrl = options.workerUrl ?? defaultWorkerUrl();
    this.toolsByName = new Map();
    this.globalsByName = new Map();
    this.running = new Set();
    this.closed = false;
    for (const tool of options.tools ?? []) this.registerTool(tool);
    const namespaces = new Set();
    for (const global of options.globals ?? []) {
      const parts = String(global.name).split('.');
      if (parts.length > 2 || !parts.every((part) => IDENTIFIER.test(part)) || RESERVED_GLOBALS.has(parts[0])) {
        throw new Error(`非法全局函数名「${global.name}」`);
      }
      if (this.globalsByName.has(global.name)) throw new Error(`全局函数「${global.name}」已注册`);
      if (parts.length === 2) namespaces.add(parts[0]);
      this.globalsByName.set(global.name, global);
    }
    for (const name of namespaces) {
      if (this.globalsByName.has(name)) throw new Error(`全局函数「${name}」与命名空间冲突`);
    }
  }

  /** 同名工具重复注册即抛错（静默覆盖会让模型的调用打到别的工具上） */
  registerTool(tool) {
    if (this.toolsByName.has(tool.name)) throw new Error(`工具「${tool.name}」已注册`);
    this.toolsByName.set(tool.name, tool);
  }

  unregisterTool(name) { return this.toolsByName.delete(name); }

  get tools() { return [...this.toolsByName.values()]; }

  get globals() { return [...this.globalsByName.values()]; }

  /** code 是异步函数体：return 与顶层 await 都可用 */
  execute(code, options = {}) {
    if (this.closed) return Promise.reject(new Error('沙箱已关闭'));
    const execution = new Execution({
      code,
      tools: new Map(this.toolsByName),
      globals: this.globalsByName,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      signal: options.signal,
      memoryLimitBytes: this.memoryLimitBytes,
      store: serializeStore(options.store),
      wasm: this.wasm === undefined ? loadQuickJSWasm() : Promise.resolve(this.wasm),
      workerUrl: this.workerUrl,
    });
    this.running.add(execution);
    return execution.promise.finally(() => this.running.delete(execution));
  }

  /** 中止在飞执行（它们以 kind:'aborted' 收场），并拒绝此后的新执行 */
  async close() {
    this.closed = true;
    await Promise.all([...this.running].map((execution) => execution.abort('沙箱已关闭')));
  }
}
