/**
 * 代码模式执行器（迁移 pi packages/coding-agent/src/extensions/codemode/execute.ts 的本地化子集）。
 *
 * 一次 `code` 工具调用 = 一个 QuickJS 沙箱执行：
 *   1) 解析可选的 `// @options:` 首行；
 *   2) 把本 turn 可调用的工具（含未随请求声明的 deferred 外部工具）注入沙箱；
 *   3) 嵌套调用经 Loop 注入的 runtime.nested() 走完整管道——权限确认、钩子、忽略闸门、
 *      断点记账一样不少，与直接调用同口径；只有脚本自己的输出与返回值进模型上下文；
 *   4) 结果按 token 预算截断（超长时把全文 spill 到临时文件，告诉模型路径让它自己读回）。
 *
 * 不迁 pi 的 `models.*` 全局函数：那是上游的模型目录 / 分类器直连，AuroraAgent 的模型
 * 路由走提供方配置与 /api/chat 底座，模型目录不进 Agent 沙箱。
 */
import { randomBytes } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodemodeSandbox } from './sandbox.mjs';
import { loadQuickJSWasm } from './wasm.mjs';
import { parseCodemodeSource } from './source.mjs';
import { renderToolSample, toCodemodeIdentifier } from './declarations.mjs';

export const CODE_TOOL_NAME = 'code';

/** QuickJS VM 堆上限。worker 与宿主同进程，不设上限时失控脚本能涨到 wasm32 的 4GiB 拖垮会话；
 *  超限在脚本内抛 InternalError: out of memory */
export const CODE_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

export const CODE_MODE_DEFAULTS = Object.freeze({ enabled: true, timeoutMs: 300000, maxOutputTokens: 8000 });
const CHARS_PER_TOKEN = 4;
/** 描述里可放的工具声明预算（字符）；放不下的工具告诉模型用 describeTool() 查 */
const INLINE_BUDGET_CHARS = 12000;
const ARGS_PREVIEW_CHARS = 200;
const ERROR_PREVIEW_CHARS = 500;
/** spill 目录（进程级，退出即删）——与 shell 输出 spill 同一生命周期口径 */
const SPILL_DIR = join(tmpdir(), `auroraagent-codemode-${process.pid}`);

const clampInt = (value, min, max, fallback) => (
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback
);

/** codeMode 配置段（单叶容错 + 钳制，与 toolSearch / promptCacheWarm 同一纪律） */
export function parseCodeModeConfig(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: r.enabled !== false,
    timeoutMs: clampInt(r.timeoutMs, 1000, 3600000, CODE_MODE_DEFAULTS.timeoutMs),
    maxOutputTokens: clampInt(r.maxOutputTokens, 200, 200000, CODE_MODE_DEFAULTS.maxOutputTokens),
  };
}

const truncate = (text, maxChars) => (text.length > maxChars ? `${text.slice(0, maxChars - 3)}...` : text);

function previewArgs(args) {
  if (args === undefined) return '';
  try { return truncate(JSON.stringify(args) ?? '', ARGS_PREVIEW_CHARS); } catch { return ''; }
}

/** 工具 → 脚本可见样本（描述 + TS 声明） */
function sampleOf(tool) {
  return renderToolSample({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    outputSchema: undefined,
  });
}

/**
 * `code` 工具描述：能力边界 + 脚本内 API + 可调用工具声明。
 * 声明按预算内联，放不下的不列（描述恒定大小比穷举更重要），模型用 describeTool() 补看。
 */
export function buildCodeDescription(tools) {
  const list = (Array.isArray(tools) ? tools : []).filter((t) => t && t.name && t.name !== CODE_TOOL_NAME);
  const sections = [
    '在 QuickJS WebAssembly 沙箱里运行一段 JavaScript，用脚本编排这一轮可调用的工具。',
    '沙箱内没有定时器 / fetch / process / require / 模块 / WebAssembly——唯一能力就是调用注入的工具；脚本超时或被中止即结束，已产生的输出仍会回传。',
    '脚本体是异步函数体：return 与顶层 await 都可用。首行可写 `// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}` 覆盖输出预算与超时。',
    '脚本内 API：`tools.<工具名>(args)` 返回 Promise（参数与结果都过 JSON 回合）；`ALL_TOOLS` 列出全部工具；`text(value)` / `console.log` 追加文本输出；`image(dataUrl)` 追加图片；`describeTool(name)` 查任一工具的完整声明；`store(k,v)` / `load(k)` 跨调用存取 JSON 值；`exit()` 立刻成功收尾。',
    '嵌套的工具调用与直接调用一样要过权限确认、忽略闸门与钩子；嵌套结果不进上下文，只有脚本自己的输出与返回值进。',
    '适合：把多次工具调用串成流水线（读—改—验）、对多个文件做同一套处理、过滤与聚合工具输出。',
  ];
  if (list.length === 0) {
    sections.push('当前没有可调用工具：只能做纯计算（无外部能力）。');
    return sections.join('\n');
  }
  const lines = [];
  let used = 0;
  let omitted = 0;
  for (const tool of list) {
    const sample = sampleOf(tool);
    if (used + sample.length > INLINE_BUDGET_CHARS && lines.length > 0) { omitted += 1; continue; }
    lines.push(sample);
    used += sample.length;
  }
  sections.push(`可调用工具（${list.length} 个${omitted ? `，其中 ${omitted} 个未在此列出，用 describeTool("名称") 查看` : ''}）：\n${lines.join('\n')}`);
  return sections.join('\n');
}

/** 全文 spill 到临时文件（与 shell 输出截断同一口径：模型能自己读回） */
async function spillOutput(text) {
  try {
    await mkdir(SPILL_DIR, { recursive: true });
    const path = join(SPILL_DIR, `out-${randomBytes(8).toString('hex')}.txt`);
    await writeFile(path, text);
    return { path };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * token 预算：合并文本超出预算时只留头尾，中间以省略号标记，全文 spill 到临时文件并给出路径；
 * 图片不受预算影响，跟在截断文本之后。
 */
async function truncateOutput(items, maxTokens) {
  const texts = items.filter((item) => item.type === 'text').map((item) => item.text);
  const combined = texts.join('\n');
  const budget = maxTokens * CHARS_PER_TOKEN;
  if (texts.length === 0 || combined.length <= budget) return { items, spilled: '' };
  const headChars = Math.floor(budget / 2);
  const tailChars = budget - headChars;
  const removed = combined.length - headChars - tailChars;
  const head = combined.slice(0, headChars);
  const tail = tailChars > 0 ? combined.slice(-tailChars) : '';
  let text = `警告：输出已截断（原文约 ${Math.ceil(combined.length / CHARS_PER_TOKEN)} tokens，共 ${combined.split('\n').length} 行）\n\n${head}…已截断 ${Math.ceil(removed / CHARS_PER_TOKEN)} tokens…${tail}`;
  const spilled = await spillOutput(combined);
  text += 'path' in spilled
    ? `\n\n[完整输出: ${spilled.path}（用 read_file 分段读回）]`
    : `\n\n[完整输出保存失败: ${spilled.error}]`;
  return {
    items: [{ type: 'text', text }, ...items.filter((item) => item.type === 'image')],
    spilled: 'path' in spilled ? spilled.path : '',
  };
}

function formatCallSummary(calls) {
  if (calls.length === 0) return '嵌套工具调用：无';
  const lines = calls.map((c) => {
    const ms = c.durationMs ? ` ${(c.durationMs / 1000).toFixed(1)}s` : '';
    const err = c.error ? `：${truncate(c.error, ERROR_PREVIEW_CHARS)}` : '';
    return `- ${c.name}${c.args ? ` ${c.args}` : ''} → ${c.status}${ms}${err}`;
  });
  return `嵌套工具调用 ${calls.length} 次：\n${lines.join('\n')}`;
}

/** 工具结果文本：头部状态 + 输出 + 调用清单（失败时附错误与堆栈） */
export function renderCodemodeResult(result) {
  const head = result.ok
    ? `脚本已完成（return 值见末尾）`
    : result.error.kind === 'timeout' ? `脚本超时：${result.error.message}`
      : result.error.kind === 'aborted' ? `脚本被中止：${result.error.message}`
        : result.error.kind === 'sandbox' ? `脚本沙箱故障：${result.error.message}`
          : `脚本执行失败：${result.error.name ? `${result.error.name}: ` : ''}${result.error.message}`;
  const parts = [head, '', formatCallSummary(result.calls)];
  const textItems = result.output.filter((item) => item.type === 'text');
  if (textItems.length > 0) {
    parts.push('', '—— 脚本输出 ——', textItems.map((item) => item.text).join('\n'));
  }
  if (result.ok) {
    const value = result.value === undefined ? '（无返回值）' : typeof result.value === 'string' ? result.value : JSON.stringify(result.value) ?? String(result.value);
    parts.push('', '—— 返回值 ——', value);
  } else if (result.error.stack) {
    parts.push('', '—— 堆栈 ——', result.error.stack);
  }
  return parts.join('\n');
}

/**
 * 跑一个脚本。runtime 由 Loop 注入：
 *   { cfg, tools: () => 本 turn 工具表, nested: (name, args) => {ok, output},
 *     event: (phase, info) => void, store: { read, write } }
 */
export async function executeCodemode(params, ctx) {
  const runtime = ctx?.codemode;
  if (!runtime) throw new Error('code 工具需要会话运行时上下文');
  const cfg = runtime.cfg ?? parseCodeModeConfig(undefined);
  const startedAt = performance.now();
  const { code, options } = parseCodemodeSource(params?.code);
  const maxOutputTokens = options.maxOutputTokens ?? cfg.maxOutputTokens;

  const callable = (typeof runtime.tools === 'function' ? runtime.tools() : [])
    .filter((t) => t && t.name && t.name !== CODE_TOOL_NAME);
  const samples = new Map(callable.map((tool) => [tool.name, sampleOf(tool)]));
  const calls = [];
  let seq = 0;

  const sandboxTools = callable.map((tool) => ({
    name: tool.name,
    description: samples.get(tool.name),
    execute: async (args, { signal: callSignal }) => {
      // 嵌套 id 挂在 code 调用 id 之下（<code 调用 id>/<n>）：两端据此把嵌套调用渲染成代码行
      const record = {
        id: `${ctx?.toolId ? `${ctx.toolId}/` : ''}n${++seq}`,
        name: tool.name,
        args: previewArgs(args),
        status: 'running',
        durationMs: 0,
        error: '',
      };
      calls.push(record);
      runtime.event?.('started', { id: record.id, name: tool.name, args: args ?? {} });
      const callStartedAt = performance.now();
      const outcome = await runtime.nested(tool.name, args, { signal: callSignal, id: record.id });
      record.durationMs = performance.now() - callStartedAt;
      if (!outcome || outcome.ok !== true) {
        record.status = callSignal?.aborted ? 'cancelled' : 'error';
        record.error = truncate(String(outcome?.output ?? `工具 ${tool.name} 执行失败`), ERROR_PREVIEW_CHARS);
        runtime.event?.('failed', { id: record.id, name: tool.name, output: record.error });
        // 失败 / 被拒 / 参数非法的嵌套调用以 Error 拒绝——脚本里 try/catch 才接得住
        throw new Error(record.error);
      }
      record.status = 'ok';
      runtime.event?.('completed', { id: record.id, name: tool.name, output: String(outcome.output ?? '') });
      return String(outcome.output ?? '');
    },
  }));

  const sandbox = new CodemodeSandbox({
    tools: sandboxTools,
    globals: [{
      name: 'describeTool',
      spread: true,
      description: '查看任一可调用工具的完整声明与描述',
      execute: (args) => {
        const name = String(args?.[0] ?? '');
        const hit = callable.find((t) => t.name === name || toCodemodeIdentifier(t.name) === name);
        return hit ? samples.get(hit.name) : `没有名为「${name}」的工具；ALL_TOOLS 里列了全部可用工具。`;
      },
    }],
    timeoutMs: options.timeoutMs ?? cfg.timeoutMs,
    memoryLimitBytes: CODE_MEMORY_LIMIT_BYTES,
    wasm: loadQuickJSWasm(),
  });

  let result;
  try {
    result = await sandbox.execute(code, { signal: ctx?.signal, store: runtime.store?.read() ?? {} });
  } finally {
    await sandbox.close();
  }
  // 脚本结束 / 超时 / 中止时仍标 running 的调用是被掐断的
  for (const call of calls) if (call.status === 'running') call.status = 'cancelled';

  // 预算截断放在渲染之前：模型看到的文本就是截断后的那份，spill 路径随文给出
  const { items, spilled } = await truncateOutput(result.output, maxOutputTokens);
  // 调用清单用宿主侧那份：它带 id 与参数预览（沙箱侧的 record 只有 name/status/duration），
  // 模型看到的调用摘要才说得清「拿什么参数调了什么」
  let text = renderCodemodeResult({ ...result, output: items, calls });
  if (spilled) text += `\n\n[输出全文: ${spilled}]`;
  // store 写回失败只把话带到结果里：脚本已经跑完、输出已经在手，为一次盘上落写失败
  // 把整个调用判成失败，模型会白白重跑一遍（可能连带着把嵌套工具再走一次）
  if (result.ok && result.storeWrites && (Object.keys(result.storeWrites.set).length || result.storeWrites.delete.length)) {
    try {
      runtime.store?.write?.(result.storeWrites);
    } catch (error) {
      text += `\n\n[注意：store 的跨调用存取没能保存（${error instanceof Error ? error.message : String(error)}），下一次执行读不到本次写入的值]`;
    }
  }
  return {
    output: text,
    extra: {
      codeMode: {
        ok: result.ok,
        durationMs: Math.round(performance.now() - startedAt),
        images: items.filter((item) => item.type === 'image').length,
        calls: calls.map((c) => ({ ...c })),
      },
    },
  };
}
