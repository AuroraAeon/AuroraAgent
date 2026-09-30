/**
 * Hook 单元测试（util/agent/hooks/）：目录发现、事件词表、HookControl 解析与合并、
 * 子进程执行器（退出码 / 超时 / fail-open），以及 Loop 接入点的行为
 * （prompt_submit 改输入、pre_tool_use 的 cancel / review / overrideInput、
 * post_tool_use 追加上下文、round_start 取消、门控关闭时空转）。
 * 数据隔离：hook 脚本与数据目录全部落在临时目录，绝不碰真实数据目录。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  HOOK_EVENTS, normalizeEventName, eventFromFileName, buildPayload,
} from '../util/agent/hooks/events.mjs';
import { discoverHooks, HOOK_INTERPRETERS } from '../util/agent/hooks/config.mjs';
import { parseHookControl, mergeHookControls, HOOK_CONTEXT_LIMIT } from '../util/agent/hooks/control.mjs';
import { runHook } from '../util/agent/hooks/runner.mjs';
import { createHookRunner, nullHooks } from '../util/agent/hooks/index.mjs';
import { runAgentTurn } from '../util/agent/loop.mjs';
import { parseHooksArg, formatHookLines, formatHookEventLines, formatHookTestLines } from '../util/agent/hooks-cmd.mjs';
import { SessionStore } from '../util/agent/session.mjs';
import { UsageLedger } from '../util/usage.mjs';
import { getHarness } from '../util/agent/harness.mjs';

/** SSE 响应（真实 Response + ReadableStream，loop 用 getReader 消费） */
const sseResp = (frames) => new Response(new ReadableStream({
  start(c) {
    for (const f of frames) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
    c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    c.close();
  },
}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const textFrames = (txt) => [
  { choices: [{ index: 0, delta: { content: txt } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
];
const toolFrames = (name, args) => [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_t1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8 } },
];

/** 造一个 hook 脚本（.mjs，读 stdin 的 payload，往 stdout 写控制 JSON） */
function writeHook(dir, fileName, body) {
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, fileName);
  writeFileSync(abs, `let raw='';process.stdin.on('data',d=>raw+=d);process.stdin.on('end',()=>{try{const p=JSON.parse(raw||'{}');${body}}catch(e){process.exit(3)}});\n`);
  return abs;
}

/** 临时目录登记表：runLoop 与各测试造的文件都往里塞，finally 统一清掉 */
const TMP_DIRS = [];

/** 一次性 loop 运行环境（与 run-tests.mjs 的 runLoopOnce 同构，但可注入 hook runner） */
async function runLoop({ framesByCall, hooks, harness = getHarness('standard'), permission = 'allow', wsFiles = {}, input = '开始', hookDirs = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'aurora-hooks-'));
  const ws = join(dir, 'workspace');
  mkdirSync(ws, { recursive: true });
  for (const [rel, text] of Object.entries(wsFiles)) {
    const abs = join(ws, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  for (const [rel, text] of Object.entries(hookDirs)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  TMP_DIRS.push(dir);
  const store = new SessionStore(dir);
  const usage = new UsageLedger(dir);
  const session = store.create({ name: '', model: 'm1', harness: harness.id, workspace: ws });
  const events = [];
  const requests = [];
  const provider = { id: 'p1', name: '测试提供方', protocol: 'openai', baseUrl: 'https://up.test', pathPrefix: '/v1', apiKey: 'k' };
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, opts = {}) => {
    requests.push({ url: String(url), body: JSON.parse(opts.body || '{}') });
    const scripted = typeof framesByCall === 'function' ? framesByCall(call, requests.at(-1)) : framesByCall[Math.min(call, framesByCall.length - 1)];
    call++;
    return Array.isArray(scripted) ? sseResp(scripted) : sseResp(scripted.frames, scripted.status);
  };
  const controller = new AbortController();
  let permCalls = 0;
  const result = await runAgentTurn({
    store, usage, session, input, provider, model: 'm1', harness,
    builtinPrice: { input: 2, output: 8 },
    emit: (type, payload) => events.push({ type, ...payload }),
    controller,
    requestPermission: async () => { permCalls++; return permission; },
    titleMode: 'local',
    log: () => {},
    hooks: hooks || nullHooks,
  }).finally(() => { globalThis.fetch = realFetch; });
  return { dir, ws, store, usage, session, events, requests, result, permCalls };
}

export async function runHooksTests(test, assert, eq) {
  const savedFlag = process.env.AURORAAGENT_EXPERIMENTAL_HOOKS;
  process.env.AURORAAGENT_EXPERIMENTAL_HOOKS = '1';
  const keep = (dir) => TMP_DIRS.push(dir);

  try {
  console.log('\nHook（事件钩子）单元测试');

  await test('hooks: 事件词表与文件名归一', () => {
    eq(HOOK_EVENTS.length, 10, '十个事件');
    eq(normalizeEventName('PreToolUse'), 'pretooluse', '驼峰归一');
    eq(normalizeEventName('pre_tool_use'), 'pretooluse', '下划线归一');
    eq(normalizeEventName('pre-tool-use'), 'pretooluse', '连字符归一');
    eq(eventFromFileName('PreToolUse.sh'), 'pre_tool_use', '文件名即事件名');
    eq(eventFromFileName('post_tool_use.mjs'), 'post_tool_use', '下划线文件名');
    eq(eventFromFileName('Nope.sh'), null, '未知事件给 null');
    eq(eventFromFileName('README.md'), null, '非脚本后缀给 null');
    const p = buildPayload('pre_tool_use', { sessionId: 's1', turnId: 't1', round: 3, workspace: '/w' }, { tool: 'shell' });
    eq(p.hookName, 'pre_tool_use', 'payload 带事件名');
    eq(p.tool, 'shell', 'payload 带事件专属数据');
    eq(p.sessionId, 's1', 'payload 带公共字段');
    eq(typeof p.timestamp, 'string', 'payload 带时间戳');
  });

  await test('hooks: HookControl 解析与合并（cancel 粘性 / context 上限 / overrideInput 后者覆盖）', () => {
    eq(parseHookControl(''), null, '空输出无控制');
    eq(parseHookControl('not json'), null, '坏 JSON 无控制');
    eq(parseHookControl('日志行\n{"cancel":true}').cancel, true, '前后有日志也能解析');
    eq(parseHookControl('{"context":"x"}').context, 'x', 'context 字段');
    eq(parseHookControl('{"review":true}').review, true, 'review 字段');
    eq(parseHookControl('[]'), null, '数组不当控制');
    eq(parseHookControl('{"foo":1}'), null, '无已知字段给 null');
    const merged = mergeHookControls([{ cancel: true }, { context: 'a' }]);
    eq(merged.cancel, true, 'cancel 粘性（任一 hook 说取消就取消）');
    eq(merged.context, 'a', 'context 累积');
    eq(merged.applied, 2, 'applied 计数');
    const over = mergeHookControls([{ overrideInput: { a: 1 } }, { overrideInput: { b: 2 } }]);
    eq(over.overrideInput.b, 2, 'overrideInput 后者覆盖');
    eq(over.overrideInput.a, undefined, 'overrideInput 不合并（整体替换）');
    const big = mergeHookControls([{ context: 'x'.repeat(HOOK_CONTEXT_LIMIT) }, { context: 'y'.repeat(100) }]);
    assert(big.context.length <= HOOK_CONTEXT_LIMIT, 'context 合计不超上限');
    eq(mergeHookControls([null, undefined]).applied, 0, '空控制不影响');
  });

  await test('hooks: 目录发现——项目钩子优先、未知后缀与不可执行文件告警跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-hookdir-'));
    keep(dir);
    const dataHooks = join(dir, 'data', 'hooks');
    const wsHooks = join(dir, 'ws', '.auroraagent', 'hooks');
    writeHook(dataHooks, 'PreToolUse.mjs', 'process.stdout.write("{}")');
    writeHook(dataHooks, 'TurnEnd.mjs', 'process.stdout.write("{}")');
    writeHook(wsHooks, 'pre_tool_use.mjs', 'process.stdout.write(\'{"cancel":true}\')');
    writeFileSync(join(wsHooks, 'notes.txt'), 'x');
    writeFileSync(join(wsHooks, 'PostToolUse'), 'x');
    const { hooks, warnings } = discoverHooks({ dataDir: join(dir, 'data'), workspace: join(dir, 'ws') });
    const pre = hooks.find((h) => h.event === 'pre_tool_use');
    eq(pre.source, 'workspace', '项目钩子覆盖个人钩子');
    eq(hooks.length, 2, '两个事件各留一个');
    assert(warnings.some((w) => w.includes('notes.txt')), '不支持的后缀告警');
    assert(warnings.some((w) => w.includes('PostToolUse')), '无后缀不可执行告警');
    assert(warnings.some((w) => w.includes('项目钩子优先')), '覆盖时给告警');
    assert(HOOK_INTERPRETERS['.mjs'] === process.execPath, '.mjs 用当前 node 解释');
  });

  await test('hooks: 执行器退出码语义——0 正常 / 2 取消 / 其它 fail-open', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-hookrun-'));
    keep(dir);
    const okPath = writeHook(dir, 'ok.mjs', 'process.stdout.write(JSON.stringify({context:"hi"}))');
    const cancelPath = writeHook(dir, 'cancel.mjs', 'process.stderr.write("不允许\\n");process.exit(2)');
    const failPath = writeHook(dir, 'fail.mjs', 'process.stderr.write("炸了");process.exit(1)');
    const r1 = await runHook({ path: okPath, interpreter: process.execPath }, { hookName: 'turn_end' }, {});
    eq(r1.ok, true, '退出码 0 正常');
    eq(r1.control.context, 'hi', 'stdout 解析成控制');
    const r2 = await runHook({ path: cancelPath, interpreter: process.execPath }, { hookName: 'turn_end' }, {});
    eq(r2.ok, true, '退出码 2 仍算正常路径');
    eq(r2.control.cancel, true, '退出码 2 = 显式取消');
    assert(String(r2.error).includes('不允许'), '取消原因取 stderr 首行');
    const warns = [];
    const r3 = await runHook({ path: failPath, interpreter: process.execPath }, { hookName: 'turn_end' }, { log: (l, m) => warns.push(m) });
    eq(r3.ok, false, '其它退出码算失败');
    eq(r3.control, null, '失败不给控制（fail-open）');
    assert(warns.length > 0, '失败记日志');
  });

  await test('hooks: 执行器超时杀掉子进程，不挂死 turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-hookto-'));
    keep(dir);
    const slow = writeHook(dir, 'slow.mjs', 'setTimeout(()=>process.stdout.write("{}"),30000)');
    const t0 = Date.now();
    const r = await runHook({ path: slow, interpreter: process.execPath }, { hookName: 'turn_end' }, { timeoutMs: 600 });
    assert(Date.now() - t0 < 5000, '超时应远早于脚本自己的 30s');
    eq(r.ok, false, '超时算失败');
    assert(String(r.error).includes('超时'), '超时原因可读');
  });

  await test('hooks: 门控关闭时 discover 给空清单、fire 恒无控制', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-hookoff-'));
    keep(dir);
    writeHook(join(dir, 'data', 'hooks'), 'PreToolUse.mjs', 'process.stdout.write(\'{"cancel":true}\')');
    delete process.env.AURORAAGENT_EXPERIMENTAL_HOOKS;
    const runner = createHookRunner({ workspace: join(dir, 'ws'), dataDir: join(dir, 'data') });
    eq(runner.enabled, false, '门控关闭');
    eq(runner.hooks.length, 0, '不发现脚本');
    eq(runner.describe().length, 0, '描述为空');
    process.env.AURORAAGENT_EXPERIMENTAL_HOOKS = '1';
  });

  await test('hooks: prompt_submit 的 overrideInput 改写入参（落库与标题都认改写后的值）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-hookps-'));
    keep(dir);
    // createHookRunner 只认 <dataDir>/hooks 与 <workspace>/.auroraagent/hooks，写文件即生效
    writeHook(join(dir, 'hooks'), 'PromptSubmit.mjs', 'process.stdout.write(JSON.stringify({overrideInput:"改写后的提问"}))');
    const r2 = createHookRunner({ workspace: '', dataDir: dir });
    const { store, session } = await runLoop({ framesByCall: [textFrames('好的')], hooks: r2, input: '原始提问' });
    const recs = store.records(session.id);
    eq(recs[0].text, '改写后的提问', '用户记录落的是改写后的输入');
    eq(session.name.length > 0, true, '标题照常生成');
  });

  await test('hooks: pre_tool_use 的 cancel 让工具不执行，结果回给模型说明原因', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-hookcancel-'));
    keep(dir);
    writeHook(join(dir, 'hooks'), 'PreToolUse.mjs', 'process.stdout.write(\'{"cancel":true}\')');
    const runner = createHookRunner({ workspace: '', dataDir: dir });
    const { requests, result } = await runLoop({
      framesByCall: [toolFrames('shell', { command: 'echo hi' }), textFrames('已取消')],
      hooks: runner,
      wsFiles: {},
    });
    eq(result.failed, undefined, 'turn 不因 hook 失败');
    const toolMsg = requests.at(-1).body.messages.find((m) => m.role === 'tool');
    assert(String(toolMsg.content).includes('钩子取消了'), '工具结果说明被 hook 取消');
  });

  await test('hooks: pre_tool_use 的 review 转权限通道（复用 pending permission）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-hookreview-'));
    keep(dir);
    writeHook(join(dir, 'hooks'), 'PreToolUse.mjs', 'process.stdout.write(\'{"review":true}\')');
    const runner = createHookRunner({ workspace: '', dataDir: dir });
    const { events, permCalls } = await runLoop({
      framesByCall: [toolFrames('shell', { command: 'echo hi' }), textFrames('done')],
      hooks: runner,
      permission: 'allow',
    });
    eq(permCalls, 1, 'review 触发一次权限询问');
    assert(events.some((e) => e.type === 'tool_event' && e.phase === 'confirmation_needed'), '走了权限确认事件');
  });

  await test('hooks: pre_tool_use 的 overrideInput 改参数（执行与后续消息都用改后的值）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-hookoi-'));
    keep(dir);
    writeHook(join(dir, 'hooks'), 'PreToolUse.mjs', 'process.stdout.write(JSON.stringify({overrideInput:{command:"echo 改写了"}}))');
    const runner = createHookRunner({ workspace: '', dataDir: dir });
    const { requests } = await runLoop({
      framesByCall: [toolFrames('shell', { command: 'echo 原文' }), textFrames('done')],
      hooks: runner,
    });
    const toolMsg = requests.at(-1).body.messages.find((m) => m.role === 'tool');
    assert(String(toolMsg.content).includes('改写了'), '工具执行用的是改写后的参数');
    assert(!String(toolMsg.content).includes('原文'), '原参数未执行');
  });

  await test('hooks: post_tool_use 的 context 注入下一轮请求的系统提示', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-hookctx-'));
    keep(dir);
    writeHook(join(dir, 'hooks'), 'PostToolUse.mjs', 'process.stdout.write(JSON.stringify({context:"这是钩子塞的上下文"}))');
    const runner = createHookRunner({ workspace: '', dataDir: dir });
    const { requests } = await runLoop({
      framesByCall: [toolFrames('shell', { command: 'echo hi' }), textFrames('done')],
      hooks: runner,
    });
    assert(requests.length >= 2, '至少两轮请求');
    assert(String(requests[1].body.messages[0].content).includes('这是钩子塞的上下文'), '钩子上下文进第二轮系统提示');
    assert(!String(requests[0].body.messages[0].content).includes('这是钩子塞的上下文'), '第一轮还没有（工具还没跑）');
  });

  await test('hooks: round_start 的 cancel 跳过本轮模型调用，turn 无工具收尾', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-hookrs-'));
    keep(dir);
    writeHook(join(dir, 'hooks'), 'RoundStart.mjs', 'process.stdout.write(\'{"cancel":true}\')');
    const runner = createHookRunner({ workspace: '', dataDir: dir });
    const { requests, result } = await runLoop({
      framesByCall: [textFrames('不该被调用')],
      hooks: runner,
    });
    eq(requests.length, 0, '一次上游请求都没发');
    eq(result.text, '', '无产出');
    eq(result.failed, undefined, '不算失败');
  });

  await test('hooks-cmd: /hooks 参数解析与展示行', () => {
    eq(parseHooksArg('').action, 'list', '无参列出');
    eq(parseHooksArg('list').action, 'list', 'list 子命令');
    eq(parseHooksArg('events').action, 'events', 'events 子命令');
    eq(parseHooksArg('test pre_tool_use').event, 'pre_tool_use', 'test 归一事件名');
    eq(parseHooksArg('test PreToolUse').event, 'pre_tool_use', 'test 接受驼峰文件名写法');
    eq(parseHooksArg('test nope').action, 'error', '未知事件报错');
    eq(parseHooksArg('test').action, 'error', 'test 缺事件名报错');
    eq(parseHooksArg('frobnicate').action, 'error', '未知子命令报错');
    eq(formatHookLines({ enabled: false, hooks: [] })[0].includes('AURORAAGENT_EXPERIMENTAL_HOOKS'), true, '门控关闭给开启指引');
    eq(formatHookLines({ enabled: true, hooks: [] })[0].includes('尚未发现钩子'), true, '空清单与「被关掉」可区分');
    const lines = formatHookLines({ enabled: true, hooks: [{ event: 'pre_tool_use', path: '/x/PreToolUse.sh', source: 'workspace' }] });
    eq(lines[0], 'pre_tool_use · 项目 · /x/PreToolUse.sh', '钩子行带来源');
    eq(formatHookEventLines().length, 10, '事件清单十个');
    const t = formatHookTestLines('pre_tool_use', { fired: 2, cancel: true, review: false, context: '', systemPrompt: '', overrideInput: undefined, logs: [{ ok: true, path: '/a', ms: 3 }, { ok: false, path: '/b', error: '超时', ms: 10000 }] });
    assert(t[0].includes('2 个钩子'), '汇总行');
    assert(t[1].includes('cancel'), '合并控制带 cancel');
    assert(t.some((l) => l.includes('超时')), '失败的脚本给出原因');
  });

  await test('hooks: 未注入 runner 时 Loop 全程空转（行为与接线前一致）', async () => {
    const { requests, result } = await runLoop({ framesByCall: [textFrames('正常回答')] });
    eq(requests.length, 1, '正常发一次请求');
    eq(result.text, '正常回答', '正常返回');
  });

  await test('hooks: 门控关闭时即使注入了 runner 也不执行脚本', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-hookg-'));
    keep(dir);
    writeHook(join(dir, 'hooks'), 'PreToolUse.mjs', 'process.stdout.write(\'{"cancel":true}\')');
    delete process.env.AURORAAGENT_EXPERIMENTAL_HOOKS;
    const runner = createHookRunner({ workspace: '', dataDir: dir });
    const { requests } = await runLoop({
      framesByCall: [toolFrames('shell', { command: 'echo hi' }), textFrames('done')],
      hooks: runner,
    });
    const toolMsg = requests.at(-1).body.messages.find((m) => m.role === 'tool');
    assert(!String(toolMsg.content).includes('钩子取消了'), '门控关闭时 hook 不生效');
    process.env.AURORAAGENT_EXPERIMENTAL_HOOKS = '1';
  });

  await test('hooks: 单个 hook 崩溃不影响 turn（fail-open）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-hookcrash-'));
    keep(dir);
    writeHook(join(dir, 'hooks'), 'PreToolUse.mjs', 'process.exit(3)');
    const runner = createHookRunner({ workspace: '', dataDir: dir });
    const { requests, result } = await runLoop({
      framesByCall: [toolFrames('shell', { command: 'echo hi' }), textFrames('done')],
      hooks: runner,
    });
    const toolMsg = requests.at(-1).body.messages.find((m) => m.role === 'tool');
    assert(String(toolMsg.content).includes('hi'), 'hook 崩溃后工具照常执行');
    eq(result.failed, undefined, 'turn 不失败');
  });

  } finally {
    if (savedFlag === undefined) delete process.env.AURORAAGENT_EXPERIMENTAL_HOOKS;
    else process.env.AURORAAGENT_EXPERIMENTAL_HOOKS = savedFlag;
    for (const d of TMP_DIRS.splice(0)) rmSync(d, { recursive: true, force: true });
  }
}
