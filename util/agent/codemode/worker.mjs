/**
 * Worker 入口（迁移 pi packages/codemode/src/runtime/worker.ts）：一个 worker 跑一个脚本，
 * 脚本活在独立的 QuickJS VM（独立 wasm 实例）里；工具调用与输出经 parentPort 中转回宿主，
 * 结果由宿主读。宿主在脚本结束 / 超时 / 中止时终止 worker——worker 存在的理由就是
 * 「死循环脚本不能占住宿主线程」。
 *
 * import 本模块即启动 worker。宿主侧默认用本文件路径创建 Worker；Bundle 场景可用
 * AURORAAGENT_CODEMODE_WORKER 覆盖路径。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { JSException, MAX_STACK_SIZE, QuickJS } from 'quickjs-wasi';
import { PRELUDE_SOURCE } from './prelude.mjs';
import { isHostToWorkerMessage } from './protocol.mjs';

const post = (message) => { parentPort?.postMessage(message); };

const crash = (error) => {
  post({ type: 'crash', message: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
};

/**
 * QuickJS 的引擎诊断走 fd 1 / 2，默认 shim 会把它们转发到宿主的 stdout / stderr——
 * 那些输出属于宿主应用（终端 TUI / 服务日志），必须丢掉。照实报告「已写入字节数」，
 * libc 才不会重试。
 */
function discardOutput(memory) {
  return {
    fd_write(_fd, iovsPtr, iovsLen, nwrittenPtr) {
      const view = new DataView(memory.buffer);
      let written = 0;
      for (let i = 0; i < iovsLen; i++) written += view.getUint32(iovsPtr + i * 8 + 4, true);
      view.setUint32(nwrittenPtr, written, true);
      return 0;
    },
  };
}

function describeException(error) {
  const head = error.message ? `${error.name}: ${error.message}` : error.name;
  const stack = error.stack?.trimEnd();
  return JSON.stringify({ name: error.name, message: error.message, stack: stack ? `${head}\n${stack}` : head });
}

async function main(data) {
  const interrupt = new Int32Array(data.interrupt);
  const vm = await QuickJS.create({
    wasm: data.wasm,
    memoryLimit: data.memoryLimitBytes,
    // 不设栈上限时，深递归会溢出 wasm 栈直接 trap，脚本里 catch 不到 RangeError
    maxStackSize: MAX_STACK_SIZE,
    interruptHandler: () => Atomics.load(interrupt, 0) !== 0,
    wasi: discardOutput,
  });

  // 由前置源码回调，参数全是原始值
  const bridge = vm.newFunction('bridge', (kind, a, b, c) => {
    switch (kind.toString()) {
      case 'call':
      case 'global':
        post({
          type: 'call',
          id: a.toNumber(),
          target: kind.toString() === 'call' ? 'tool' : 'global',
          name: b.toString(),
          args: c === undefined || c.isUndefined ? undefined : c.toString(),
        });
        break;
      case 'output':
        post({
          type: 'output',
          item: a.toString() === 'image'
            ? { type: 'image', data: b.toString(), mimeType: c.toString() }
            : { type: 'text', text: b.toString() },
        });
        break;
      case 'done':
        if (a.toBoolean()) {
          post({
            type: 'done',
            ok: true,
            value: b === undefined || b.isUndefined ? undefined : b.toString(),
            writes: c.toString(),
          });
        } else {
          post({ type: 'done', ok: false, error: b.toString() });
        }
        break;
    }
    return vm.undefined;
  });

  // VM 活到宿主终止 worker 为止，这些句柄因此永不 dispose
  const api = vm.withScope((scope) =>
    scope.escape(
      vm.callFunction(
        vm.evalCode(PRELUDE_SOURCE, 'codemode-prelude.js'),
        vm.undefined,
        bridge,
        vm.newString(JSON.stringify(data.tools)),
        vm.newString(JSON.stringify(data.globals)),
        vm.newString(JSON.stringify(data.store)),
      ),
    ),
  );
  const settle = api.getProp('settle');
  const run = api.getProp('run');
  const stalled = api.getProp('stalled');
  /** 先跑排队的作业，再把「永远等不到唤醒」的脚本立刻判失败 */
  const drain = () => {
    vm.executePendingJobs();
    vm.callFunction(stalled, api).dispose();
  };

  parentPort?.on('message', (message) => {
    if (!isHostToWorkerMessage(message)) return;
    try {
      vm.withScope(() => {
        vm.callFunction(
          settle,
          api,
          vm.newNumber(message.id),
          message.ok ? vm.true : vm.false,
          message.payload === undefined ? vm.undefined : vm.newString(message.payload),
        );
      });
      drain();
    } catch (error) {
      crash(error);
    }
  });

  // 前缀与脚本共用首行，堆栈里报告的行号才与模型写的源码对齐
  let fn;
  try {
    fn = vm.evalCode(`(async (tools, console) => {${data.code}\n})`, 'codemode.js');
  } catch (error) {
    if (!(error instanceof JSException)) throw error;
    post({ type: 'done', ok: false, error: describeException(error) });
    return;
  }
  vm.callFunction(run, api, fn).dispose();
  fn.dispose();
  drain();
}

if (parentPort) {
  main(workerData).catch(crash);
}
