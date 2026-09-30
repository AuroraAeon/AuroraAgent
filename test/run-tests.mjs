/**
 * 测试套件（e2e 模式：真实 socket + mock 上游）。
 * 运行: npm test
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, existsSync, appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SseParser, estimateTokens } from '../util/sse.mjs';
import { sidebarToggleLabel, newSessionLabel, isAppleKeyboardPlatform } from '../web-ui/src/shortcut.ts';
import { buildTurnNavItems, normalizePreviewText, resolveBarVisualState, resolveActiveItemIndex, resolveVisibleRange, resolveRailScrollTopForActive } from '../web-ui/src/turn-nav.mjs';
import { createNavHistory, pushNav, goBack, goForward, canGoBack, canGoForward, removeNav, NAV_HISTORY_MAX } from '../web-ui/src/nav-history.mjs';
import { splitMathSegments, takeDisplayMath, isDisplayMathStart, mathDisplay, MATH_ENVIRONMENTS } from '../web-ui/src/math-split.mjs';
import { normalizeThinkingText, resolveReasoningStreamingSummary, isReasoningSummaryOverflowing } from '../web-ui/src/reasoning.mjs';
import { startMock } from './mock-longcat.mjs';
import { ProviderStore, ProviderError, parseCapacity, formatCapacity, normalizeEndpoint, validateProviderDraft, chatUrl, modelsUrl, messagesUrl } from '../util/providers.mjs';
import { catalogProviders, catalogProvider, catalogPresetDraft, catalogLabel, SUPPORTED_FORMATS } from '../util/provider-catalog.mjs';
import { buildChatRequest, anthropicFrame } from '../util/wire.mjs';
import { consumeAgentStream } from '../util/stream.mjs';
import { agentEvent, sseFrame } from '../util/agent/events.mjs';
import { HARNESSES, getHarness, harnessSummaries, DEFAULT_HARNESS } from '../util/agent/harness.mjs';
import { SessionStore } from '../util/agent/session.mjs';
import { getTool, toolSchemas, anthropicToolSchemas, toolResource, resolveInside, lineDiff, diffToText, renderTodoList } from '../util/agent/tools.mjs';
import { toolLabel, toolIconKey, toolResourceOf, fmtCost, projectTurns } from '../util/agent/transcript.mjs';
import { PermissionPolicy, defaultRules, mostRestrictive } from '../util/agent/policy.mjs';
import { assembleMessages, needsCompaction, planCompaction, compactionMessages, contextWindowOf, estimateMessagesTokens, findCutIndex, safeCutPoints, droppedWorkSummary } from '../util/agent/context.mjs';
import { runAgentTurn, createModelSteer } from '../util/agent/loop.mjs';
import { connectMcp, callResultText, McpError } from '../util/mcp/client.mjs';
import { McpRegistry, validateServerDraft, loadMcpServers, mcpToolName } from '../util/mcp/registry.mjs';
import { UsageLedger } from '../util/usage.mjs';
import { ErrorLog, createDeduper, normalizeErrorKind, sanitizeSecrets, ERROR_LOG_MAX_LINES } from '../util/errorlog.mjs';
import { checkUpdate, hasUpdate, parseVersion } from '../util/update.mjs';
import { runTuiToolkitTests } from './tui-toolkit.mjs';
import { runGuardTests } from './guards.mjs';
import { runLlmTests } from './llm.mjs';
import { runHighlightTests } from './highlight.mjs';
import { runMarkdownTests } from './markdown.mjs';
import { runProxyTests, startFetchFixtures } from './proxy.mjs';
import { runConfigTests } from './config.mjs';
import { runHttpGuardTests } from './http-guard.mjs';
import { runIgnoreTests } from './ignore.mjs';
import { runRulesTests } from './rules.mjs';
import { runRipgrepTests } from './ripgrep.mjs';
import { runPromptCacheTests } from './prompt-cache.mjs';
import { runSubagentTests } from './subagents.mjs';
import { runHooksTests } from './hooks.mjs';
import { runCheckpointTests } from './checkpoint.mjs';
import { runTuiComponentTests } from './tui-components.mjs';
import { runPickTests } from './pick.mjs';
import { runSkillsTests } from './skills.mjs';
import { runApiShapesTests } from './api-shapes.mjs';
import { runTitleTests } from './title.mjs';
import { runGoalTests } from './goal.mjs';
import { completePrefix, SideSession } from '../util/agent/side-session.mjs';
import { TurnQueue, newOpId } from '../util/agent/queue.mjs';
import { JobStore, JobValidationError, computeNextRunAt } from '../util/jobs/store.mjs';
import { JobScheduler, MISSED_GRACE_MS, acquireOwnerLock } from '../util/jobs/schedule.mjs';
import { parseCron, nextCronRun, isValidCron } from '../util/jobs/cron-expr.mjs';
import { createCronRuntime } from '../util/agent/cron-tool.mjs';
import { formatJobLines, parseCronArg, parseScheduleText, pickJob } from '../util/agent/cron-cmd.mjs';
import { parseQueueArg, formatQueueLines, pickQueueItem } from '../util/agent/queue-cmd.mjs';
import { runComputer, createComputerRuntime } from '../util/agent/computer.mjs';
import { searchWorkspaceFiles } from '../util/agent/files.mjs';
import { readWorkspaceInfo, readGitBranch } from '../util/workspace.mjs';
import { TITLE_MAX_TOKENS } from '../util/agent/title-model.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_PORT = 18901;
const WEB_PORT = 18787;
const BASE = `http://127.0.0.1:${WEB_PORT}`;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.log(`  ✗ ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || '值不等'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
// 与 test/guards.mjs 同语义：EMOJI_RE 命中且不在白名单才算 emoji（❯ 等命令行惯例符号豁免）
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
const ALLOWED_GLYPHS = new Set(['✓', '✗', '❯', '←', '→', '↑', '↓', '▼', '·', '…', '—', '─', '│', '╭', '╮', '╰', '╯', '▶', '◀', '★']);
function hasEmoji(text) { for (const ch of text) if (EMOJI_RE.test(ch) && !ALLOWED_GLYPHS.has(ch)) return true; return false; }

async function chat(body) {
  const resp = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp;
}

async function readStream(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let text = '', think = '', usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = dec.decode(value, { stream: true });
    text += chunk;
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data: ') || line.slice(6).trim() === '[DONE]') continue;
      try {
        const j = JSON.parse(line.slice(6));
        const d = j.choices?.[0]?.delta;
        if (d?.reasoning_content) think += d.reasoning_content;
        if (j.usage) usage = j.usage;
      } catch {}
    }
  }
  return { raw: text, think, usage };
}

await runTuiToolkitTests(test, assert, eq);
await runLlmTests(test, assert, eq);
await runHighlightTests(test, assert, eq);
await runMarkdownTests(test, assert, eq);
await runProxyTests(test, assert, eq);
await runConfigTests(test, assert, eq);
await runHttpGuardTests(test, assert, eq);
await runIgnoreTests(test, assert, eq);
await runRulesTests(test, assert, eq);
await runRipgrepTests(test, assert, eq);
await runPromptCacheTests(test, assert, eq);
await runSubagentTests(test, assert, eq);
await runHooksTests(test, assert, eq);
await runCheckpointTests(test, assert, eq);
await runTuiComponentTests(test, assert, eq);
  await runPickTests(test, assert, eq);
  await runSkillsTests(test, assert, eq);
  await runApiShapesTests(test, assert, eq);
await runTitleTests(test, assert, eq);
await runGoalTests(test, assert, eq);
await runGuardTests(test, assert);

// ---------- 单元测试: 侧边对话（/btw） ----------
console.log('\n侧边对话单测');
await test('btw: completePrefix 截到最后一个无悬空工具调用的自洽点', () => {
  const full = [
    { t: 'user', text: '你好' },
    { t: 'assistant', text: '在的' },
    { t: 'tool_call', id: 'a', name: 'read_file', args: {} },
    { t: 'tool_result', id: 'a', ok: true, output: 'x' },
    { t: 'user', text: '继续' },
  ];
  eq(completePrefix(full).length, 5, '完整历史不截断');
  const cut = [
    { t: 'user', text: '跑个任务' },
    { t: 'tool_call', id: 'a', name: 'shell', args: {} },
    { t: 'tool_result', id: 'a', ok: true, output: 'ok' },
    { t: 'tool_call', id: 'b', name: 'shell', args: {} }, // 中断：没有结果
    { t: 'assistant', text: '半句话' },
  ];
  const kept = completePrefix(cut);
  eq(kept.length, 3, '未完成工具组及其后残骸整组剔除');
  eq(kept.at(-1).t, 'tool_result', '保留到最后一个完整结果');
  // 并行调用只完成其一：整轮不自洽（b 悬空），从前序边界截成空前缀——不以残缺形态进请求
  const par = [
    { t: 'tool_call', id: 'a', name: 'shell', args: {} },
    { t: 'tool_call', id: 'b', name: 'shell', args: {} },
    { t: 'tool_result', id: 'a', ok: true, output: 'ok' },
  ];
  eq(completePrefix(par).length, 0, '未全部完成的并行轮整轮剔除');
  // 正常收尾的轮次：工具结果之后的助手终稿也是自洽历史
  const tidy = [
    { t: 'user', text: '跑任务' },
    { t: 'tool_call', id: 'a', name: 'shell', args: {} },
    { t: 'tool_result', id: 'a', ok: true, output: 'ok' },
    { t: 'assistant', text: '完成了' },
  ];
  eq(completePrefix(tidy).length, 4, '正常收尾的轮次全文保留');
  eq(completePrefix([]).length, 0);
  eq(completePrefix(null).length, 0, '坏输入不炸');
});

await test('files: searchWorkspaceFiles 关键字匹配、跳过依赖目录且不越界', () => {
  const dir = mkdtempSync(join(tmpdir(), 'files-search-'));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(dir, 'alpha.txt'), 'x');
  writeFileSync(join(dir, 'sub', 'beta.log'), 'x');
  writeFileSync(join(dir, 'node_modules', 'pkg', 'index.js'), 'x');
  const hit = searchWorkspaceFiles(dir, 'alpha');
  eq(hit.join(','), 'alpha.txt', '应按文件名关键字命中');
  const nested = searchWorkspaceFiles(dir, 'beta');
  eq(nested.join(','), 'sub/beta.log', '应下钻子目录并返回相对路径');
  const all = searchWorkspaceFiles(dir, '');
  assert(all.includes('alpha.txt') && all.includes('sub/beta.log'), '空关键字列文件');
  assert(!all.some((f) => f.includes('node_modules')), '依赖目录必须跳过');
  // 坏工作目录不炸
  eq(searchWorkspaceFiles(join(dir, 'nope'), 'x').length, 0, '不存在目录返回空');
});

await test('workspace: git 分支直读 .git/HEAD，非 git 目录与坏路径说清原因', () => {
  const plain = mkdtempSync(join(tmpdir(), 'ws-plain-'));
  const info = readWorkspaceInfo(plain);
  eq(info.isGit, false, '无 .git 目录应判非 git');
  eq(info.branch, null, '非 git 目录无分支');
  eq(info.path, plain, '路径应原样 resolve');
  assert(info.home.length > 1, '应带回主目录供路径缩写');

  const repo = mkdtempSync(join(tmpdir(), 'ws-repo-'));
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/feature/port-zcode\n');
  const gitInfo = readWorkspaceInfo(repo);
  eq(gitInfo.isGit, true, '有 .git 目录应判 git');
  eq(gitInfo.branch, 'feature/port-zcode', '应解析 refs/heads/ 后的分支名');

  // detached HEAD：裸短 SHA
  writeFileSync(join(repo, '.git', 'HEAD'), '9f1c2ab3def\n');
  eq(readWorkspaceInfo(repo).branch, '9f1c2ab', 'detached HEAD 应取 7 位短 SHA');

  // worktree / submodule 形态：.git 是文件，gitdir 指向真实 git 目录
  const realGit = mkdtempSync(join(tmpdir(), 'wt-real-'));
  mkdirSync(join(realGit, 'worktrees', 'wt1'), { recursive: true });
  writeFileSync(join(realGit, 'worktrees', 'wt1', 'HEAD'), 'ref: refs/heads/main\n');
  const wt = mkdtempSync(join(tmpdir(), 'ws-wt-'));
  writeFileSync(join(wt, '.git'), `gitdir: ${join(realGit, 'worktrees', 'wt1')}\n`);
  eq(readWorkspaceInfo(wt).branch, 'main', 'worktree 的 .git 文件应跟一指到真实 HEAD');

  // 坏路径：说清原因，不抛裸栈
  for (const bad of ['', 'relative/path']) {
    let msg = '';
    try { readWorkspaceInfo(bad); } catch (e) { msg = e.message; }
    eq(msg, '工作目录应为绝对路径', `非绝对路径应拒绝：${JSON.stringify(bad)}`);
  }
  try { readWorkspaceInfo(join(plain, 'nope')); assert(false, '应抛错'); }
  catch (e) { assert(e.message.includes('工作目录不存在'), '不存在应说清原因'); }
  const f = join(plain, 'a.txt');
  writeFileSync(f, 'x');
  try { readWorkspaceInfo(f); assert(false, '应抛错'); }
  catch (e) { eq(e.message, `不是目录：${f}`, '文件路径应提示不是目录'); }

  eq(readGitBranch(plain).isGit, false, '纯函数入口同样可用');
});

await test('btw: SideSession 内存门面——继承快照、不进列表、不派发子代理', () => {
  const main = { id: 's1', name: '主会话', model: 'm', provider: 'p', harness: 'standard', workspace: '/tmp', turns: 7, inputTokens: 100, rules: [] };
  const side = new SideSession(main, { prefix: [{ t: 'user', text: '历史' }] });
  assert(side.id.startsWith('btw-'), '侧边 id 带 btw_ 前缀');
  eq(side.meta.name, '侧边对话');
  eq(side.meta.turns, 0, '轮次计数不继承');
  eq(side.meta.inputTokens, 0, '用量汇总不继承');
  eq(side.meta.workspace, '/tmp', '工作目录继承');
  eq(side.records(side.id).length, 1, '历史前缀在场');
  side.append(side.id, { t: 'user', text: '新问题' });
  eq(side.records(side.id).length, 2, 'append 进内存');
  eq(side.records(side.id).length, 2, 'records 返回浅拷贝（loop 会 push）');
  eq(side.list().length, 0, '不进会话列表');
  let err = null;
  try { side.create({ name: 'x' }); } catch (e) { err = e; }
  assert(err && err.message.includes('不派发子代理'), '侧边对话禁派子代理');
});

// ---------- 单元测试: SseParser ----------
console.log('\nSseParser 单元测试');
await test('解析基本事件', () => {
  const p = new SseParser();
  const evs = p.feed('data: {"a":1}\n\ndata: {"b":2}\n\n');
  eq(evs.length, 2);
  eq(evs[0].data, '{"a":1}');
});
await test('容忍 CRLF 换行', () => {
  const p = new SseParser();
  const evs = p.feed('data: hello\r\n\r\n');
  eq(evs.length, 1); eq(evs[0].data, 'hello');
});
await test('多行 data 用 \\n 连接', () => {
  const p = new SseParser();
  const evs = p.feed('data: line1\ndata: line2\n\n');
  eq(evs[0].data, 'line1\nline2');
});
await test('跳过注释/心跳行', () => {
  const p = new SseParser();
  const evs = p.feed(': heartbeat\n\ndata: real\n\n');
  eq(evs.length, 1); eq(evs[0].data, 'real');
});
await test('跨 chunk 边界的事件不丢也不提前吐', () => {
  const p = new SseParser();
  assert(p.feed('data: {"par').length === 0, '残尾被提前吐出');
  const evs = p.feed('tial":true}\n\n');
  eq(evs.length, 1); eq(evs[0].data, '{"partial":true}');
});
await test('流尾无空行时 end() 能拿到最后事件', () => {
  const p = new SseParser();
  assert(p.feed('data: tail').length === 0, 'feed 不应提前吐残尾');
  const evs = p.end();
  eq(evs.length, 1); eq(evs[0].data, 'tail');
});
await test('estimateTokens 基本行为', () => {
  eq(estimateTokens(''), 0);
  assert(estimateTokens('12345678') >= 1 && estimateTokens('12345678') <= 3);
});

// ---------- 单元测试: 自定义 Provider ----------
console.log('\n自定义 Provider 单元测试');
await test('parseCapacity 支持 K/M 后缀并拒绝非法值', () => {
  eq(parseCapacity(''), undefined);
  eq(parseCapacity('  131072 '), 131072);
  eq(parseCapacity('256K'), 256000);
  eq(parseCapacity('1M'), 1000000);
  assert(Number.isNaN(parseCapacity('12x')), '非法后缀应返回 NaN');
  assert(Number.isNaN(parseCapacity('abc')), '非数字应返回 NaN');
});
await test('formatCapacity 写回最短形态', () => {
  eq(formatCapacity(256000), '256K');
  eq(formatCapacity(1000000), '1M');
  eq(formatCapacity(131072), '131072');
});
await test('normalizeEndpoint 只放行 HTTP/HTTPS 并去掉末尾斜杠', () => {
  eq(normalizeEndpoint(' https://api.example.com/v1/ ').url, 'https://api.example.com/v1');
  assert(!normalizeEndpoint('api.example.com/v1').ok, '缺少协议头应被拒绝');
  assert(!normalizeEndpoint('ftp://api.example.com').ok, '非 HTTP 协议应被拒绝');
  assert(!normalizeEndpoint('').ok, '空地址应被拒绝');
  assert(normalizeEndpoint('http://localhost:11434/v1').ok, 'localhost 应合法');
});
await test('validateProviderDraft 拒绝重名 ID、坏端点与空模型目录', () => {
  const r = validateProviderDraft({ id: 'longcat', name: 'x', protocol: 'openai', baseUrl: 'https://a.com', models: [{ id: 'm' }] }, ['longcat']);
  assert(!r.ok && r.errors.id, '内置 ID 应被拒绝');
  const dup = validateProviderDraft({ id: 'mine', name: 'x', protocol: 'openai', baseUrl: 'https://a.com', models: [{ id: 'm' }] }, ['mine']);
  assert(!dup.ok && dup.errors.id.includes('已有提供方'), '重名应被拒绝');
  const noModel = validateProviderDraft({ id: 'mine', name: 'x', protocol: 'openai', baseUrl: 'https://a.com', models: [] });
  assert(!noModel.ok && noModel.errors.models.includes('至少需要一个模型'), '空目录应被拒绝');
  const dupModel = validateProviderDraft({ id: 'mine', name: 'x', protocol: 'openai', baseUrl: 'https://a.com', models: [{ id: 'm' }, { id: 'm' }] });
  assert(!dupModel.ok && dupModel.errors.models.includes('重复'), '重复模型 ID 应被拒绝');
  const badCap = validateProviderDraft({ id: 'mine', name: 'x', protocol: 'openai', baseUrl: 'https://a.com', models: [{ id: 'm', contextWindow: 'abc' }] });
  assert(!badCap.ok && badCap.errors.models.includes('上下文窗口'), '非法容量应被拒绝');
  const badProto = validateProviderDraft({ id: 'mine', name: 'x', protocol: 'grpc', baseUrl: 'https://a.com', models: [{ id: 'm' }] });
  assert(!badProto.ok && badProto.errors.protocol, '未知协议应被拒绝');
});
await test('validateProviderDraft 接受合法草稿并剥离空行', () => {
  const r = validateProviderDraft({
    id: 'my-gw', name: '我的网关', protocol: 'anthropic', baseUrl: 'https://gw.example.com/v1/',
    models: [{ id: 'm-1', name: '模型一', contextWindow: '128K', maxTokens: '8K' }, { id: '' }, { id: 'm-2' }],
  });
  assert(r.ok, '合法草稿应通过: ' + JSON.stringify(r.errors));
  eq(r.value.models.length, 2, '空行应被剥离');
  eq(r.value.models[0].contextWindow, 128000);
  eq(r.value.models[0].maxTokens, 8000);
  eq(r.value.baseUrl, 'https://gw.example.com/v1', '末尾斜杠应被去掉');
  assert(!('apiKey' in r.value), '空 Key 不应进草稿');
});
await test('validateProviderDraft 校验 API 密钥格式（与 dsh 同规约）', () => {
  const base = { id: 'my-gw', name: '网关', protocol: 'openai', baseUrl: 'https://a.com', models: [{ id: 'm' }] };
  const legal = validateProviderDraft({ ...base, apiKey: 'sk-Ab3!~x-9' });
  assert(legal.ok, '可见 ASCII 密钥应通过: ' + JSON.stringify(legal.errors));
  eq(legal.value.apiKey, 'sk-Ab3!~x-9');
  const blank = validateProviderDraft({ ...base, apiKey: '   ' });
  eq(blank.ok, false);
  eq(blank.errors.apiKey !== undefined, true, '全空格应定位到 apiKey');
  const envLine = validateProviderDraft({ ...base, apiKey: 'MY_KEY=sk-123' });
  eq(envLine.ok, false);
  eq(envLine.errors.apiKey !== undefined, true, 'NAME=value 环境变量行应定位到 apiKey');
  const quoted = validateProviderDraft({ ...base, apiKey: '"sk-123"' });
  eq(quoted.ok, false);
  eq(quoted.errors.apiKey !== undefined, true, '成对引号应定位到 apiKey');
  const spaced = validateProviderDraft({ ...base, apiKey: 'sk 123' });
  eq(spaced.ok, false);
  eq(spaced.errors.apiKey !== undefined, true, '含空格应定位到 apiKey');
  const nonAscii = validateProviderDraft({ ...base, apiKey: 'sk-密钥' });
  eq(nonAscii.ok, false);
  eq(nonAscii.errors.apiKey !== undefined, true, '非 ASCII 应定位到 apiKey');
});
await test('validateProviderDraft 校验计费单价：只填一侧也接受，非法值定位到 price.<side>', () => {
  const base = { id: 'my-gw', name: '网关', protocol: 'openai', baseUrl: 'https://a.com', models: [{ id: 'm' }] };
  const oneSide = validateProviderDraft({ ...base, price: { input: 2 } });
  assert(oneSide.ok, '只填输入单价应通过: ' + JSON.stringify(oneSide.errors));
  eq(oneSide.value.price.input, 2);
  assert(!('output' in oneSide.value.price), '没填的一侧不应凭空出现');
  const cleared = validateProviderDraft({ ...base, price: {} });
  assert(cleared.ok, '空对象应表示清空单价');
  eq(Object.keys(cleared.value.price).length, 0, '清空后不应残留单价');
  const negative = validateProviderDraft({ ...base, price: { input: -1 } });
  eq(negative.ok, false);
  eq(negative.errors['price.input'] !== undefined, true, '负数应定位到 price.input');
  const text = validateProviderDraft({ ...base, price: { output: 'abc' } });
  eq(text.ok, false);
  eq(text.errors['price.output'] !== undefined, true, '非数字应定位到 price.output');
});
await test('ProviderStore 增删改查并落盘 providers.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-test-prov-'));
  try {
    const store = new ProviderStore(dir, { baseUrl: 'https://api.longcat.chat/openai/v1', apiKey: 'ak-builtin', model: 'LongCat-2.5-Preview' });
    store.create({ id: 'my-gw', name: '我的网关', protocol: 'openai', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-secret', models: [{ id: 'm-1' }] });
    const again = new ProviderStore(dir, { baseUrl: 'https://api.longcat.chat/openai/v1' });
    eq(again.all().length, 2, '重新加载后应保留自定义提供方');
    eq(again.get('my-gw').apiKey, 'sk-secret', 'Key 应持久化');
    again.update('my-gw', { name: '改名后的网关' });
    eq(new ProviderStore(dir, {}).get('my-gw').name, '改名后的网关');
    again.remove('my-gw');
    eq(new ProviderStore(dir, {}).all().length, 1, '删除后只剩内置');
    assert(existsSync(join(dir, 'providers.json')), '应落盘 providers.json');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await test('ProviderStore 对外列表脱敏，且内置提供方只读', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-test-prov-'));
  try {
    const store = new ProviderStore(dir, { baseUrl: 'https://api.longcat.chat/openai/v1', apiKey: 'ak-builtin', model: 'LongCat-2.5-Preview' });
    store.create({ id: 'my-gw', name: '我的网关', protocol: 'openai', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-secret', models: [{ id: 'm-1' }] });
    const pub = store.list();
    assert(!JSON.stringify(pub).includes('sk-secret'), '列表泄漏了 API Key');
    assert(!JSON.stringify(pub).includes('ak-builtin'), '列表泄漏了内置 Key');
    eq(pub[0].id, 'longcat');
    eq(pub[0].builtin, true);
    eq(pub[0].hasKey, true);
    eq(pub[1].hasKey, true);
    let msg = '';
    try { store.remove('longcat'); } catch (e) { msg = e.message; }
    assert(msg.includes('不能删除'), '内置提供方应不可删除');
    msg = '';
    try { store.update('longcat', { name: 'x' }); } catch (e) { msg = e.message; }
    assert(msg.includes('不能在此修改'), '内置提供方应不可修改');
    let err = null;
    try { store.create({ id: 'longcat', name: 'x', protocol: 'openai', baseUrl: 'https://a.com', models: [{ id: 'm' }] }); } catch (e) { err = e; }
    assert(err instanceof ProviderError && err.field === 'id', '创建同名内置 ID 应报字段级错误');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
await test('ProviderStore 按模型 ID 反查提供方，找不到回退内置', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-test-prov-'));
  try {
    const store = new ProviderStore(dir, { baseUrl: 'https://api.longcat.chat/openai/v1', apiKey: 'ak', model: 'LongCat-2.5-Preview' }, () => [{ id: 'LongCat-2.5-Preview' }]);
    store.create({ id: 'my-gw', name: '我的网关', protocol: 'openai', baseUrl: 'https://gw.example.com/v1', models: [{ id: 'gpt-9' }] });
    eq(store.providerForModel('gpt-9').id, 'my-gw');
    eq(store.providerForModel('LongCat-2.5-Preview').id, 'longcat');
    eq(store.providerForModel('不存在的模型').id, 'longcat', '未知模型应回退内置');
    eq(store.providerForModel('').id, 'longcat');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 单元测试: 提供方预设目录（迁移自 OBF #3186） ----------
console.log('\n提供方目录单元测试');
await test('catalog: 协议门控只放行已实现的两种协议', () => {
  const formats = new Set();
  for (const p of catalogProviders()) for (const e of p.endpoints) formats.add(e.format);
  assert(formats.has('openai') && formats.has('anthropic'), '目录应同时含两种已实现协议');
  const gemini = catalogProvider('gemini');
  const unsupported = gemini.endpoints.filter((e) => !e.supported);
  assert(unsupported.length > 0, 'gemini 格式端点应入数据但不激活');
  assert(unsupported.every((e) => !SUPPORTED_FORMATS.includes(e.format)), '未激活端点必须落在未实现协议上');
  const xiaomi = catalogProvider('xiaomi');
  assert(xiaomi.endpoints.some((e) => e.supported), '同家族至少有一条可激活端点');
  assert(xiaomi.endpoints.some((e) => !e.supported), 'responses 格式端点应入数据但不激活');
  assert(catalogPresetDraft('gemini', 'default') === null, '未实现协议的端点不给预设草稿');
  assert(catalogPresetDraft('xiaomi', 'responses') === null, 'responses 端点不给预设草稿');
  eq(catalogProvider('google'), null, 'Google 在本地目录里的 id 是 gemini');
});

await test('catalog: 每个激活端点落成独立预设（Token Plan 是独立 Key，不是双 Key 字段）', () => {
  const xiaomi = catalogProvider('xiaomi');
  const a = catalogPresetDraft('xiaomi', 'default');
  const b = catalogPresetDraft('xiaomi', 'token-plan');
  assert(a && b, '两条端点都应给出草稿');
  eq(a.protocol, 'openai', '端点协议随端点而非提供方');
  assert(a.baseUrl !== b.baseUrl, '两条预设 baseUrl 必须不同');
  assert(a.name !== b.name, '预设名要能区分端点');
  assert(b.models.length > 0 && b.models.every((m) => m.contextWindow === 300000), '预置模型默认 300K 上下文窗口（对齐 #3125）');
  // 草稿形状可直接进 validateProviderDraft
  const v = validateProviderDraft({ ...a, id: 'xiaomi-default', apiKey: 'sk-test' }, []);
  eq(v.ok, true, '目录草稿应能通过既有校验');
  eq(v.value.models.length, a.models.length, '模型数量一致');
  eq(v.value.models[0].contextWindow, 300000, '窗口值原样落库');
  // 每个激活端点都能独立过校验（id 冲突时调用方负责改名，这里用不同 id 验证形状）
  for (const e of xiaomi.endpoints.filter((x) => x.supported)) {
    const d = catalogPresetDraft('xiaomi', e.id);
    eq(validateProviderDraft({ ...d, id: `xiaomi-${e.id}`, apiKey: 'sk-test' }, []).ok, true, `端点 ${e.id} 的草稿应能过校验`);
  }
  assert(catalogPresetDraft('deepseek', 'anthropic').protocol === 'anthropic', 'Anthropic 端点落 anthropic 协议预设');
  eq(catalogPresetDraft('不存在的厂商', 'default'), null, '未知提供方返回 null');
});

await test('catalog: 三语标签回落 zh-CN → en → ID', () => {
  eq(catalogLabel({ 'zh-CN': '小米', 'en-US': 'Xiaomi' }), '小米', '首选 zh-CN');
  eq(catalogLabel({ 'en-US': 'Xiaomi' }), 'Xiaomi', '缺 zh-CN 回落 en');
  eq(catalogLabel({}, 'fallback-id'), 'fallback-id', '两者都缺回落传入 ID');
  eq(catalogLabel(null, 'x'), 'x', '非对象不抛');
  for (const p of catalogProviders()) {
    assert(p.name && p.name.length > 0, `提供方 ${p.id} 必须解析出名称`);
    for (const e of p.endpoints) assert(e.label && e.label.length > 0, `端点 ${p.id}/${e.id} 必须解析出标签`);
  }
});

await test('catalog: 剔除上游自家网关，数据完整可读', () => {
  const ids = catalogProviders().map((p) => p.id);
  assert(!ids.includes('openbitfun'), 'OBF 自家托管网关不进本地目录');
  assert(ids.length >= 10, '主流厂商应基本齐备');
  const raw = JSON.parse(readFileSync(join(__dirname, '..', 'util', 'provider-catalog.json'), 'utf8'));
  assert(!raw.providers.some((p) => p.id === 'openbitfun'), '数据文件本身也不含自家网关');
  const hasBindingKey = (o) => o && typeof o === 'object' && Object.keys(o).some((k) => k === 'reasoning_catalog_bindings' || hasBindingKey(o[k]));
  assert(!raw.providers.some((p) => hasBindingKey(p)), '推理目录绑定未迁（本地无此概念）');
  assert(raw.providers.every((p) => p.endpoints.every((e) => e.label && typeof e.label === 'object')), '每个端点都必须带三语标签');
});

// ---------- 单元测试: 上游线路拼装与帧翻译 ----------
console.log('\n上游线路单元测试');
await test('chatUrl/messagesUrl 按 pathPrefix 拼装', () => {
  eq(chatUrl({ baseUrl: 'https://a.com/v1' }), 'https://a.com/v1/chat/completions');
  eq(chatUrl({ baseUrl: 'https://a.com', pathPrefix: '/openai/v1' }), 'https://a.com/openai/v1/chat/completions');
  eq(modelsUrl({ baseUrl: 'https://a.com/v1' }), 'https://a.com/v1/models');
  eq(messagesUrl({ baseUrl: 'https://a.com/v1' }), 'https://a.com/v1/messages');
});
await test('buildChatRequest 按协议拼装地址、鉴权与载荷', () => {
  const oa = buildChatRequest({ protocol: 'openai', baseUrl: 'https://a.com/v1', apiKey: 'sk-1' },
    { model: 'm', messages: [{ role: 'user', content: 'hi' }], sendThinking: true, thinkingOn: false, maxTokens: 100, temperature: 0.5 });
  eq(oa.url, 'https://a.com/v1/chat/completions');
  eq(oa.headers.Authorization, 'Bearer sk-1');
  eq(oa.body.thinking.type, 'disabled');
  eq(oa.body.max_tokens, 100);
  eq(oa.body.temperature, 0.5);
  const noThink = buildChatRequest({ protocol: 'openai', baseUrl: 'https://a.com/v1', apiKey: '' },
    { model: 'm', messages: [], sendThinking: false });
  assert(!('thinking' in noThink.body), '未声明思考开关时不应发送该字段');
  assert(!('Authorization' in noThink.headers), '无 Key 时不应发送空 Authorization');
  const ant = buildChatRequest({ protocol: 'anthropic', baseUrl: 'https://a.com/v1', apiKey: 'sk-ant' },
    { model: 'm', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], maxTokens: 0 });
  eq(ant.url, 'https://a.com/v1/messages');
  eq(ant.headers['x-api-key'], 'sk-ant');
  eq(ant.headers['anthropic-version'], '2023-06-01');
  eq(ant.body.system, 'sys');
  eq(ant.body.messages.length, 1);
  eq(ant.body.max_tokens, 4096, '未声明容量时应给默认值');
});
await test('anthropicFrame 翻译文本、思考、用量与错误事件', () => {
  const f = (data) => anthropicFrame({ data: JSON.stringify(data) });
  eq(f({ type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } }).chunk.choices[0].delta.content, '你好');
  eq(f({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想' } }).chunk.choices[0].delta.reasoning_content, '想');
  eq(f({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }).usage.prompt_tokens, 3);
  eq(f({ type: 'message_delta', usage: { output_tokens: 9 } }).usage.completion_tokens, 9);
  const stop = f({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 9 } });
  eq(stop.chunk.choices[0].finish_reason, 'stop', 'end_turn 应映射为 OpenAI 词表 stop');
  const toolStop = f({ type: 'message_delta', delta: { stop_reason: 'tool_use' } });
  eq(toolStop.chunk.choices[0].finish_reason, 'tool_calls', 'tool_use 应映射为 tool_calls');
  const tuStart = f({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file' } });
  eq(tuStart.chunk.choices[0].delta.tool_calls[0].id, 'toolu_1', 'tool_use 开始应转出 id 与名称');
  const tuDelta = f({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } });
  eq(tuDelta.chunk.choices[0].delta.tool_calls[0].function.arguments, '{"a":1}', 'input_json_delta 应转出参数增量');
  const err = f({ type: 'error', error: { message: '过载' } });
  assert(err.chunk.choices[0].delta.content.includes('过载'), '错误事件应转成可见内容');
  eq(f({ type: 'ping' }), null);
  eq(f({ type: 'message_stop' }), null);
  eq(anthropicFrame({ data: 'not-json' }), null);
});

// ---------- 单元测试: LaTeX 公式分段 ----------
console.log('\nLaTeX 公式分段单元测试');
await test('splitMathSegments 识别五种公式分隔符', () => {
  const segs = splitMathSegments('行内 $x^2$ 与 \\(y\\) 混合');
  eq(segs.length, 5, '应切成 文本/公式/文本/公式/文本');
  eq(segs[0].text, '行内 ');
  eq(segs[1].kind, 'math'); eq(segs[1].tex, 'x^2'); eq(segs[1].raw, '$x^2$'); eq(segs[1].display, false);
  eq(segs[3].tex, 'y'); eq(segs[3].raw, '\\(y\\)'); eq(segs[3].display, false, '\\(\\) 是行内公式');
  const disp = splitMathSegments('显示 $$E=mc^2$$ 结束');
  eq(disp[1].display, true, '$$ 是显示公式');
  eq(disp[1].tex, 'E=mc^2');
  const bracket = splitMathSegments('显示 \\[ x = 1 \\] 结束');
  eq(bracket[1].display, true, '\\[\\] 是显示公式');
  eq(bracket[1].tex, 'x = 1');
  const bare = splitMathSegments('裸环境 \\begin{aligned} a&=b \\\\ c&=d \\end{aligned} 收尾');
  eq(bare[1].display, true, '裸数学环境按显示公式处理');
  eq(bare[1].tex, '\\begin{aligned} a&=b \\\\ c&=d \\end{aligned}', '裸环境的 TeX 保留环境包裹');
});
await test('反引号代码段里的 $ 不当公式', () => {
  const segs = splitMathSegments('代码 `$x$` 与 $$y$$');
  eq(segs[1].kind, 'code', '代码段应原样切出');
  eq(segs[1].text, '$x$');
  eq(segs[3].kind, 'math', '代码段之外照常识别');
});
await test('货币与区间写法不误判为公式', () => {
  for (const text of ['价格 $5 到 $10 之间', '区间 $100-$200 不成立', 'a $ b 空格', '只有一半 $abc']) {
    const segs = splitMathSegments(text);
    eq(segs.length, 1, `${text} 应整段按普通文本处理`);
    eq(segs[0].kind, 'text');
    eq(segs[0].text, text);
  }
  const esc = splitMathSegments('转义 \\$5 与 $x$');
  eq(esc.length, 2, '\\$ 是转义美元符，不应开启公式');
  eq(esc[0].text, '转义 \\$5 与 ');
  eq(esc[1].tex, 'x');
});
await test('分隔符未闭合时按普通文本，不吞后续内容', () => {
  const segs = splitMathSegments('未闭合 $abc 与 \\[ def');
  eq(segs.length, 1);
  eq(segs[0].text, '未闭合 $abc 与 \\[ def');
  eq(takeDisplayMath(['$$', 'a+b'], 0), null, '未闭合的显示公式块返回 null，交回普通段落');
});
await test('takeDisplayMath 吃掉跨行显示公式块', () => {
  const block = (lines) => takeDisplayMath(lines, 0);
  eq(block(['$$', 'a+b', '$$', '后']).tex, 'a+b');
  eq(block(['$$', 'a+b', '$$', '后']).raw, '$$\na+b\n$$');
  eq(block(['$$', 'a+b', '$$', '后']).next, 3, '吃块后应从闭合行之后继续');
  eq(block(['\\[ x = 1 \\]', '后']).tex, 'x = 1');
  eq(block(['\\[ x = 1 \\]', '后']).next, 1, '同行闭合只吃一行');
  eq(block(['\\begin{align}', 'a&=b', '\\end{align}', '后']).tex, '\\begin{align}\na&=b\n\\end{align}');
  eq(block(['\\begin{align}', 'a&=b', '\\end{align}', '后']).next, 3);
  eq(isDisplayMathStart('$$x'), true);
  eq(isDisplayMathStart('  \\begin{aligned}'), true, '行首空白不影响识别');
  eq(isDisplayMathStart('普通段落'), false);
});
await test('多行裸环境保留 \begin/\end 包裹（KaTeX 拒绝裸 &）', () => {
  const lines = ['\\begin{aligned}', 'f(x) &= (x+1)^2 \\\\', '&= x^2 + 2x + 1', '\\end{aligned}', '后'];
  const got = takeDisplayMath(lines, 0);
  eq(got.tex, lines.slice(0, 4).join('\n'), '多行环境的 TeX 必须自带环境包裹，否则 KaTeX 会拒绝裸 &');
  eq(got.next, 4);
});
await test('闭合行尾部还有正文时不丢字', () => {
  const got = takeDisplayMath(['$$x=1$$ 这句话应该保留', '下一段'], 0);
  eq(got.tex, 'x=1');
  eq(got.next, 0, '闭合行还有正文时应停在本行');
  eq(got.rest, ' 这句话应该保留');
  const noTail = takeDisplayMath(['$$x=1$$', '下一段'], 0);
  eq(noTail.next, 1, '无尾部正文时直接进入下一行');
  assert(!('rest' in noTail), '无尾部正文时不应带回 rest');
});

await test('行内公式含只准显示模式的环境时升格', () => {
  eq(mathDisplay('\\begin{align}a&=b\\end{align}', false), true, 'KaTeX 拒绝行内 align，需升格');
  eq(mathDisplay('x^2', false), false);
  assert(MATH_ENVIRONMENTS.has('pmatrix') && MATH_ENVIRONMENTS.has('aligned'), '常见矩阵/对齐环境应在清单内');
});

// ---------- 单元测试: Agent 事件协议与 Harness ----------
console.log('\nAgent 核心单元测试');
await test('事件协议：类型白名单与 SSE 帧形状', () => {
  const frame = sseFrame('text_chunk', { sessionId: 's1', text: '你好' });
  assert(frame.startsWith('event: text_chunk\ndata: '), '帧应以 event 行打头');
  assert(frame.endsWith('\n\n'), '帧应以空行结尾');
  const data = JSON.parse(frame.slice(frame.indexOf('data: ') + 6));
  eq(data.type, 'text_chunk');
  eq(data.text, '你好');
  let threw = false;
  try { agentEvent('not_a_type'); } catch { threw = true; }
  assert(threw, '未知事件类型必须抛错，防止协议漂移');
});
await test('Harness：三档契约与未知 id 回退', () => {
  eq(HARNESSES.length, 3, 'v1 实现 Minimal / Standard / Ultimate');
  eq(getHarness('minimal').tools.length, 0, 'Minimal 不挂工具');
  eq(getHarness('ultimate').maxRounds > getHarness('standard').maxRounds, true, 'Ultimate 轮次上限更高');
  eq(getHarness('standard').tools.includes('task'), true, 'Standard 应挂 task（提示要求派发子代理）');
  eq(getHarness('ultimate').tools.includes('task'), true, 'Ultimate 应挂 task（提示要求派发子代理）');
  eq(getHarness('minimal').tools.includes('task'), false, 'Minimal 不挂 task');
  eq(getHarness('nope').id, 'standard', '未知 id 回退 standard');
  const ids = harnessSummaries().map((h) => h.id);
  eq(ids.join(','), 'minimal,standard,ultimate');
  for (const h of HARNESSES) {
    assert(h.systemPrompt.length > 10, `${h.id} 必须有系统提示`);
    assert(!/\p{Extended_Pictographic}/u.test(h.systemPrompt + h.summary + h.label), 'Harness 文案零 emoji');
  }
});

await test('会话存储：创建 / 追加 / 投影 / 更新 / 删除', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mt-session-'));
  try {
    const store = new SessionStore(dir);
    const s = store.create({ model: 'm1', harness: 'standard' });
    assert(s.id && s.name === '新会话', '创建应带默认名');
    eq(s.workspace, join(dir, 'workspace'), '工作目录缺省在数据目录下');
    eq(store.list().length, 1);
    store.append(s.id, { t: 'user', text: '你好' });
    store.append(s.id, { t: 'assistant', text: '你好！' });
    appendFileSync(join(dir, 'sessions', `${s.id}.jsonl`), '{坏行\n');
    store.append(s.id, { t: 'tool_call', id: 'tc1', name: 'read_file', args: { path: 'a.txt' } });
    const got = store.get(s.id);
    eq(got.records.length, 3, '坏行应被跳过，有效记录 3 条');
    eq(got.records[0].t, 'user');
    assert(got.records[0].at, '记录应带时间戳');
    const patched = store.patch(s.id, { name: '改名', turns: 1, cost: 0.01 });
    eq(patched.name, '改名');
    eq(store.get(s.id).meta.cost, 0.01, '用量累计应落元信息');
    eq(store.remove(s.id), true);
    eq(store.get(s.id), null, '删除后读不到');
    eq(store.remove('不存在'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

await test('工具集：路径禁锢与读写编辑', () => {
  const ws = mkdtempSync(join(tmpdir(), 'mt-ws-'));
  const ctx = { workspace: ws };
  try {
    let threw = false;
    try { resolveInside(ws, '../outside.txt'); } catch (e) { threw = e.code === 'path_escape'; }
    assert(threw, '.. 穿越必须被拒');
    threw = false;
    try { resolveInside(ws, '/etc/passwd'); } catch (e) { threw = e.code === 'path_escape'; }
    assert(threw, '工作目录外的绝对路径必须被拒');
    eq(resolveInside(ws, 'a/b.txt'), join(ws, 'a/b.txt'));

    writeFileSync(join(ws, 'a.txt'), '第一行\n第二行\n第三行\n');
    const read = getTool('read_file').run({ path: 'a.txt', limit: 2 }, ctx);
    assert(read.includes('共 3 行'), '应报告总行数');
    assert(read.includes('第一行') && !read.includes('第三行'), 'limit 应生效');
    assert(getTool('read_file').run({ path: 'a.txt', offset: 3 }, ctx).includes('第三行'), 'offset 应生效');

    mkdirSync(join(ws, 'sub'));
    const ls = getTool('list_dir').run({}, ctx);
    assert(ls.includes('sub/') && ls.includes('a.txt'), '目录应带 / 后缀');

    getTool('write_file').run({ path: 'deep/dir/b.txt', content: '内容' }, ctx);
    eq(readFileSync(join(ws, 'deep/dir/b.txt'), 'utf8'), '内容', 'write_file 应建父目录并写入');

    getTool('edit_file').run({ path: 'a.txt', old_string: '第二行', new_string: '第二行改' }, ctx);
    assert(readFileSync(join(ws, 'a.txt'), 'utf8').includes('第二行改'), 'edit_file 应精确替换');
    threw = false;
    try { getTool('edit_file').run({ path: 'a.txt', old_string: '不存在', new_string: 'x' }, ctx); } catch (e) { threw = e.code === 'no_match'; }
    assert(threw, '未命中应报 no_match');
    writeFileSync(join(ws, 'dup.txt'), 'x\nx\n');
    threw = false;
    try { getTool('edit_file').run({ path: 'dup.txt', old_string: 'x', new_string: 'y' }, ctx); } catch (e) { threw = e.code === 'not_unique'; }
    assert(threw, '多处命中且未设 replace_all 应报 not_unique');
    getTool('edit_file').run({ path: 'dup.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx);
    eq(readFileSync(join(ws, 'dup.txt'), 'utf8'), 'y\ny\n', 'replace_all 应替换全部');
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

await test('工具集：shell 执行、退出码与超时终止', async () => {
  const ws = mkdtempSync(join(tmpdir(), 'mt-sh-'));
  const ctx = { workspace: ws };
  try {
    const ok = await getTool('shell').run({ command: 'echo 你好' }, ctx);
    assert(ok.includes('退出码: 0') && ok.includes('你好'), 'echo 应成功');
    const bad = await getTool('shell').run({ command: 'exit 3' }, ctx);
    assert(bad.includes('退出码: 3'), '退出码应透传');
    const slow = await getTool('shell').run({ command: 'sleep 8', timeout_seconds: 5 }, ctx);
    assert(slow.includes('已超时终止'), '超时应终止并标注');
    threwCheck: {
      let threw = false;
      try { await getTool('web_fetch').run({ url: 'ftp://x' }, ctx); } catch (e) { threw = e.code === 'bad_args'; }
      assert(threw, '非 http(s) URL 必须拒绝');
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

await test('工具 schema：OpenAI 与 Anthropic 两种形状', () => {
  const names = ['read_file', 'shell'];
  const oa = toolSchemas(names);
  eq(oa.length, 2);
  eq(oa[0].type, 'function');
  eq(oa[0].function.parameters.type, 'object');
  const an = anthropicToolSchemas(names);
  assert(an[0].input_schema && !('parameters' in an[0]), 'Anthropic 用 input_schema');
  eq(toolResource('shell', { command: 'ls' }), 'ls', 'shell 资源取命令');
  eq(toolResource('read_file', { path: 'a.txt' }), 'a.txt', '文件类资源取路径');
});

await test('检索工具：grep / glob 真实查找与预算截断', async () => {
  const wsRoot = mkdtempSync(join(tmpdir(), 'aurora-search-'));
  const ws = join(wsRoot, 'workspace');
  mkdirSync(join(ws, 'src', 'deep'), { recursive: true });
  writeFileSync(join(ws, 'src', 'a.mjs'), 'const NEEDLE = 1;\nconsole.log(NEEDLE);\n');
  writeFileSync(join(ws, 'src', 'deep', 'b.mjs'), '// 无关文件\n');
  writeFileSync(join(ws, 'notes.txt'), 'NEEDLE 在文本里\n');
  const grep = getTool('grep');
  const hit = await grep.run({ pattern: 'NEEDLE' }, { workspace: ws });
  assert(hit.includes('src/a.mjs:1') && hit.includes('src/a.mjs:2') && hit.includes('notes.txt:1'), '应带 文件:行号 且跨目录');
  assert(!hit.includes('b.mjs'), '不含匹配的文件不该出现');
  const filtered = await grep.run({ pattern: 'NEEDLE', glob: '*.txt' }, { workspace: ws });
  assert(filtered.includes('notes.txt') && !filtered.includes('a.mjs'), 'glob 过滤应按文件名生效');
  const capped = await grep.run({ pattern: 'NEEDLE', max_results: 1 }, { workspace: ws });
  assert(capped.includes('已达上限 1 条'), '预算上限应有提示');
  const none = await grep.run({ pattern: '绝对不存在XYZ' }, { workspace: ws });
  assert(none.includes('未匹配到'), '无匹配给明确空态');
  let threw = false;
  try { await grep.run({ pattern: '([' }, { workspace: ws }); } catch (e) { threw = e.code === 'bad_args'; }
  assert(threw, '非法正则应报 bad_args');
  const glob = getTool('glob');
  const found = await glob.run({ pattern: '**/*.mjs' }, { workspace: ws });
  assert(found.includes('src/a.mjs') && found.includes('src/deep/b.mjs'), 'glob 应跨目录');
  assert(!found.includes('notes.txt'), 'glob 应按扩展名过滤');
  const named = await glob.run({ pattern: 'notes.txt' }, { workspace: ws });
  assert(named.includes('notes.txt'), '无斜杠模式匹配 basename');
  let escaped = false;
  try { await glob.run({ pattern: 'passwd', path: '../../..' }, { workspace: ws }); } catch (e) { escaped = e.code === 'path_escape'; }
  assert(escaped, 'glob 起点应受路径禁锢');
  let escaped2 = false;
  try { await grep.run({ pattern: 'root', path: '/etc' }, { workspace: ws }); } catch (e) { escaped2 = e.code === 'path_escape'; }
  assert(escaped2, 'grep 起点应受路径禁锢');
  rmSync(wsRoot, { recursive: true, force: true });
});

await test('todo 工具：增删完成与状态机', () => {
  const store = { list: [], get() { return this.list; }, set(n) { this.list = n; } };
  const todo = getTool('todo');
  const r1 = todo.run({ action: 'add', item: '读文件' }, { todoStore: store });
  assert(r1.output.includes('0/1') && r1.extra.todos.length === 1, 'add 后进清单');
  todo.run({ action: 'add', item: '改代码' }, { todoStore: store });
  const r3 = todo.run({ action: 'done', item: '1' }, { todoStore: store });
  assert(r3.output.includes('1/2') && r3.extra.todos[0].done, 'done 按序号生效');
  const r4 = todo.run({ action: 'remove', item: '2' }, { todoStore: store });
  eq(r4.extra.todos.length, 1, 'remove 按序号删除');
  eq(todo.run({ action: 'list' }, { todoStore: store }), renderTodoList(store.get()), 'list 返回渲染文本');
  for (const bad of [{ action: 'done', item: '9' }, { action: 'add' }, { action: 'boom' }]) {
    let threw = false;
    try { todo.run(bad, { todoStore: store }); } catch (e) { threw = e.code === 'bad_args'; }
    assert(threw, `非法参数应拒绝: ${JSON.stringify(bad)}`);
  }
  let noCtx = false;
  try { todo.run({ action: 'list' }, {}); } catch (e) { noCtx = e.code === 'no_ctx'; }
  assert(noCtx, '缺会话上下文应拒绝');
});

await test('edit_file：diff 结构化 extra 与紧凑文本', () => {
  const d = lineDiff('a\nb\nc\n', 'a\nB\nc\n');
  eq(d.filter((x) => x.type === 'del').length, 1);
  eq(d.filter((x) => x.type === 'add').length, 1);
  assert(d.some((x) => x.type === 'context'), '应带上下行');
  const text = diffToText(d);
  assert(text.includes('-    2  b') && text.includes('+    2  B'), '紧凑文本带 +/- 标记与行号');
  assert(diffToText([]).includes('无变化'), '空 diff 有空态');
});

await test('skill 工具：schema 形状与默认免确认', () => {
  const oa = toolSchemas(['skill']);
  eq(oa.length, 1);
  eq(oa[0].function.name, 'skill');
  eq(oa[0].function.parameters.required[0], 'name');
  const an = anthropicToolSchemas(['skill']);
  eq(an[0].name, 'skill');
  assert(an[0].input_schema, 'Anthropic 形状用 input_schema');
  const p = new PermissionPolicy();
  eq(p.evaluate('skill', 'code-review'), 'allow', 'skill 只读默认放行');
  const tool = getTool('skill');
  const out = tool.run({ name: 'demo' }, { skills: [{ name: 'demo', body: 'B' }] });
  assert(out.includes('<skill_content name="demo">') && out.includes('B'), 'run 返回技能正文（结构化包裹）');
  const again = tool.run({ name: 'demo' }, { skills: [{ name: 'demo', body: 'B' }], skillsLoaded: new Set(['demo']) });
  assert(again.includes('已在本轮加载过') && !again.includes('<skill_content'), '重复激活只回短回执');
  let threw = false;
  try { tool.run({ name: 'x' }, { skills: [] }); } catch { threw = true; }
  assert(threw, '未知技能应抛 ToolError');
});

await test('权限策略：默认姿态、后匹配赢与总是允许', () => {
  const p = new PermissionPolicy();
  eq(p.evaluate('read_file', 'a.txt'), 'allow', '只读默认放行');
  eq(p.evaluate('shell', 'rm -rf x'), 'ask', 'shell 默认要问');
  eq(p.evaluate('未知工具', 'x'), 'ask', '未命中默认 ask（安全侧）');
  p.grantAlways('shell', 'echo hi');
  eq(p.evaluate('shell', 'echo hi'), 'allow', '总是允许应精确生效');
  eq(p.evaluate('shell', 'echo bye'), 'ask', '总是允许不应外溢');
  const p2 = new PermissionPolicy([...defaultRules(), { action: 'shell', resource: 'rm *', effect: 'deny' }]);
  eq(p2.evaluate('shell', 'rm -rf /'), 'deny', '后匹配的 deny 应赢');
  eq(mostRestrictive('allow', 'ask'), 'ask');
  eq(mostRestrictive('deny', 'allow'), 'deny');
});

await test('权限三档：permissionMode 设定 ask 类动作的默认效应', () => {
  const need = new PermissionPolicy(defaultRules(), { permissionMode: 'ask_when_needed' });
  eq(need.effective('read_file', 'a.txt'), 'allow', '缺省档只读放行');
  eq(need.effective('shell', 'ls'), 'ask', '缺省档 shell 仍要问');
  const never = new PermissionPolicy(defaultRules(), { permissionMode: 'never_ask' });
  eq(never.effective('shell', 'ls'), 'allow', 'never_ask 放行 ask 类');
  eq(never.effective('write_file', 'a.txt'), 'allow', 'never_ask 放行写文件');
  const neverDeny = new PermissionPolicy([...defaultRules(), { action: 'shell', resource: 'rm *', effect: 'deny' }], { permissionMode: 'never_ask' });
  eq(neverDeny.effective('shell', 'rm -rf /'), 'deny', 'never_ask 不推翻 deny');
  const always = new PermissionPolicy(defaultRules(), { permissionMode: 'always_ask' });
  eq(always.effective('read_file', 'a.txt'), 'ask', 'always_ask 只读也要问');
  eq(always.effective('shell', 'ls'), 'ask', 'always_ask 写执行照旧要问');
  always.grantAlways('read_file', 'a.txt');
  eq(always.effective('read_file', 'a.txt'), 'allow', '总是允许沉淀的会话规则不被 always_ask 推翻');
  eq(always.effective('read_file', 'b.txt'), 'ask', '总是允许不应外溢');
  const mcp = new PermissionPolicy(defaultRules());
  eq(mcp.effective('mcp__srv__echo', 'x'), 'ask', 'MCP 工具默认 ask（外部副作用需确认）');
  const mcpAllow = new PermissionPolicy([...defaultRules(), { action: 'mcp__*', resource: '*', effect: 'allow' }]);
  eq(mcpAllow.effective('mcp__srv__echo', 'x'), 'allow', 'mcp__* 前缀规则应放行整个 MCP 工具族');
  eq(mcpAllow.effective('shell', 'ls'), 'ask', '前缀规则不应外溢到内置工具');
  const bad = new PermissionPolicy(defaultRules(), { permissionMode: '乱写' });
  eq(bad.permissionMode, 'ask_when_needed', '非法档位回退缺省');
});

await test('线路拼装：tools 参数进入 OpenAI 与 Anthropic 两种形状', () => {
  const provider = { protocol: 'openai', baseUrl: 'https://x', apiKey: 'k' };
  const req = buildChatRequest(provider, { model: 'm', messages: [{ role: 'user', content: 'hi' }], toolNames: ['read_file', 'shell'] });
  eq(req.body.tools.length, 2);
  eq(req.body.tools[0].type, 'function');
  eq(req.body.tools[0].function.name, 'read_file');
  eq(req.body.tool_choice, 'auto');
  const anProvider = { protocol: 'anthropic', baseUrl: 'https://x', apiKey: 'k' };
  const anReq = buildChatRequest(anProvider, { model: 'm', messages: [{ role: 'user', content: 'hi' }], toolNames: ['read_file'] });
  assert(anReq.body.tools[0].input_schema, 'Anthropic tools 用 input_schema');
  const messages = [
    { role: 'user', content: '读文件' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '1  内容' },
    { role: 'tool', tool_call_id: 'call_2', content: '2  内容2' },
  ];
  const anReq2 = buildChatRequest(anProvider, { model: 'm', messages });
  const turns = anReq2.body.messages;
  const asst = turns.find((t) => t.role === 'assistant');
  eq(asst.content[0].type, 'tool_use', 'assistant.tool_calls 应翻成 tool_use 块');
  eq(asst.content[0].input.path, 'a.txt', 'arguments JSON 应解析进 input');
  const toolTurn = turns.filter((t) => Array.isArray(t.content) && t.content.some((b) => b.type === 'tool_result'));
  eq(toolTurn.length, 1, '连续 tool 结果应合并进同一条 user 消息');
  eq(toolTurn[0].content.length, 2, '两个 tool_result 块');
});

await test('Agent 流读取：文本 / 思考 / 工具调用增量累积', async () => {
  const frames = [
    { choices: [{ index: 0, delta: { reasoning_content: '想' } }] },
    { choices: [{ index: 0, delta: { content: '答' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 5, completion_tokens: 6 } },
  ];
  const enc = new TextEncoder();
  const chunks = frames.map((f) => enc.encode(`data: ${JSON.stringify(f)}\n\n`));
  chunks.push(enc.encode('data: [DONE]\n\n'));
  let i = 0;
  const reader = { read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }), cancel: async () => {} };
  const entry = { controller: new AbortController(), usage: null };
  let text = '', think = '', deltas = 0;
  const out = await consumeAgentStream(reader, entry, {
    onText: (t) => { text += t; },
    onThinking: (t) => { think += t; },
    onToolCallDelta: () => { deltas++; },
  });
  eq(text, '答');
  eq(think, '想');
  eq(out.toolCalls.length, 1, '应汇出 1 个工具调用');
  eq(out.toolCalls[0].name, 'read_file');
  eq(out.toolCalls[0].arguments, '{"path":"a.txt"}', '参数增量应完整拼接');
  eq(out.toolCalls[0].id, 'c1');
  eq(out.finishReason, 'tool_calls');
  eq(deltas, 2, '两次参数增量都应通知 UI');
  eq(entry.usage.prompt_tokens, 5, '用量应累积到 entry');
});

await test('上下文组装：记录投影为上游消息', () => {
  const records = [
    { t: 'user', text: '你好' },
    { t: 'thinking', text: '内部思考' },
    { t: 'assistant', text: '你好！' },
    { t: 'user', text: '读文件' },
    { t: 'tool_call', id: 'tc1', name: 'read_file', args: { path: 'a.txt' } },
    { t: 'tool_result', id: 'tc1', output: '1  内容' },
    { t: 'usage', inputTokens: 10, outputTokens: 5 },
  ];
  const msgs = assembleMessages({ harness: getHarness('standard'), workspace: '/tmp/ws', records });
  // 系统提示拆成两条：稳定段（harness 提示 / 工作目录 / 规则 / 技能清单）与易变尾（当前时间 /
  // 本轮追加指令）——前者是提示缓存的断点落点（util/wire.mjs），时间戳因此不会每轮打废缓存
  eq(msgs[0].role, 'system');
  assert(msgs[0].content.includes('/tmp/ws'), '系统提示应带工作目录');
  assert(!msgs[0].content.includes('当前时间：'), '时间戳不在稳定段里（否则缓存每轮失效）');
  eq(msgs[1].role, 'system');
  assert(/^当前时间：\d{4}-/.test(msgs[1].content), '易变尾单独一条系统消息');
  eq(msgs[2].content, '你好');
  eq(msgs[3].content, '你好！');
  eq(msgs[4].content, '读文件');
  eq(msgs[5].role, 'assistant');
  eq(msgs[5].tool_calls[0].function.name, 'read_file');
  eq(msgs[6].role, 'tool');
  eq(msgs[6].tool_call_id, 'tc1');
  eq(msgs.length, 7, 'thinking 与 usage 不应进上下文');
  const withSummary = assembleMessages({ harness: getHarness('minimal'), workspace: '/tmp/ws', records: [{ t: 'summary', text: '摘要内容' }, { t: 'user', text: '继续' }] });
  assert(withSummary[2].content.includes('摘要内容'), 'summary 应投影为系统消息');
});

await test('上下文组装：悬空 tool_call 补合成结果（中断 / 派生边界）', () => {
  // 对齐 OpenBitFun v1.0.2 #3148：turn 在工具执行前被中止，转录留下没有配对结果的调用，
  // 直接投影会让消息序列以带 tool_calls 的 assistant 消息收尾，上游一律 400
  const cut = assembleMessages({ harness: getHarness('standard'), workspace: '/tmp/ws', records: [
    { t: 'user', text: '跑一下' },
    { t: 'tool_call', id: 'tc1', name: 'shell', args: { command: 'ls' } },
  ] });
  eq(cut.at(-1).role, 'tool', '悬空调用后必须补一条 tool 消息');
  eq(cut.at(-1).tool_call_id, 'tc1', '合成结果要指回原调用');
  assert(cut.at(-1).content.includes('中断'), '合成结果应说明工具未产生结果');
  // 正常配对不受影响：不能叠出第二条 tool 消息
  const paired = assembleMessages({ harness: getHarness('standard'), workspace: '/tmp/ws', records: [
    { t: 'user', text: '跑一下' },
    { t: 'tool_call', id: 'tc1', name: 'shell', args: { command: 'ls' } },
    { t: 'tool_result', id: 'tc1', ok: true, output: 'a.txt' },
  ] });
  eq(paired.filter((m) => m.role === 'tool').length, 1, '有真实结果时不补合成结果');
  eq(paired.at(-1).content, 'a.txt', '真实结果原样保留');
  // 无配对的结果（异常数据）仍按既有规则丢弃，协议保持合法
  const orphan = assembleMessages({ harness: getHarness('standard'), workspace: '/tmp/ws', records: [
    { t: 'tool_result', id: 'ghost', ok: true, output: 'x' },
  ] });
  eq(orphan.filter((m) => m.role !== 'system').length, 0, '孤儿 tool_result 应被丢弃（只剩系统消息）');
  // 并行调用里只有一个出结果：另一个补合成结果，两个都保留在 assistant.tool_calls 里
  const partial = assembleMessages({ harness: getHarness('standard'), workspace: '/tmp/ws', records: [
    { t: 'tool_call', id: 'c1', name: 'shell', args: {} },
    { t: 'tool_call', id: 'c2', name: 'shell', args: {} },
    { t: 'tool_result', id: 'c1', ok: true, output: 'ok' },
  ] });
  const partialAssistant = partial.find((m) => Array.isArray(m.tool_calls));
  eq(partialAssistant.tool_calls.length, 2, '两个调用都进 assistant.tool_calls');
  const partialTools = partial.filter((m) => m.role === 'tool');
  eq(partialTools.length, 2, '一个真实结果 + 一个合成结果');
  assert(partialTools.some((m) => m.content === 'ok'), '真实结果保留');
  assert(partialTools.some((m) => m.content.includes('中断')), '没结果的调用补合成结果');
});

await test('上下文组装：技能清单进系统提示、正文不进', () => {
  const skills = [{ name: 'demo', description: '演示技能', body: 'SECRET-BODY-不应出现' }];
  const msgs = assembleMessages({ harness: getHarness('standard'), workspace: '/tmp/ws', records: [], skills });
  assert(msgs[0].content.includes('- demo: 演示技能'), '系统提示应带技能清单');
  assert(!msgs[0].content.includes('SECRET-BODY'), '技能正文不进系统提示');
  const none = assembleMessages({ harness: getHarness('standard'), workspace: '/tmp/ws', records: [] });
  assert(!none[0].content.includes('可用技能'), '无技能时不出现清单块');
});

await test('上下文压缩：阈值判定与头尾切分', () => {
  const big = Array.from({ length: 400 }, () => ({ role: 'user', content: 'x'.repeat(400) }));
  eq(needsCompaction(big, { windowTokens: 1000, ratio: 0.7 }), true, '超阈值应压缩');
  eq(needsCompaction([{ role: 'user', content: '短' }], { windowTokens: 100000, ratio: 0.7 }), false, '未超不压缩');
  const records = [];
  for (let i = 0; i < 10; i++) {
    records.push({ t: 'user', text: `问题${i}` });
    records.push({ t: 'assistant', text: `回答${i}` });
  }
  eq(planCompaction(records, 10), null, '用户轮数不超过保留轮数时不压缩');
  const long = [];
  for (let i = 0; i < 12; i++) { long.push({ t: 'user', text: `问题${i}` }); long.push({ t: 'assistant', text: `回答${i}` }); }
  const plan = planCompaction(long, 4);
  assert(plan, '记录足够应给出计划');
  eq(plan.tail[0].text, '问题8', '应保留最近 4 个用户轮');
  assert(plan.head.length > 0 && plan.head.at(-1).text === '回答7', '头部应截止到保留区之前');
  const cm = compactionMessages(plan.head);
  eq(cm[0].role, 'system');
  assert(cm[1].content.includes('问题0'), '总结输入应含早期对话');
  // 技能规范免压缩：skill 工具结果与带 skill 标记的用户记录都完整进总结输入
  const skillBody = '技'.repeat(3000);
  const withSkill = compactionMessages([
    { t: 'user', text: `${skillBody}`, skill: 'code-review' },
    { t: 'tool_result', name: 'skill', ok: true, output: `${skillBody}` },
    { t: 'tool_result', name: 'read_file', ok: true, output: `${skillBody}` },
  ]);
  assert(withSkill[1].content.includes(skillBody), '技能正文完整进总结输入（不截断）');
  assert(withSkill[1].content.includes('[用户 /code-review 技能调用]'), '斜杠技能注入带标记');
  assert(withSkill[0].content.includes('原样延续'), '压缩系统提示要求延续技能规范');
  const plain = compactionMessages([{ t: 'tool_result', name: 'read_file', ok: true, output: `${skillBody}` }]);
  assert(!plain[1].content.includes(skillBody), '普通工具结果仍按上限截断');
  eq(contextWindowOf({}), 128000, '未声明窗口回退 128k');
  eq(contextWindowOf({ capacity: { contextWindow: 262144 } }), 262144, '应读取提供方声明窗口');
});

await test('上下文压缩：切点必须落在无悬空 tool_call 的边界', () => {
  // 第 2 个用户轮中间夹着一对未闭合的 tool_call：切在这里会把调用与结果劈成两半
  const records = [];
  for (let i = 0; i < 12; i++) {
    records.push({ t: 'user', text: `问题${i}` });
    if (i === 1) {
      records.push({ t: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } });
      records.push({ t: 'tool_result', id: 'c1', name: 'read_file', ok: true, output: 'x'.repeat(200000) });
    }
    records.push({ t: 'assistant', text: `回答${i}` });
  }
  const safe = safeCutPoints(records);
  const dangling = records.findIndex((r) => r.t === 'tool_call');
  eq(safe[dangling], true, '切在 tool_call 之前是安全的（调用整体归尾部）');
  eq(safe[dangling + 1], false, '调用已发出、结果未落地时不能切');
  eq(safe[dangling + 2], true, '结果落地之后恢复安全');
  const cut = findCutIndex(records, 4, { windowTokens: 100000, ratio: 0.7 });
  assert(cut >= 0, '应找到切点');
  const head = records.slice(0, cut);
  const headCalls = head.filter((r) => r.t === 'tool_call').map((r) => r.id);
  const headResults = new Set(head.filter((r) => r.t === 'tool_result').map((r) => r.id));
  assert(headCalls.every((id) => headResults.has(id)), '头部不允许留下悬空调用');
  // 悬空调用那一轮体量巨大：预算投影应把它整轮摘进头部，而不是留在尾部顶爆窗口
  assert(head.some((r) => r.t === 'tool_call'), '超预算的大轮应被摘进头部');
  assert(!records.slice(cut).some((r) => r.t === 'tool_call'), '尾部不应残留未闭合调用');
});

await test('上下文压缩：预算投影按尾部 token 定切点，太小则放弃', () => {
  const records = [];
  for (let i = 0; i < 12; i++) {
    records.push({ t: 'user', text: `问题${i}` });
    records.push({ t: 'assistant', text: '答'.repeat(400) });
  }
  const wide = findCutIndex(records, 4, { windowTokens: 1000000, ratio: 0.7 });
  assert(wide >= 0, '窗口宽裕时应按保留轮数切');
  eq(records[wide].text, '问题8', '宽裕时仍保留最近 4 个用户轮');
  const tiny = [{ t: 'user', text: 'a' }, { t: 'user', text: 'b' }];
  eq(findCutIndex(tiny, 4), -1, '用户轮不足时没有切点');
  // 每个用户轮都大到放不进预算：宁可放弃压缩也不硬切出超预算的半轮
  const fat = [];
  for (let i = 0; i < 12; i++) {
    fat.push({ t: 'user', text: `问题${i}` });
    fat.push({ t: 'assistant', text: '答'.repeat(60000) });
  }
  eq(findCutIndex(fat, 4, { windowTokens: 100000, ratio: 0.7 }), -1, '尾部超预算时放弃压缩');
  eq(findCutIndex(fat, 4, { windowTokens: 10000000, ratio: 0.7 }) >= 0, true, '窗口足够大时恢复可切');
});

await test('上下文压缩：被摘掉的工具工作聚成事实清单', () => {
  const head = [
    { t: 'tool_call', name: 'read_file', args: { path: 'src/a.ts' } },
    { t: 'tool_call', name: 'list_dir', args: { path: 'src' } },
    { t: 'tool_call', name: 'edit_file', args: { path: 'src/a.ts' } },
    { t: 'tool_call', name: 'write_file', args: { path: 'out/b.md' } },
    { t: 'tool_call', name: 'shell', args: { command: 'npm test' } },
    { t: 'tool_call', name: 'grep', args: { pattern: 'TODO' } },
    { t: 'tool_call', name: 'glob', args: { pattern: '**/*.ts' } },
    { t: 'tool_call', name: 'web_fetch', args: { url: 'https://example.test/x' } },
    { t: 'tool_call', name: 'task', args: { task: '跑一遍测试' } },
    { t: 'tool_call', name: 'skill', args: { name: 'code-review' } },
    { t: 'tool_call', name: 'todo', args: { items: [] } },
  ];
  const sum = droppedWorkSummary(head);
  assert(sum.includes('src/a.ts'), '读过的文件应列出');
  assert(sum.includes('out/b.md'), '改过的文件应列出');
  assert(sum.includes('npm test'), '跑过的命令应列出');
  assert(sum.includes('TODO'), '检索模式应列出');
  assert(sum.includes('example.test'), '抓取的链接应列出');
  assert(sum.includes('code-review'), '加载过的技能应列出');
  assert(!sum.includes('items'), '无事实可提取的工具不占位');
  eq(droppedWorkSummary([]), '', '空头部给空清单');
  const cm = compactionMessages(head);
  assert(cm[1].content.includes('工具工作清单'), '压缩输入应带上事实清单');
  assert(cm[0].content.includes('文件路径'), '压缩系统提示应显式要求列文件路径');
});

// ---------- 单元测试: Agent Loop ----------
console.log('\nMCP 客户端单元测试（mock stdio 服务器）');

await test('MCP 注册表：草稿校验与配置落盘', () => {
  const bad = validateServerDraft({ id: '坏 id', transport: 'stdio' });
  eq(bad.ok, false, '非法 ID 应拒绝');
  assert(bad.errors.id && bad.errors.command, '应定位到 id 与 command 字段');
  const badUrl = validateServerDraft({ id: 'web', transport: 'http', url: 'ftp://x' });
  eq(badUrl.ok, false, 'HTTP 传输应拒绝非 http(s) 端点');
  // 传输类型驼峰归一化（对齐 OpenBitFun v1.0.2 #3156）：粘贴来的 MCP 配置普遍写 streamableHttp
  for (const raw of ['http', 'streamableHttp', 'STREAMABLE-HTTP', 'streamable_http', 'sse']) {
    const r = validateServerDraft({ id: 'web', transport: raw, url: 'https://x/mcp' });
    eq(r.ok, true, `${raw} 应归一为 http 并通过校验`);
    eq(r.server.transport, 'http', `${raw} 应落到 http`);
  }
  eq(validateServerDraft({ id: 'web', transport: 'stdio', command: 'node' }).server.transport, 'stdio', 'stdio 保持 stdio');
  const weird = validateServerDraft({ id: 'web', transport: 'grpc', url: 'https://x/mcp' });
  eq(weird.ok, false, '无法识别的传输类型应拒绝');
  assert(weird.errors.transport && weird.errors.transport.includes('无法识别'), '应报「传输类型无法识别」而非「缺启动命令」');
  assert(weird.errors.command, '同时仍提示 stdio 缺命令（回落 stdio 的后果）');
  // source 字段大小写归一化（#3164）
  eq(validateServerDraft({ id: 'web', transport: 'http', url: 'https://x/mcp', source: 'Claude' }).server.source, 'claude', 'source 应归一为小写');
  eq(validateServerDraft({ id: 'web', transport: 'http', url: 'https://x/mcp' }).server.source, undefined, '无 source 不落字段');
  const ok = validateServerDraft({ id: 'mock', name: 'Mock', transport: 'stdio', command: 'node', args: ['s.mjs'], env: { A: '1' } });
  eq(ok.ok, true, '合法 stdio 草稿应通过');
  eq(ok.server.args[0], 's.mjs', 'args 应保留');
  eq(ok.server.env.A, '1', 'env 应保留');
  eq(mcpToolName('mock', 'echo'), 'mcp__mock__echo', '工具名应为 mcp__<服务器>__<工具>');
  eq(mcpToolName('mock', '怪 名/工具'), 'mcp__mock________', '工具名应 sanitize 为安全字符');
  const dir = mkdtempSync(join(tmpdir(), 'mt-mcp-'));
  const reg = new McpRegistry({ dataDir: dir });
  const r1 = reg.upsert({ id: 'mock', name: 'Mock', transport: 'stdio', command: process.execPath, args: [join(__dirname, 'mock-mcp-server.mjs')] });
  eq(r1.ok, true, 'upsert 应成功');
  eq(loadMcpServers(dir).length, 1, '配置应落盘 mcp.json');
  reg.upsert({ id: 'mock', name: 'Mock2', transport: 'stdio', command: process.execPath, args: [] });
  eq(loadMcpServers(dir).length, 1, '同 ID 应更新而非新增');
  eq(loadMcpServers(dir)[0].name, 'Mock2', '更新应生效');
  reg.remove('mock');
  eq(loadMcpServers(dir).length, 0, '删除应生效');
});

await test('MCP 注册表：连接 mock 服务器发现工具并可调用', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mt-mcp-'));
  const reg = new McpRegistry({ dataDir: dir });
  reg.upsert({ id: 'mock', name: 'Mock', transport: 'stdio', command: process.execPath, args: [join(__dirname, 'mock-mcp-server.mjs')] });
  reg.upsert({ id: 'off', name: '停用', transport: 'stdio', command: process.execPath, args: [], enabled: false });
  const status = await reg.refresh();
  const mockRow = status.find((s) => s.id === 'mock');
  assert(mockRow && mockRow.connected && mockRow.tools === 2, 'mock 服务器应连接并发现 2 个工具');
  eq(status.find((s) => s.id === 'off').connected, false, '停用服务器不应连接');
  const echo = reg.tools.find((t) => t.name === 'mcp__mock__echo');
  assert(echo && echo.description.includes('[MCP:Mock]'), '工具应包装为 kosong 形状并带服务器前缀描述');
  assert(echo.parameters && echo.parameters.properties && echo.parameters.properties.text, 'inputSchema 应映射为 parameters');
  eq(await echo.run({ text: '注册表' }), 'MCP回声:注册表', 'MCP 工具应可调用并回传文本');
  const probe = await reg.probe('mock');
  eq(probe.ok, true, 'probe 应成功');
  eq(probe.tools.length, 2, 'probe 应列出工具名');
});

await test('MCP：stdio initialize 握手与 tools/list', async () => {
  const client = await connectMcp({ transport: 'stdio', command: process.execPath, args: [join(__dirname, 'mock-mcp-server.mjs')] });
  try {
    eq(client.serverInfo.name, 'mock-mcp', '握手应返回服务器信息');
    const tools = await client.listTools();
    eq(tools.length, 2, '应发现 2 个工具');
    const echo = tools.find((t) => t.name === 'echo');
    assert(echo && echo.description && echo.inputSchema && echo.inputSchema.properties && echo.inputSchema.properties.text, '工具 schema 应完整');
  } finally { client.close(); }
});

await test('MCP：tools/call 文本结果与错误路径', async () => {
  const client = await connectMcp({ transport: 'stdio', command: process.execPath, args: [join(__dirname, 'mock-mcp-server.mjs')] });
  try {
    const ok = await client.callTool('echo', { text: '你好' });
    eq(callResultText(ok), 'MCP回声:你好', 'content 文本块应拼为纯文本');
    const bad = await client.callTool('fail', {});
    let err = null;
    try { callResultText(bad); } catch (e) { err = e; }
    assert(err instanceof McpError && err.message.includes('恒失败'), 'isError 结果应抛出可读错误');
    let err2 = null;
    try { await client.callTool('nope', {}); } catch (e) { err2 = e; }
    assert(err2 instanceof McpError && err2.message.includes('未知工具'), 'JSON-RPC error 应映射为 McpError');
  } finally { client.close(); }
});

await test('MCP：HTTP 传输走 POST 并解析 JSON 响应', async () => {
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    seen.push({ url: String(url), body: JSON.parse(opts.body || '{}') });
    const msg = JSON.parse(opts.body);
    const result = msg.method === 'initialize'
      ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'http-mcp', version: '2.0.0' } }
      : msg.method === 'tools/list' ? { tools: [{ name: 'ping', description: 'pong', inputSchema: { type: 'object', properties: {} } }] } : {};
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const client = await connectMcp({ transport: 'http', url: 'https://mcp.test/rpc' });
    eq(client.serverInfo.name, 'http-mcp', 'HTTP 传输应完成握手');
    const tools = await client.listTools();
    eq(tools[0].name, 'ping', 'HTTP 传输应能列出工具');
    assert(seen.every((s) => s.url === 'https://mcp.test/rpc' && s.body.jsonrpc === '2.0'), '请求应为 JSON-RPC 2.0 POST');
  } finally { globalThis.fetch = realFetch; }
});

console.log('\nAgent Loop 单元测试（stub fetch）');

/** 构造 SSE 响应（真实 Response + ReadableStream，loop 用 getReader 消费） */
function sseResp(frames, status = 200) {
  const stream = new ReadableStream({
    start(c) {
      for (const f of frames) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
      c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/event-stream' } });
}
const textFrames = (txt) => [
  { choices: [{ index: 0, delta: { content: txt } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
];
const toolFrames = (name, args) => [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_t1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8 } },
];

/** 一次性 loop 运行环境：临时数据目录 + stub fetch + 事件收集 */
async function runLoopOnce({ framesByCall, harness = getHarness('standard'), permission = 'allow', seedRecords = [], providerExtra = {}, input = '开始', planMode = false, planDecision = 'approve', sessionName = '', titleMode = 'local', agentProxy = '', wsFiles = {}, ignoreFile = '', sanitizeChildEnv, steer = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mt-loop-'));
  const ws = join(dir, 'workspace');
  mkdirSync(ws, { recursive: true });
  for (const [rel, text] of Object.entries(wsFiles)) {
    const abs = join(ws, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  if (ignoreFile) writeFileSync(join(ws, '.auroraagentignore'), ignoreFile);
  const store = new SessionStore(dir);
  const usage = new UsageLedger(dir);
  const session = store.create({ name: sessionName, model: 'm1', harness: harness.id, workspace: ws });
  for (const r of seedRecords) store.append(session.id, r);
  const events = [];
  const requests = [];
  const provider = { id: 'p1', name: '测试提供方', protocol: 'openai', baseUrl: 'https://up.test', pathPrefix: '/v1', apiKey: 'k', ...providerExtra };
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, opts = {}) => {
    requests.push({ url: String(url), body: JSON.parse(opts.body || '{}'), signal: opts.signal });
    if (opts.signal?.aborted) throw opts.signal.reason || Object.assign(new Error('aborted'), { name: 'AbortError' });
    // 计数必须在脚本回调之前推进：回调里抛错（模拟中途断流 / 上游失败）时也不能把序号卡住，
    // 否则后续每轮都拿到同一个 n，一次抛错会被误演成「每轮都抛」
    const n = call++;
    const scripted = typeof framesByCall === 'function' ? framesByCall(n, requests.at(-1)) : framesByCall[Math.min(n, framesByCall.length - 1)];
    if (scripted instanceof Response) return scripted;
    if (Array.isArray(scripted)) return sseResp(scripted);
    return sseResp(scripted.frames, scripted.status);
  };
  const controller = new AbortController();
  let permCalls = 0;
  const result = await runAgentTurn({
    store, usage, session, input, provider, model: 'm1', harness,
    builtinPrice: { input: 2, output: 8 },
    emit: (type, payload) => events.push({ type, ...payload }),
    controller,
    requestPermission: async () => { permCalls++; return permission; },
    planMode,
    titleMode,
    agentProxy,
    sanitizeChildEnv,
    requestPlanDecision: async () => planDecision,
    modelSteer: steer || undefined,
    log: () => {},
  }).finally(() => { globalThis.fetch = realFetch; });
  return { dir, ws, store, usage, session, events, requests, result, permCalls };
}

// ---------- 单元测试: 本机代理经 Loop 出站 ----------
console.log('\n本机代理 Loop 单测');
{
  const fx = await startFetchFixtures();
  try {
    await test('Agent turn：web_fetch 经 ctx.agentProxy 走本机代理抓取（工具结果回填）', async () => {
      const { events, result } = await runLoopOnce({
        framesByCall: [
          toolFrames('web_fetch', { url: `http://127.0.0.1:${fx.originPort}/wiki/代理测试` }),
          textFrames('抓取完成'),
        ],
        agentProxy: `http://127.0.0.1:${fx.proxyPort}`,
      });
      const done = events.find((e) => e.type === 'tool_event' && e.phase === 'completed');
      assert(done && done.output.includes('HTTP 200') && done.output.includes('ORIGIN-OK'), `工具应经代理拿到正文，实际：${done && done.output.slice(0, 120)}`);
      eq(result.text, '抓取完成');
    });
    await test('Agent turn：未配置代理时 web_fetch 直连（行为不变）', async () => {
      const { events } = await runLoopOnce({
        framesByCall: [
          toolFrames('web_fetch', { url: `http://127.0.0.1:${fx.originPort}/wiki/直连` }),
          textFrames('完成'),
        ],
      });
      const done = events.find((e) => e.type === 'tool_event' && e.phase === 'completed');
      assert(done && done.output.includes('HTTP 200'), '直连路径应照旧');
    });
  } finally {
    fx.close();
  }
}

await test('Loop：相邻只读工具并行重叠、写工具串行，结果顺序与模型给出的一致', async () => {
  const multiTool = (calls) => [
    { choices: [{ index: 0, delta: { tool_calls: calls.map((c, i) => ({ index: i, id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ];
  const { ws, events, requests, result } = await runLoopOnce({
    wsFiles: { 'a.txt': 'AAA', 'b.txt': 'BBB' },
    framesByCall: (n) => (n === 0 ? multiTool([
      { id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
      { id: 'c2', name: 'read_file', args: { path: 'b.txt' } },
      { id: 'c3', name: 'write_file', args: { path: 'c.txt', content: 'CCC' } },
    ]) : textFrames('完成')),
  });
  eq(result.text, '完成', 'turn 应正常收尾');
  const phases = events.filter((e) => e.type === 'tool_event').map((e) => `${e.phase}:${e.toolId}`);
  // 两个只读调用并行：两条 started 都早于各自的 completed（串行会是 started→completed 交替）
  eq(phases.indexOf('started:c1') < phases.indexOf('started:c2'), true, '两条 started 连续发出（并行段）');
  eq(phases.indexOf('started:c2') < phases.indexOf('completed:c1'), true, '第二条 started 早于第一条 completed（重叠执行）');
  eq(phases.indexOf('completed:c1') < phases.indexOf('started:c3'), true, '写工具在只读段收尾后才开始（串行）');
  // 回填顺序严格按 c1 c2 c3：上游按 tool_call_id 匹配，错位即 400
  const toolIds = requests[1].body.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  eq(JSON.stringify(toolIds), JSON.stringify(['c1', 'c2', 'c3']), 'tool 消息顺序必须与模型给出的一致');
  eq(readFileSync(join(ws, 'c.txt'), 'utf8'), 'CCC', '写工具应真的落地');
});

await test('Loop：连接期限流后同提供方内原地重试，恢复后照常收尾', async () => {
  const { events, requests, result } = await runLoopOnce({
    framesByCall: (n) => (n === 0
      ? { frames: [{ choices: [{ index: 0, delta: { content: 'too many requests' } }] }], status: 429 }
      : textFrames('恢复后的回答')),
  });
  eq(requests.length, 2, '第一次 429 后原地重试一次');
  eq(result.text, '恢复后的回答', '重试成功后内容照常产出');
  eq(result.failed, undefined, 'turn 不失败');
  assert(events.some((e) => e.type === 'turn_completed'), '正常收尾');
});

await test('Loop：流已产出字节后失败不原地重试（透明重试会重复扣费）', async () => {
  const { requests, result, events } = await runLoopOnce({
    framesByCall: () => new Response(new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"半截"}}]}\n\n'));
        // 已向调用方发出字节后才失败：重试会让用户看到两遍半截回答
        c.error(Object.assign(new TypeError('network down'), { kind: 'network' }));
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
  });
  eq(requests.length, 1, '有产出就不再原地重试');
  assert(events.some((e) => e.type === 'turn_failed'), '以 turn_failed 收尾');
  eq(result.failed, true, '上报失败');
});

await test('Loop：不可原地重试的错误（400 请求自身问题）不重试', async () => {
  const { requests, result } = await runLoopOnce({
    framesByCall: () => ({ frames: [{ choices: [{ index: 0, delta: { content: 'bad request' } }] }], status: 400 }),
  });
  eq(requests.length, 1, '400 是请求自身问题，重试只会放大错误');
  eq(result.failed, true, '直接失败');
});

await test('Loop：上下文超长只压缩重放一次，恢复后照常收尾', async () => {
  const overflow = () => ({ frames: [{ choices: [{ index: 0, delta: { content: "This model's maximum context length is 128000 tokens." } }] }], status: 400 });
  // 历史要长到确有可切点（findCutIndex 要求头部 ≥6 条记录且用户轮 > keepTurns），
  // 否则 planCompaction 返回 null、压缩请求根本不会发生
  const seed = [];
  for (let i = 0; i < 12; i++) {
    seed.push({ t: 'user', text: `第${i}个问题，${'x'.repeat(120)}` });
    seed.push({ t: 'assistant', text: `第${i}个回答，${'y'.repeat(120)}` });
  }
  const { requests, events, result } = await runLoopOnce({
    seedRecords: seed,
    framesByCall: (n) => (n === 0 ? overflow() : textFrames('【摘要】早期讨论了十二个问题')),
  });
  eq(requests.length, 3, '超长错误只触发一次压缩重放（原轮 + 压缩 + 重放）');
  assert(events.some((e) => e.type === 'context_compression_started'), '走过压缩');
  assert(events.some((e) => e.type === 'context_compression_completed'), '压缩完成');
  eq(requests[0].body.messages[0].role, 'system', '第一次请求是主轮次（报超长）');
  assert(String(requests[1].body.messages[1].content).includes('第0个问题'), '第二次请求是压缩摘要（消息 0 是压缩器系统提示）');
  eq(result.text, '【摘要】早期讨论了十二个问题', '重放后内容照常');
  eq(result.failed, undefined, 'turn 成功');
});

await test('Loop：压缩无效时不循环重放，把真实错误抛出来', async () => {
  const overflow = () => ({ frames: [{ choices: [{ index: 0, delta: { content: 'maximum context length exceeded' } }] }], status: 400 });
  const { requests, result } = await runLoopOnce({
    seedRecords: [{ t: 'user', text: '历史'.repeat(200) }],
    framesByCall: () => overflow(),
  });
  eq(requests.length, 2, '只重放一次（不无限循环）');
  eq(result.failed, true, '把真实错误交给用户');
});

await test('Loop：长度截断续写只追问一次，前后半段拼成完整回答', async () => {
  const lenFrame = (txt) => [
    { choices: [{ index: 0, delta: { content: txt } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 5, completion_tokens: 5 } },
  ];
  const { requests, result } = await runLoopOnce({
    framesByCall: (n) => (n <= 1 ? lenFrame(n === 0 ? '前半段' : '后半段也触顶') : textFrames('第三段')),
  });
  eq(requests.length, 2, '第二次仍触顶就不再追问');
  eq(result.text, '前半段后半段也触顶', '前后半段拼成完整回答');
  eq(result.failed, undefined, 'turn 正常收尾');
});

await test('Loop：中途发言只断当前模型流，发言并入上下文后继续', async () => {
  const steer = createModelSteer();
  eq(steer.request(''), false, '空发言不被接受');
  eq(steer.request('没在飞'), false, '没有模型流在飞时不抢话（走队列）');
  const { events, requests, result, ws, store, session } = await runLoopOnce({
    steer,
    framesByCall: (n, req) => {
      if (n === 0) {
        const ok = steer.request('顺便把结论也写上');
        assert(ok === true, '模型流在飞时发言被当前 turn 吸收');
        throw req.signal.reason; // 模拟 fetch 因这一断而失败
      }
      if (n === 1) return toolFrames('write_file', { path: 'a.txt', content: 'AAA\n结论\n' });
      return textFrames('写好了');
    },
    wsFiles: { 'a.txt': 'AAA\n' },
  });
  const steered = events.find((e) => e.type === 'message_steered');
  assert(steered && steered.text === '顺便把结论也写上', '发出 message_steered 事件');
  eq(requests.length, 3, '插话后照常跑后续轮');
  eq(result.text, '写好了', 'turn 正常收尾');
  eq(readFileSync(join(ws, 'a.txt'), 'utf8'), 'AAA\n结论\n', '在跑的工具照常落地');
  const recs = store.records(session.id);
  assert(recs.some((r) => r.t === 'user' && r.text === '顺便把结论也写上'), '发言作为用户记录并入上下文');
});

await test('Loop：工具执行期间的发言不被吸收，走队列由泵接力', async () => {
  const steer = createModelSteer();
  let absorbed = 'unset';
  const { events, result } = await runLoopOnce({
    steer,
    wsFiles: { 'a.txt': 'AAA' },
    framesByCall: (n) => {
      if (n === 0) {
        // 此刻模型流已结束、工具即将开跑：steer.streaming 为 false，request 应返回 false
        setTimeout(() => { absorbed = steer.request('工具跑的时候说一句'); }, 0);
        return toolFrames('shell', { command: 'sleep 0.3' });
      }
      return textFrames('完成');
    },
  });
  eq(absorbed, false, '工具执行期间没有模型流可断，发言交给队列');
  const done = events.find((e) => e.type === 'tool_event' && e.phase === 'completed');
  assert(done && !events.some((e) => e.type === 'tool_event' && e.phase === 'failed'), '在跑的工具没被打断');
  eq(result.failed, undefined, 'turn 正常收尾');
});

await test('Loop：命中忽略规则的文件工具被拒（禁入区不进上下文）', async () => {
  const { events, requests } = await runLoopOnce({
    wsFiles: { 'app.pem': 'SECRET', 'ok.txt': 'fine' },
    ignoreFile: '*.pem\n',
    framesByCall: [
      toolFrames('read_file', { path: 'app.pem' }),
      textFrames('已了解'),
    ],
  });
  const failed = events.find((e) => e.type === 'tool_event' && e.phase === 'failed');
  assert(failed && failed.output.includes('禁入区'), '读禁入区文件应失败并说明原因，实际: ' + (failed && failed.output.slice(0, 80)));
  const toolMsg = requests[1].body.messages.find((m) => m.role === 'tool');
  assert(!String(toolMsg.content).includes('SECRET'), '禁入区内容绝不能进上下文');
});

console.log('\n转录投影层单元测试');
await test('transcript: 工具标签覆盖内置 / 技能 / 子代理 / MCP 推导', () => {
  eq(toolLabel('read_file'), '读取文件');
  eq(toolLabel('task'), '派发子代理');
  eq(toolLabel('mcp__mock__echo'), 'mock.echo（MCP）');
  eq(toolLabel('unknown_tool'), 'unknown_tool');
  eq(toolIconKey('edit_file'), 'edit');
  eq(toolIconKey('mcp__mock__echo'), 'plug');
  eq(toolIconKey('task'), 'task');
  eq(toolIconKey('whatever'), 'wrench');
});
await test('transcript: 资源摘要按工具类型取值', () => {
  eq(toolResourceOf('read_file', { path: 'a.txt' }), 'a.txt');
  eq(toolResourceOf('shell', { command: 'ls -la' }), 'ls -la');
  eq(toolResourceOf('grep', { pattern: 'foo' }), 'foo');
  eq(toolResourceOf('web_fetch', { url: 'http://x' }), 'http://x');
  eq(toolResourceOf('task', { tasks: ['甲', '乙'] }), '2 个子任务');
  eq(toolResourceOf('read_file', null), '');
});
await test('transcript: fmtCost 小额六位常规四位', () => {
  eq(fmtCost(0.001234), '0.001234');
  eq(fmtCost(1.5), '1.5000');
});
await test('transcript: projectTurns 按用户轮分组并回填工具结果', () => {
  const { turns } = projectTurns([
    { t: 'user', text: '问题一' },
    { t: 'thinking', text: '想想' },
    { t: 'assistant', text: '好的' },
    { t: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a' } },
    { t: 'tool_result', id: 'c1', name: 'read_file', ok: true, output: '内容' },
    { t: 'usage', inputTokens: 10, outputTokens: 5, cost: 0.001 },
    { t: 'assistant', text: '第二轮答复' },
    { t: 'user', text: '问题二' },
    { t: 'summary', text: '压缩摘要' },
  ]);
  eq(turns.length, 4, '同一用户轮内的多个模型轮只算一条 assistant 视图');
  eq(turns[0].kind, 'user');
  eq(turns[1].kind, 'round');
  eq(turns[1].thinking, '想想');
  eq(turns[1].text, '好的\n第二轮答复', '兼容视图 text 为文本片段汇总');
  eq(turns[1].tools.length, 1);
  eq(turns[1].tools[0].ok, true);
  eq(turns[1].tools[0].output, '内容');
  eq(turns[1].usage.cost, 0.001);
  eq(turns[2].kind, 'user');
  eq(turns[2].text, '问题二');
  eq(turns[3].kind, 'system');
});
await test('transcript: projectTurns 用户轮内文本与工具按时间线交错（回答不被工具切断）', () => {
  const { turns } = projectTurns([
    { t: 'assistant', text: '先看目录' },
    { t: 'tool_call', id: 'c1', name: 'list_dir', args: { dir: '.' } },
    { t: 'tool_result', id: 'c1', name: 'list_dir', ok: false, output: '失败' },
    { t: 'assistant', text: '再读文件' },
    { t: 'tool_call', id: 'c2', name: 'read_file', args: { path: 'a' } },
    { t: 'tool_result', id: 'c2', name: 'read_file', ok: true, output: '内容' },
    { t: 'assistant', text: '收尾总结' },
    { t: 'user', text: '下一个问题' },
    { t: 'assistant', text: '新轮答复' },
  ]);
  eq(turns.length, 3, 'round / user / round 共三段');
  eq(turns[0].kind, 'round', '首条 assistant 前无 user 也自成一轮');
  const kinds = turns[0].parts.map((p) => p.kind);
  eq(kinds.join(','), 'text,tool,text,tool,text', '片段顺序即时间线');
  eq(turns[0].text, '先看目录\n再读文件\n收尾总结');
  eq(turns[0].tools.length, 2);
  eq(turns[0].tools[0].ok, false);
  eq(turns[0].tools[1].ok, true);
  eq(turns[1].kind, 'user');
  eq(turns[1].text, '下一个问题');
  eq(turns[2].parts.length, 1);
  eq(turns[2].text, '新轮答复');
});
await test('transcript: projectTurns 并行工具调用不拆散且按序回填', () => {
  const { turns } = projectTurns([
    { t: 'assistant', text: '并行查两个文件' },
    { t: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a' } },
    { t: 'tool_call', id: 'c2', name: 'read_file', args: { path: 'b' } },
    { t: 'tool_result', id: 'c2', name: 'read_file', ok: true, output: '乙' },
    { t: 'tool_result', id: 'c1', name: 'read_file', ok: true, output: '甲' },
  ]);
  eq(turns.length, 1);
  eq(turns[0].tools.map((t) => t.output).join(','), '甲,乙', '结果按调用序回填到对应卡片');
  eq(turns[0].parts.filter((p) => p.kind === 'tool').length, 2);
});

await test('transcript: projectTurns 同 id 多调用（上游复用 id）结果各归其位', () => {
  const { turns } = projectTurns([
    { t: 'tool_call', id: 'call_mock_1', name: 'create_goal', args: { objective: '甲目标' } },
    { t: 'tool_result', id: 'call_mock_1', name: 'create_goal', ok: true, output: '目标已创建' },
    { t: 'tool_call', id: 'call_mock_1', name: 'update_goal', args: { mode: 'status', status: 'complete' } },
    { t: 'tool_result', id: 'call_mock_1', name: 'update_goal', ok: true, output: '已记录' },
  ]);
  eq(turns[0].parts.filter((p) => p.kind === 'tool').length, 2, '两个调用各占一张卡片');
  eq(turns[0].tools[0].output, '目标已创建', '首个调用的结果不被第二个顶掉');
  eq(turns[0].tools[1].output, '已记录', '第二个调用应拿到自己的结果而非永远执行中');
  assert(turns[0].tools.every((t) => t.ok === true), '两个调用都应标记完成');
});

await test('Loop：无工具轮直接出终稿并记账', async () => {
  const { events, store, usage, result, requests } = await runLoopOnce({
    framesByCall: [textFrames('你好，世界')],
    harness: getHarness('minimal'),
  });
  const types = events.map((e) => e.type);
  assert(types.includes('turn_started') && types.includes('model_round_started'), '应有 turn 与轮次开始事件');
  assert(types.includes('text_chunk'), '应有文本增量事件');
  assert(types.includes('token_usage_updated'), '应有用量事件');
  assert(types.at(-1) === 'turn_completed', '应以 turn_completed 收尾');
  eq(result.text, '你好，世界');
  eq(result.tools, 0);
  const recs = store.records(result.sessionId || events[0].sessionId);
  assert(recs.some((r) => r.t === 'user' && r.text === '开始'), '用户消息应落转录');
  assert(recs.some((r) => r.t === 'assistant' && r.text === '你好，世界'), '回答应落转录');
  assert(recs.some((r) => r.t === 'usage' && r.inputTokens === 10), '用量应落转录');
  eq(usage.read().length, 1, '账本应记 1 条');
  eq(usage.read()[0].kind, 'agent');
  eq(requests[0].body.tools, undefined, 'minimal 模式不应带 tools');
});

await test('Loop：首条消息自动总结会话标题并推送 session_renamed', async () => {
  const { store, events } = await runLoopOnce({
    framesByCall: [textFrames('好的，我来看一下')],
    input: '帮我把 README 的安装章节改写一下',
    harness: getHarness('minimal'),
  });
  const meta = store.list()[0];
  eq(meta.name, '帮我把 README 的安装章…', '默认名会话应按首条消息总结出标题');
  const renamed = events.find((e) => e.type === 'session_renamed');
  assert(renamed && renamed.name === meta.name && renamed.sessionId === meta.id, '应推送 session_renamed 事件');
});

await test('Loop：已命名会话不被自动标题覆盖', async () => {
  const { store, events } = await runLoopOnce({
    framesByCall: [textFrames('好的')],
    input: '帮我把 README 的安装章节改写一下',
    harness: getHarness('minimal'),
    sessionName: '用户自己起的名字',
  });
  eq(store.list()[0].name, '用户自己起的名字', '用户改名应保留');
  assert(!events.some((e) => e.type === 'session_renamed'), '已命名会话不应推送改名事件');
});

await test('Loop：提炼不出内容时保留默认名', async () => {
  const { store, events } = await runLoopOnce({
    framesByCall: [textFrames('好的')],
    input: '。。。',
    harness: getHarness('minimal'),
  });
  eq(store.list()[0].name, '新会话', '纯标点输入不强行起标题');
  assert(!events.some((e) => e.type === 'session_renamed'), '无标题可提炼时不推送事件');
});

await test('Loop：titleMode=model 多一次标题请求并起模型名', async () => {
  const { store, usage, events, requests } = await runLoopOnce({
    framesByCall: [textFrames('好的，我来看一下'), textFrames('「README 安装章节改写」')],
    input: '帮我把 README 的安装章节改写一下',
    harness: getHarness('minimal'),
    titleMode: 'model',
  });
  eq(requests.length, 2, '主轮之外应多一次标题请求');
  const titleReq = requests[1].body;
  assert(String(titleReq.messages[0].content).includes('【会话标题生成】'), '标题请求应带标题生成系统提示');
  assert(String(titleReq.messages[1].content).includes('帮我把 README'), '标题请求应带上首条用户消息');
  assert(String(titleReq.messages[1].content).includes('助手答复'), '标题请求应参考助手终稿');
  eq(titleReq.max_tokens, TITLE_MAX_TOKENS, '标题请求应压住输出上限');
  eq(titleReq.tools, undefined, '标题请求不应带工具');
  eq(store.list()[0].name, 'README 安装章节改写', '应采用模型总结并清洗引号壳');
  const renamed = events.find((e) => e.type === 'session_renamed');
  assert(renamed && renamed.mode === 'model', 'session_renamed 应带 mode=model');
  eq(usage.read().length, 2, '账本应记主轮与标题两笔');
  eq(usage.read()[1].purpose, 'title', '标题账应带 purpose 标记');
  const meta = store.list()[0];
  eq(meta.inputTokens, 20, '会话汇总应含标题请求的输入 tokens');
  eq(meta.outputTokens, 10, '会话汇总应含标题请求的输出 tokens');
  assert(meta.cost > 0, '会话汇总费用应含标题请求');
});

await test('Loop：模型标题失败回退本地推导且不记标题账', async () => {
  const { store, usage, events, requests } = await runLoopOnce({
    framesByCall: [textFrames('好的'), { frames: [textFrames('不会走到')], status: 500 }],
    input: '帮我把 README 的安装章节改写一下',
    harness: getHarness('minimal'),
    titleMode: 'model',
  });
  eq(requests.length, 4, '标题请求的 5xx 应按同提供方重试再失败（首次 + 2 次原地重试）');
  eq(store.list()[0].name, '帮我把 README 的安装章…', '失败应回退本地推导');
  assert(events.some((e) => e.type === 'session_renamed' && e.mode === 'model'), '仍应推送改名事件');
  eq(usage.read().length, 1, '失败的标题请求不记账');
});

await test('Loop：local 模式不产生额外上游请求', async () => {
  const { store, requests } = await runLoopOnce({
    framesByCall: [textFrames('好的')],
    input: '帮我把 README 的安装章节改写一下',
    harness: getHarness('minimal'),
  });
  eq(requests.length, 1, '本地推导零成本：只应有一次上游请求');
  eq(store.list()[0].name, '帮我把 README 的安装章…');
});

await test('Loop：model 模式已命名会话不花标题钱', async () => {
  const { store, usage, requests } = await runLoopOnce({
    framesByCall: [textFrames('好的')],
    input: '帮我把 README 的安装章节改写一下',
    harness: getHarness('minimal'),
    titleMode: 'model',
    sessionName: '用户自己起的名字',
  });
  eq(requests.length, 1, '已命名会话不应发起标题请求');
  eq(store.list()[0].name, '用户自己起的名字');
  eq(usage.read().length, 1, '只应记主轮一笔');
});

await test('Loop：工具轮经权限允许后执行并回填结果', async () => {
  const { ws, store, events, result, requests, permCalls } = await runLoopOnce({
    framesByCall: [toolFrames('write_file', { path: 'out/a.txt', content: 'LOOP_OK' }), textFrames('写好了')],
    permission: 'allow',
  });
  eq(readFileSync(join(ws, 'out/a.txt'), 'utf8'), 'LOOP_OK', '工具应真实落盘');
  const phases = events.filter((e) => e.type === 'tool_event').map((e) => e.phase);
  assert(phases.includes('started') && phases.includes('confirmation_needed') && phases.includes('confirmed') && phases.includes('completed'), `工具事件阶段应完整: ${phases.join(',')}`);
  eq(permCalls, 1, '应询问一次权限');
  eq(result.tools, 1);
  eq(result.text, '写好了');
  const second = requests[1].body.messages;
  const toolMsg = second.find((m) => m.role === 'tool');
  assert(toolMsg, '第二轮应带回工具结果消息');
  assert(toolMsg.content.includes('LOOP_OK') || toolMsg.content.includes('已写入'), '工具结果应回填给模型');
  const asst = second.find((m) => m.role === 'assistant' && m.tool_calls);
  eq(asst.tool_calls[0].function.name, 'write_file');
  const recs = store.records(events[0].sessionId);
  assert(recs.some((r) => r.t === 'tool_result' && r.ok), '工具结果应落转录');
});

await test('Loop：权限拒绝后循环继续，模型看到拒绝原因', async () => {
  const { events, result, requests, permCalls } = await runLoopOnce({
    framesByCall: [toolFrames('shell', { command: 'echo hi' }), textFrames('好的，不执行')],
    permission: 'deny',
  });
  const phases = events.filter((e) => e.type === 'tool_event').map((e) => e.phase);
  assert(phases.includes('rejected'), '应有 rejected 阶段');
  assert(!phases.includes('completed'), '拒绝后不应执行');
  eq(permCalls, 1);
  eq(result.text, '好的，不执行');
  const toolMsg = requests[1].body.messages.find((m) => m.role === 'tool');
  assert(toolMsg.content.includes('用户拒绝'), '模型应看到拒绝原因');
});

await test('Loop：总是允许沉淀为会话规则，同类调用不再询问', async () => {
  const { store, events, permCalls, result } = await runLoopOnce({
    framesByCall: [toolFrames('write_file', { path: 'b.txt', content: '1' }), toolFrames('write_file', { path: 'b.txt', content: '2' }), textFrames('完成')],
    permission: 'always',
  });
  eq(permCalls, 1, '只有第一次应询问');
  const meta = store.list()[0];
  eq(meta.rules.length, 1, '应沉淀 1 条会话规则');
  eq(meta.rules[0].effect, 'allow');
  const phases = events.filter((e) => e.type === 'tool_event').map((e) => e.phase);
  eq(phases.filter((p) => p === 'confirmation_needed').length, 1, 'confirmation_needed 只应出现一次');
  eq(result.tools, 2);
});

await test('Loop：中断保留已生成内容并发 turn_cancelled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mt-loop-abort-'));
  const ws = join(dir, 'workspace');
  mkdirSync(ws, { recursive: true });
  const store = new SessionStore(dir);
  const session = store.create({ model: 'm1', harness: 'standard', workspace: ws });
  const events = [];
  const controller = new AbortController();
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (url, opts = {}) => {
    call++;
    if (call === 1) return sseResp(toolFrames('shell', { command: 'echo hi' }));
    // 第二轮：模拟一个拖尾的流，等 abort 赛赢
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '半句' } }] })}\n\n`)); } });
    return new Response(stream, { status: 200 });
  };
  const p = runAgentTurn({
    store, usage: new UsageLedger(dir), session, input: '跑命令', provider: { id: 'p1', name: 'p', protocol: 'openai', baseUrl: 'https://up.test', pathPrefix: '/v1', apiKey: 'k' },
    model: 'm1', harness: getHarness('standard'), builtinPrice: { input: 2, output: 8 },
    emit: (type, payload) => events.push({ type, ...payload }),
    controller,
    requestPermission: () => new Promise(() => {}), // 永不回应，等 abort
    log: () => {},
  });
  setTimeout(() => controller.abort(), 60);
  const result = await p.finally(() => { globalThis.fetch = realFetch; });
  eq(result.cancelled, true, '应标记取消');
  assert(events.some((e) => e.type === 'turn_cancelled'), '应发 turn_cancelled');
  const texts = events.filter((e) => e.type === 'text_chunk').map((e) => e.text).join('');
  assert(texts.includes('半句'), '已生成内容应保留');
  rmSync(dir, { recursive: true, force: true });
});

await test('Loop：上下文超限时先压缩再继续', async () => {
  const seed = [];
  for (let i = 0; i < 12; i++) {
    seed.push({ t: 'user', text: `第${i}个问题，${'x'.repeat(120)}` });
    seed.push({ t: 'assistant', text: `第${i}个回答，${'y'.repeat(120)}` });
  }
  const { store, events, requests, result } = await runLoopOnce({
    seedRecords: seed,
    framesByCall: [textFrames('【摘要】早期讨论了十二个问题'), textFrames('压缩后继续回答')],
    providerExtra: { capacity: { contextWindow: 600 } },
  });
  const types = events.map((e) => e.type);
  assert(types.includes('context_compression_started'), '应发压缩开始事件');
  assert(types.includes('context_compression_completed'), '应发压缩完成事件');
  eq(requests[0].body.messages[0].role, 'system', '第一次调用应是压缩请求');
  assert(requests[0].body.messages[1].content.includes('第0个问题'), '压缩输入应含早期对话');
  assert(requests[1].body.messages.some((m) => typeof m.content === 'string' && m.content.includes('【摘要】')), '主轮次应带上摘要');
  const recs = store.records(events[0].sessionId);
  eq(recs[0].t, 'summary', '重写后转录应以 summary 打头');
  eq(result.text, '压缩后继续回答');
});

await test('Loop：上游 401 映射为中文错误并以 turn_failed 收尾', async () => {
  const { events, result } = await runLoopOnce({
    framesByCall: [{ status: 401, frames: [] }],
  });
  const failed = events.find((e) => e.type === 'turn_failed');
  assert(failed, '应发 turn_failed');
  assert(failed.error.includes('API Key 无效'), `错误应说清原因: ${failed.error}`);
  eq(result.failed, true);
});

await test('Loop：触顶轮次上限以 max_rounds 收尾', async () => {
  const harness = { id: 'test-cap', label: 'Test', summary: 'x', tools: ['read_file'], maxRounds: 2, compactRatio: 0.99, systemPrompt: 'x' };
  const { events, result } = await runLoopOnce({
    framesByCall: [toolFrames('read_file', { path: 'nope.txt' })],
    harness,
  });
  eq(result.tools, 2, '应跑满 2 轮各 1 次工具');
  const done = events.find((e) => e.type === 'turn_completed');
  eq(done.finishReason, 'max_rounds');
});

await test('Loop：计划模式批准后进入执行（计划轮只读工具）', async () => {
  const { events, result, requests } = await runLoopOnce({
    framesByCall: (call) => (call === 0 ? textFrames('计划：先读后改') : textFrames('已按计划完成')),
    planMode: true,
  });
  const types = events.map((e) => e.type);
  assert(types.includes('plan_proposed'), '应有 plan_proposed 事件');
  assert(types.includes('plan_approved'), '批准后应有 plan_approved 事件');
  assert(!types.includes('plan_rejected'), '批准不应出现 plan_rejected');
  eq(result.text, '已按计划完成', '终稿来自执行轮');
  const planTools = (requests[0].body.tools || []).map((t) => (t.function ? t.function.name : t.name));
  assert(planTools.length > 0 && planTools.every((n) => ['read_file', 'list_dir', 'grep', 'glob', 'web_fetch', 'todo', 'skill'].includes(n)), '计划轮只能用只读 / 检索 / 待办工具');
  const execMsgs = requests[1].body.messages.map((m) => String(m.content || ''));
  assert(execMsgs.some((c) => c.includes('【已批准的计划】') && c.includes('计划：先读后改')), '执行轮应注入已批准的计划');
  assert(requests[0].body.messages.some((m) => m.role === 'system' && String(m.content).includes('计划模式')), '计划轮系统提示应带计划模式附加块');
  assert(!requests[1].body.messages.some((m) => m.role === 'system' && String(m.content).includes('当前为计划模式')), '执行轮系统提示不应再带计划模式附加块');
});

await test('Loop：task 工具派发子代理并聚合结果', async () => {
  const { events, result, store } = await runLoopOnce({
    framesByCall: (call) => {
      if (call === 0) return toolFrames('task', { tasks: ['子任务甲', '子任务乙'] });
      if (call === 1) return toolFrames('read_file', { path: 'a.txt' });
      if (call === 2) return textFrames('子代理甲结果');
      if (call === 3) return textFrames('子代理乙结果');
      return textFrames('汇总完毕');
    },
  });
  eq(result.text, '汇总完毕', '父轮终稿来自汇总轮');
  const taskEv = events.find((e) => e.type === 'tool_event' && e.toolName === 'task' && e.phase === 'completed');
  assert(taskEv, 'task 工具应执行完成');
  assert(Array.isArray(taskEv.extra?.children) && taskEv.extra.children.length === 2, 'completed 事件应带 2 个子代理结果');
  assert(taskEv.extra.children.every((c) => c.ok && c.sessionId), '子代理应成功且会话可查');
  assert(taskEv.output.includes('子代理甲结果') && taskEv.output.includes('子代理乙结果'), '聚合输出应含各子代理终稿');
  eq(store.list().filter((m) => m.name.startsWith('子任务：')).length, 2, '应创建 2 个真实子会话');
  assert(events.some((e) => e.type === 'tool_event' && e.subAgent === true), '子代理工具事件应带 subAgent 标记（供嵌套渲染）');
  assert(!events.some((e) => e.type === 'text_chunk' && e.subAgent === true), '子代理文本不应透出到父事件流');
});

await test('Loop：子代理嵌套深度封顶（孙代理不再派发）', async () => {
  const { events, result, requests, store } = await runLoopOnce({
    framesByCall: (call) => {
      if (call === 0) return toolFrames('task', { task: '父派发' });
      if (call === 1) return toolFrames('task', { task: '子派发' });
      if (call === 2) return toolFrames('task', { task: '孙派发' });
      if (call === 3) return textFrames('孙代理终稿');
      if (call === 4) return textFrames('子代理终稿');
      return textFrames('父终稿');
    },
  });
  eq(result.text, '父终稿', '父轮终稿来自汇总轮');
  const refused = events.filter((e) => e.type === 'tool_event' && e.toolName === 'task' && e.phase === 'completed' && String(e.output).includes('嵌套深度已达上限'));
  assert(refused.length >= 1, '孙代理的派发应被深度上限拒绝');
  eq(store.list().filter((m) => m.name.startsWith('子任务：')).length, 2, '应创建子、孙两个层级的子会话');
  assert(requests.length >= 6, '各层回合都应真实请求上游');
});

await test('Loop：计划模式驳回后不执行', async () => {
  const { events, result, requests } = await runLoopOnce({
    framesByCall: [textFrames('计划：先读后改')],
    planMode: true,
    planDecision: 'reject',
  });
  const types = events.map((e) => e.type);
  assert(types.includes('plan_proposed') && types.includes('plan_rejected'), '应有提议与驳回事件');
  assert(!types.includes('plan_approved'), '驳回不应有批准事件');
  eq(result.planRejected, true, '结果应标记 planRejected');
  eq(requests.length, 1, '驳回后不应再请求上游');
  const done = events.find((e) => e.type === 'turn_completed');
  eq(done.finishReason, 'plan_rejected', '应以 plan_rejected 收尾');
});

await test('Loop：未知工具与坏参数不中断循环', async () => {
  const { events, result, requests } = await runLoopOnce({
    framesByCall: [
      [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'no_such_tool', arguments: '{}' } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }],
      [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c2', type: 'function', function: { name: 'read_file', arguments: 'not-json' } }] } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }],
      textFrames('兜底完成'),
    ],
  });
  eq(result.tools, 2);
  eq(result.text, '兜底完成');
  const failedPhases = events.filter((e) => e.type === 'tool_event' && e.phase === 'failed').length;
  eq(failedPhases, 2, '两次异常调用都应报 failed');
  const toolMsgs = requests[2].body.messages.filter((m) => m.role === 'tool');
  eq(toolMsgs.length, 2, '两轮工具结果都应回填');
  assert(toolMsgs[0].content.includes('未知工具'), '未知工具应给出可用清单');
});

// ---------- 单元测试: 错误日志 ----------
console.log('\n错误日志单元测试');
await test('错误日志：环形保留、坏行容错与清空', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-errlog-'));
  const lg = new ErrorLog(dir, { version: '9.9.9' });
  lg.record('frontend_crash', '渲染崩了', 'Error: boom\n  at App');
  lg.record('weird_kind', '未知来源归一为 backend', '');
  lg.record('backend', '坏行不应影响读取', 'x'.repeat(5000));
  const rows = lg.list(10);
  eq(rows.length, 3, '应记 3 条');
  eq(rows[0].kind, 'backend', '未知 kind 归一为 backend');
  eq(rows[1].kind, 'backend', '未知 kind 归一');
  eq(rows[2].kind, 'frontend_crash', '倒序返回');
  eq(rows[0].version, '9.9.9', '应带版本号');
  assert(rows[0].detail.length <= 4096, 'detail 应截断到 4KB');
  // 超过上限时原子重写只留最后 N 行
  for (let i = 0; i < ERROR_LOG_MAX_LINES + 5; i++) lg.record('backend', `第 ${i} 条`);
  eq(lg.count(), ERROR_LOG_MAX_LINES, '环形保留上限');
  eq(lg.list(1)[0].message, `第 ${ERROR_LOG_MAX_LINES + 4} 条`, '只留最后若干行');
  appendFileSync(lg.path, 'not-json\n');
  eq(lg.list(5).length, 4, '坏行跳过：末尾坏行不计入');
  assert(lg.clear() >= ERROR_LOG_MAX_LINES, '清空返回行数');
  eq(lg.list(5).length, 0, '清空后无记录');
  rmSync(dir, { recursive: true, force: true });
});
await test('错误日志：kind 白名单归一化', () => {
  eq(normalizeErrorKind('frontend_unhandled'), 'frontend_unhandled');
  eq(normalizeErrorKind('frontend_crash'), 'frontend_crash');
  eq(normalizeErrorKind('backend_request'), 'backend_request');
  eq(normalizeErrorKind('http_guard'), 'http_guard', '守卫拒绝流量是独立 kind（留痕可查）');
  eq(normalizeErrorKind('任意字符串'), 'backend');
  eq(normalizeErrorKind(undefined), 'backend');
});
await test('错误日志脱敏：Authorization / api_key / sk- 密钥写入前清洗', () => {
  eq(sanitizeSecrets('Authorization: Bearer sk-abcdef1234567890abcdef'), 'Authorization: Bearer {redacted}', 'Bearer 头应只留方案词与键名');
  eq(sanitizeSecrets('x-api-key: abcdef123456 权限不足'), 'x-api-key: {redacted} 权限不足', 'api key 头应保留键名只换值');
  eq(sanitizeSecrets('raw sk-ant-api03-AAAAbbbbCCCCddddEEEEffff leaked'), 'raw {redacted} leaked', 'sk- 形态密钥应整串清洗');
  eq(sanitizeSecrets('{"headers":{"Authorization":"Bearer sk-xyz1234567890abcd"}}'), '{"headers":{"Authorization":"Bearer {redacted}"}}', 'JSON 内嵌请求头也应清洗');
  eq(sanitizeSecrets('standalone Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig here'), 'standalone Bearer {redacted} here', '任意位置的 Bearer 凭据应清洗');
});
await test('错误日志脱敏：URL 查询串与 userinfo 清洗，普通文本不误伤', () => {
  eq(sanitizeSecrets('POST https://api.example.com/v1/chat?api_key=SEKRET123&token=abc&model=x failed'),
    'POST https://api.example.com/v1/chat?api_key={redacted}&token={redacted}&model=x failed', '敏感查询参数应换值、普通参数保留');
  eq(sanitizeSecrets('connect https://user:pass@127.0.0.1:7890 refused'), 'connect https://{redacted}@127.0.0.1:7890 refused', 'URL userinfo 应清洗但保留主机排障');
  eq(sanitizeSecrets('普通中文错误：会话创建失败，请检查网络连接'), '普通中文错误：会话创建失败，请检查网络连接', '普通错误文本不应被误伤');
  eq(sanitizeSecrets('token 数超出上限'), 'token 数超出上限', '口语化 token 文案无键值结构，不误伤');
  eq(sanitizeSecrets('session 恢复失败'), 'session 恢复失败', 'session 关键词无赋值时不误伤');
});
await test('错误日志脱敏：幂等且先清洗后截断（截断不把密钥漏进日志）', () => {
  const dirty = 'Authorization: Bearer sk-abcdef1234567890abcdef';
  eq(sanitizeSecrets(sanitizeSecrets(dirty)), sanitizeSecrets(dirty), '重复清洗结果应稳定');
  const dir = mkdtempSync(join(tmpdir(), 'lc-errlog-redact-'));
  const lg = new ErrorLog(dir, { version: '9.9.9' });
  const row = lg.record('backend', `上游 401：${dirty}`, `stack: ${dirty}`);
  assert(!row.message.includes('sk-abcdef') && !row.detail.includes('sk-abcdef'), '落盘记录不得含密钥原值');
  assert(row.message.includes('{redacted}') && row.detail.includes('{redacted}'), '落盘记录应保留脱敏占位符');
  // 超长 detail：密钥藏在截断边界之后也应被先清洗掉
  const far = lg.record('backend', 'x', `${'x'.repeat(4090)}${dirty}`);
  assert(!far.detail.includes('sk-abcdef'), '先清洗后截断：边界之外的密钥也不得落盘');
  assert(far.detail.length <= 4096, '截断上限仍为 4KB');
  rmSync(dir, { recursive: true, force: true });
});
await test('错误日志去重器：同 key 窗口内只放行一次，过期后放行', () => {
  const dd = createDeduper(1000, 3);
  assert(dd.allow('a|b'), '首次放行');
  assert(!dd.allow('a|b'), '窗口内去重');
  assert(dd.allow('a|c'), '不同 key 放行');
  assert(dd.allow('a|b', Date.now() + 1500), '过期后重新放行');
});

// ---------- 单元测试: 用量统计视图 ----------
console.log('\n用量统计单元测试');
await test('账本 stats：近 N 天逐日补零、按模型 / 提供方 / 用途 / 会话构成并按费用排序', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-usage-stats-'));
  const u = new UsageLedger(dir);
  u.record({ kind: 'agent', requestId: 'r1', sessionId: 's1', model: 'LongCat-2.5-Preview', provider: 'builtin', inputTokens: 100, outputTokens: 20, cost: 0.01, purpose: 'turn' });
  u.record({ kind: 'agent', requestId: 'r2', sessionId: 's1', model: 'LongCat-2.5-Preview', provider: 'builtin', inputTokens: 200, outputTokens: 30, cost: 0.02, purpose: 'turn' });
  u.record({ kind: 'chat', requestId: 'r3', model: 'other-model', provider: 'p2', inputTokens: 10, outputTokens: 5, cost: 0.05 });
  const st = u.stats({ days: 7, top: 3 });
  eq(st.byDay.length, 7, '应按天补零，柱状图不断档');
  eq(st.byDay[6].requests, 3, '今天的请求应落在最后一天');
  eq(st.byDay[0].requests, 0, '无记录的日期补零');
  eq(st.byModel.length, 2, '按模型聚合');
  eq(st.byModel[0].key, 'other-model', '费用高的排前面');
  eq(st.byModel[0].cost, 0.05);
  eq(st.byProvider[0].key, 'p2', '按提供方聚合');
  const turnPurpose = st.byPurpose.find((x) => x.key === 'turn');
  eq(turnPurpose?.requests, 2, 'turn 用途应聚两条');
  assert(st.byPurpose.some((x) => x.key === 'chat'), '无 purpose 的速测请求回退 kind=chat');
  eq(st.bySession.length, 1, '会话构成只算 agent 请求');
  eq(st.bySession[0].key, 's1');
  const emptyDir = mkdtempSync(join(tmpdir(), 'lc-usage-empty-'));
  const empty = new UsageLedger(emptyDir).stats({ days: 2, top: 2 });
  eq(empty.byDay.length, 2, '空账本也应给足天数');
  eq(empty.byModel.length, 0, '空账本无构成');
  rmSync(dir, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

// ---------- 单元测试: 版本更新检查 ----------
console.log('\n版本更新单元测试');
await test('版本比较：三段语义、忽略 v 前缀与预发布后缀、非法值不误报', () => {
  eq(parseVersion('v7.0.1').join('.'), '7.0.1');
  eq(parseVersion('7.0').join('.'), '7.0.0', '缺 patch 段按 0');
  eq(parseVersion('垃圾'), null);
  assert(hasUpdate('7.0.0', '7.0.1'), '修订号更高应有更新');
  assert(hasUpdate('7.0.0', '7.1.0'), '次版本更高应有更新');
  assert(hasUpdate('7.0.0', '8.0.0-beta.1'), '主版本更高应有更新（含预发布后缀）');
  assert(!hasUpdate('7.0.1', '7.0.1'), '同版本不误报');
  assert(!hasUpdate('7.1.0', '7.0.9'), '更低版本不误报');
  assert(!hasUpdate('x', '7.0.1'), '本地版本非法不误报');
  assert(!hasUpdate('7.0.0', 'not-a-version'), '上游版本非法不误报');
});
await test('更新检查：走 GitHub latest、结果缓存 6 小时、失败不缓存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-update-'));
  let calls = 0;
  const ok = (tag) => async () => {
    calls += 1;
    return { ok: true, json: async () => ({ tag_name: tag, html_url: 'https://github.com/x/y/releases/tag/' + tag, published_at: '2026-09-01T00:00:00Z' }) };
  };
  const fail = async () => { calls += 1; return { ok: false, status: 403 }; };
  const first = await checkUpdate({ current: '7.0.0', dataDir: dir, fetchImpl: ok('v7.1.0'), now: () => 1000 });
  assert(first.ok && first.updateAvailable, '应发现新版本');
  eq(first.latest, '7.1.0');
  eq(first.url, 'https://github.com/x/y/releases/tag/v7.1.0');
  const cached = await checkUpdate({ current: '7.0.0', dataDir: dir, fetchImpl: fail, now: () => 1000 + 60_000 });
  eq(cached.cached, true, '6 小时内应命中缓存');
  eq(calls, 1, '命中缓存不应再请求');
  const expired = await checkUpdate({ current: '7.0.0', dataDir: dir, fetchImpl: ok('v7.2.0'), now: () => 1000 + 7 * 3600 * 1000 });
  eq(expired.cached, false, '过期后应重新请求');
  eq(expired.latest, '7.2.0');
  eq(calls, 2);
  const failed = await checkUpdate({ current: '7.0.0', dataDir: dir, fetchImpl: fail, now: () => 1000 + 14 * 3600 * 1000 });
  assert(!failed.ok && failed.error, '失败应返回错误文案且不抛');
  const afterFail = await checkUpdate({ current: '7.0.0', dataDir: dir, fetchImpl: ok('v7.2.0'), now: () => 1000 + 15 * 3600 * 1000 });
  eq(afterFail.latest, '7.2.0', '失败不写缓存，下次仍真实查询');
  // 本地版本号一变（升级 / 回滚 / 换代码重启），旧结论立刻作废
  const staleForNew = await checkUpdate({ current: '9.9.9', dataDir: dir, fetchImpl: fail, now: () => 1000 + 15 * 3600 * 1000 });
  eq(staleForNew.cached, false, '缓存 current 与本次不一致时不得命中');
  eq(calls, 5, '版本变化应重新请求上游');
  const refreshed = await checkUpdate({ current: '9.9.9', dataDir: dir, fetchImpl: ok('v9.9.8'), now: () => 1000 + 15 * 3600 * 1000 + 60_000 });
  eq(refreshed.cached, false, '重新查到新结论');
  eq(refreshed.latest, '9.9.8');
  eq(refreshed.updateAvailable, false, '上游更低不误报有更新');
  eq(calls, 6);
  rmSync(dir, { recursive: true, force: true });
});

// ---------- 单元测试: 消息队列（本地化 #3212 / #3220） ----------
console.log('\n消息队列单元测试');
await test('queue: 每会话 FIFO、opId 幂等、终态剪掉', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-queue-'));
  try {
    const q = new TurnQueue(dir);
    const a = q.enqueue('s1', { opId: 'a', text: '一', body: { input: '一' } });
    eq(a.position, 1, '首条位置为 1');
    eq(a.duplicate, false, '首次入队不重复');
    q.enqueue('s1', { opId: 'b', text: '二' });
    q.enqueue('s2', { opId: 'c', text: '别会话' });
    eq(q.list('s1').map((i) => i.opId).join(','), 'a,b', '按会话隔离且保持入队序');
    const dup = q.enqueue('s1', { opId: 'a', text: '一' });
    eq(dup.duplicate, true, '同 opId 重复入队只认既有项');
    eq(q.list('s1').length, 2, '重复入队不增长队列');
    eq(q.shift('s1').opId, 'a', 'shift 取队首');
    eq(q.list('s1').find((i) => i.opId === 'a').state, 'running', '摘牌后标记 running');
    eq(q.shift('s1').opId, 'b', '第二条可续摘');
    eq(q.shift('s1'), null, '队列空了返回 null');
    q.finish('s1', 'a', 'done');
    eq(q.list('s1').some((i) => i.opId === 'a'), false, '终态项从队列视图剪掉');
    eq(q.find('s1', 'a').state, 'done', '终态在内存里仍可查（供回执）');
    eq(newOpId().length > 10, true, 'opId 生成可用');
    const empty = new TurnQueue(join(dir, '不存在'));
    eq(empty.list('x').length, 0, '数据目录缺失按空队列处理');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('queue: 落盘恢复——running 回落 queued、held 保留、损坏文件静默回退', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-queue-'));
  try {
    const q = new TurnQueue(dir);
    q.enqueue('s1', { opId: 'run', text: '半路' });
    q.enqueue('s1', { opId: 'hold', text: '挂起' });
    q.enqueue('s1', { opId: 'gone', text: '终态' });
    q.shift('s1');
    q.setState('s1', 'hold', 'held');
    q.finish('s1', 'gone', 'done');
    const back = new TurnQueue(dir);
    eq(back.list('s1').map((i) => i.opId).join(','), 'run,hold', '重启后只剩未完结的项');
    eq(back.list('s1').find((i) => i.opId === 'run').state, 'queued', '进程被杀在半路的 running 回落 queued 由泵重跑');
    eq(back.list('s1').find((i) => i.opId === 'hold').state, 'held', '用户显式挂起的原样保留');
    eq(back.hasPending('s1'), true, '回落成 queued 的项应被泵看见');
    back.setState('s1', 'hold', 'queued');
    eq(back.shift('s1').opId, 'run', '恢复后按原队序续跑');
    // 损坏文件：不能因为 queue.json 坏掉挡住用户发言
    writeFileSync(join(dir, 'queue.json'), '{ 坏 JSON');
    const broken = new TurnQueue(dir);
    eq(broken.list('s1').length, 0, '损坏文件按空队列处理');
    broken.enqueue('s1', { opId: 'new', text: '还能说话' });
    eq(broken.list('s1').length, 1, '损坏后仍可正常入队并自愈落盘');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('queue-cmd: /queue 参数解析与展示行', () => {
  eq(parseQueueArg('').action, 'list', '无参列出');
  eq(parseQueueArg('  ').action, 'list', '空白按无参处理');
  eq(parseQueueArg('send 2').action, 'send', 'send 子命令');
  eq(parseQueueArg('send 2').index, 1, '序号转 0 based 索引');
  eq(parseQueueArg('drop 1').action, 'drop', 'drop 子命令');
  eq(parseQueueArg('rm 3').action, 'drop', 'rm 是 drop 的同义');
  eq(parseQueueArg('remove 3').action, 'drop', 'remove 是 drop 的同义');
  eq(parseQueueArg('SEND 2').action, 'send', '大小写不敏感');
  eq(parseQueueArg('clear').action, 'clear', 'clear 清空');
  eq(parseQueueArg('send').action, 'error', '缺序号报错');
  eq(parseQueueArg('send x').action, 'error', '非数字序号报错');
  eq(parseQueueArg('send 0').action, 'error', '序号从 1 开始');
  eq(parseQueueArg('bogus').action, 'error', '未知子命令报错');
  assert(parseQueueArg('send').message.includes('用法'), '报错应带用法');
  eq(formatQueueLines([])[0].includes('队列为空'), true, '空队列给可操作提示');
  const lines = formatQueueLines([{ text: '甲' }, { text: '乙' }]);
  eq(lines.length, 2, '一行一项');
  assert(lines[0].includes('1. 甲') && lines[1].includes('2. 乙'), '序号从 1 起且带文本');
  eq(pickQueueItem([{ text: '甲' }], 0).item.text, '甲', '按序号取项');
  assert(pickQueueItem([], 0).error.includes('队列为空'), '空队列取项报错');
  assert(pickQueueItem([{ text: '甲' }], 5).error.includes('超出范围'), '越界取项报错');
});

await test('queue: promote / remove / setState 语义', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-queue-'));
  try {
    const q = new TurnQueue(dir);
    q.enqueue('s1', { opId: 'a', text: '一' });
    q.enqueue('s1', { opId: 'b', text: '二' });
    q.enqueue('s1', { opId: 'c', text: '三' });
    q.promote('s1', 'c');
    eq(q.list('s1').map((i) => i.opId).join(','), 'c,a,b', 'promote 把选中项挪到队首');
    eq(q.shift('s1').opId, 'c', 'promote 后下一个就被泵接走');
    eq(q.list('s1').map((i) => i.opId).join(','), 'c,a,b', 'running 与 queued 都仍在队列视图里');
    q.finish('s1', 'c', 'done');
    eq(q.remove('s1', 'b'), true, 'remove 移除成功');
    eq(q.remove('s1', 'b'), false, '重复 remove 返回 false');
    eq(q.list('s1').map((i) => i.opId).join(','), 'a', '移除后只剩未跑的那条');
    eq(q.setState('s1', 'a', 'held').state, 'held', 'setState 可挂起');
    eq(q.hasPending('s1'), false, 'held 不算待跑');
    eq(q.setState('s1', 'nope', 'held'), null, '未知 opId 返回 null');
    eq(q.promote('s1', 'nope'), null, '未知 opId promote 返回 null');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- 单元测试: 定时任务（本地化 #3149） ----------
console.log('\n定时任务单元测试');

await test('cron-expr: 五段解析矩阵与下次运行时刻', () => {
  eq(isValidCron('0 9 * * *'), true, '每天 9 点合法');
  eq(isValidCron('*/5 * * * *'), true, '每 5 分钟合法');
  eq(isValidCron('0,30 9-17 * * 1-5'), true, '逗号列表与区间合法');
  eq(isValidCron('0 9 * * 7'), true, '周日可写 7');
  eq(isValidCron('0 0 30 2 *'), true, '2 月 30 日语法合法（无解由 computeNextRunAt 判）');
  eq(isValidCron('0 9 * *'), false, '段数不足');
  eq(isValidCron('61 9 * * *'), false, '分钟越界');
  eq(isValidCron('a 9 * * *'), false, '非数字段');
  eq(isValidCron('0 9 * * 8'), false, '周日越界（只到 7）');
  eq(isValidCron('5-2 9 * * *'), false, '区间反了');
  const next = nextCronRun('0 9 * * *', new Date(2026, 0, 15, 10, 0, 0).getTime());
  eq(new Date(next).getHours(), 9, '下一次应落在 9 点');
  eq(new Date(next).getDate(), 16, '10 点之后应落到次日');
  eq(nextCronRun('0 0 30 2 *'), null, '无解返回 null');
  // 日与周都是具体值时按 OR 语义（Vixie cron 约定）：1 月 5 日是周一，下一次就是 1 月 12 日周一
  const orNext = nextCronRun('0 0 1 * 1', new Date(2026, 0, 5, 12, 0, 0).getTime());
  eq(new Date(orNext).getDate(), 12, '日与周按 OR 语义：下一个周一即可，不必等 1 号');
  eq(nextCronRun('*/15 * * * *', new Date(2026, 0, 15, 10, 7, 0).getTime()) > new Date(2026, 0, 15, 10, 7, 0).getTime(), true, '下一次必须严格晚于基准');
  eq(parseCron('0 9 * * *').weekdays.length, 7, '周段星号展开为全 7 天');
});

await test('jobs store: 校验、纪元严格推进、到期挑选与落盘恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-jobs-'));
  try {
    const store = new JobStore(dir);
    let err = null;
    try { store.create({ name: '', sessionId: 's', prompt: 'p', schedule: { kind: 'cron', expr: 'bad' } }); } catch (e) { err = e; }
    assert(err instanceof JobValidationError, '非法草稿应抛 JobValidationError');
    let err2 = null;
    try { store.create({ name: 'x', sessionId: 's', prompt: 'p', schedule: { kind: 'interval', everyMs: 1000 } }); } catch (e) { err2 = e; }
    assert(err2 && err2.message.includes('60 秒'), '间隔下限应有中文说明');
    let err3 = null;
    try { store.create({ name: 'x', sessionId: 's', prompt: 'p' }); } catch (e) { err3 = e; }
    assert(err3 && err3.message.includes('执行计划'), '缺执行计划应说明');
    let err4 = null;
    try { store.create({ name: 'x', sessionId: 's', prompt: 'p', schedule: { kind: 'cron', expr: '0 0 30 2 *' } }); } catch (e) { err4 = e; }
    assert(err4 && err4.message.includes('永远不触发'), '语法合法但无解的表达式应被拒');
    const job = store.create({ name: '早报', sessionId: 's1', prompt: '汇总', schedule: { kind: 'cron', expr: '0 9 * * *' } });
    eq(job.enabled, true, '默认启用');
    assert(job.nextRunAt > Date.now(), 'nextRunAt 应在未来');
    // 纪元严格推进：同毫秒也算 +1，陈旧快照必然失配
    const a = store.update(job.id, () => ({ name: '早报甲' }));
    const b = store.update(job.id, () => ({ name: '早报乙' }));
    eq(b.updatedAt > a.updatedAt, true, 'updatedAt 必须严格递增');
    let stale = null;
    try { store.update(job.id, () => ({ name: '迟到的' }), { expectedUpdatedAt: a.updatedAt }); } catch (e) { stale = e; }
    assert(stale instanceof JobValidationError && stale.message.includes('已被其他操作修改'), '纪元不符应拒绝');
    eq(store.get(job.id).name, '早报乙', '被拒绝的变更不得生效');
    // 停用清空 nextRunAt，到期挑选只认启用的
    store.update(job.id, () => ({ enabled: false }));
    eq(store.get(job.id).nextRunAt, null, '停用后不再排下次');
    eq(store.due(Date.now() + 86400000).length, 0, '停用的任务不到期');
    const live = store.create({ name: '即时', sessionId: 's2', prompt: '跑', schedule: { kind: 'interval', everyMs: 60000 } });
    store.update(live.id, () => ({ nextRunAt: Date.now() - 1 }));
    eq(store.due().map((j) => j.id).join(','), live.id, '到期的应被挑出');
    store.recordRun(live.id, { status: 'ok' });
    eq(store.get(live.id).lastStatus, 'ok', '运行结果应记录');
    assert(store.get(live.id).nextRunAt > Date.now(), '记账后 nextRunAt 推进到未来');
    eq(store.due().length, 0, '记账后不再重复到期（重复执行是真金白银的 token）');
    // 落盘恢复：重启后任务还在，损坏文件按空表处理
    eq(new JobStore(dir).list().length, 2, '重启后任务应恢复');
    writeFileSync(join(dir, 'jobs.json'), '{ 坏 JSON');
    eq(new JobStore(dir).list().length, 0, '损坏文件按空任务表处理');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('computeNextRunAt / parseScheduleText / acquireOwnerLock 原语', async () => {
  // 间隔：基准 + everyMs，非法间隔（低于 60 秒）返回 null
  eq(computeNextRunAt({ kind: 'interval', everyMs: 60000 }, 1000), 61000, '间隔应加在基准上');
  eq(computeNextRunAt({ kind: 'interval', everyMs: 1000 }), null, '低于 60 秒的间隔不排');
  eq(computeNextRunAt({ kind: 'cron', expr: '0 0 30 2 *' }), null, '永不触发的 cron 不排');
  eq(computeNextRunAt({ kind: 'bogus' }), null, '未知类型不排');
  eq(parseScheduleText('every 30').everyMs, 1800000, 'every N 分钟转毫秒');
  eq(parseScheduleText('0 9 * * *').kind, 'cron', '五段视作 cron');
  eq(parseScheduleText('坏'), null, '无法解析返回 null');
  eq(parseScheduleText('every 0'), null, 'every 0 不合法');
  // owner 锁：O_EXCL 抢占、同进程防重入、跨进程 PID 探活、释放后可再抢
  const dir = mkdtempSync(join(tmpdir(), 'lc-jobs-'));
  try {
    const one = acquireOwnerLock(dir);
    eq(one.acquired, true, '首次应抢到');
    const again = acquireOwnerLock(dir);
    eq(again.acquired, false, '本进程已持锁，第二次抢不到（否则两个调度器都跑）');
    one.release();
    const afterRelease = acquireOwnerLock(dir);
    eq(afterRelease.acquired, true, '释放后可以再抢');
    afterRelease.release();
    // 跨进程：锁里写一个活着的别的进程的 PID（真实子进程，不用假数字）
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    writeFileSync(join(dir, 'jobs.lock'), String(child.pid));
    const blocked = acquireOwnerLock(dir);
    eq(blocked.acquired, false, '持锁方是活着的别的进程，抢不到');
    child.kill();
    await new Promise((r) => setTimeout(r, 150));
    const takeover = acquireOwnerLock(dir);
    eq(takeover.acquired, true, '持锁方已死，接管');
    takeover.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
  eq(MISSED_GRACE_MS, 6 * 3600 * 1000, '停机宽限期为 6 小时');
});

await test('jobs scheduler: owner 锁单实例——两个调度器只有一个真跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-jobs-'));
  try {
    const jobs = new JobStore(dir);
    const job = jobs.create({ name: '双跑防护', sessionId: 's', prompt: 'x', schedule: { kind: 'interval', everyMs: 60000 } });
    jobs.update(job.id, () => ({ nextRunAt: Date.now() - 1000 }));
    const ran = [];
    const mk = () => new JobScheduler(jobs, async (j) => { ran.push(j.id); }, { dataDir: dir, intervalMs: 20, log: () => {} });
    const first = mk();
    const second = mk();
    first.start();
    second.start();
    eq(first.isOwner, true, '先启动的应拿到 owner 锁');
    eq(second.isOwner, false, '后启动的不参与调度（端口交接期两实例共存）');
    await new Promise((r) => setTimeout(r, 250));
    eq(ran.length, 1, '同一任务只应被执行一次');
    first.stop();
    eq(second.isOwner, false, '旁观者按退避间隔才重试，不会立刻抢');
    second.stop();
    const third = mk();
    third.start();
    eq(third.isOwner, true, '锁释放后新的调度器可以接管');
    third.stop();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('jobs scheduler: 停机期间到期的任务先记 missed 再补跑', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-jobs-'));
  try {
    const jobs = new JobStore(dir);
    const job = jobs.create({ name: '停机', sessionId: 's', prompt: 'x', schedule: { kind: 'interval', everyMs: 60000 } });
    jobs.update(job.id, () => ({ nextRunAt: Date.now() - 7 * 3600 * 1000 }));
    const ran = [];
    const s = new JobScheduler(jobs, async () => { ran.push(1); }, { dataDir: dir, intervalMs: 20, log: () => {} });
    s.start();
    await new Promise((r) => setTimeout(r, 250));
    s.stop();
    eq(ran.length, 1, '仍应补跑一次');
    eq(jobs.get(job.id).lastStatus, 'missed', '应标记为停机错过而非按时成功');
    assert(jobs.get(job.id).lastError.includes('停机'), '应说明本次是补跑');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('定时任务到期跑通一条 mock turn（调度器驱动 runAgentTurn）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-jobs-'));
  try {
    const ws = join(dir, 'workspace');
    mkdirSync(ws, { recursive: true });
    const store = new SessionStore(dir);
    const usage = new UsageLedger(dir);
    const session = store.create({ name: '任务会话', model: 'm1', harness: 'standard', workspace: ws });
    const jobs = new JobStore(dir);
    const job = jobs.create({ name: '早报', sessionId: session.id, prompt: 'CRON_DUE_PROMPT', schedule: { kind: 'interval', everyMs: 60000 } });
    jobs.update(job.id, () => ({ nextRunAt: Date.now() - 1000 }));
    const seen = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts = {}) => {
      seen.push(JSON.parse(opts.body || '{}'));
      return sseResp(textFrames('早报已生成'));
    };
    const scheduler = new JobScheduler(jobs, async (j) => {
      await runAgentTurn({
        store, usage, session, input: j.prompt,
        provider: { id: 'p1', name: '测试', protocol: 'openai', baseUrl: 'https://up.test', apiKey: 'k' },
        model: 'm1', harness: getHarness('standard'), builtinPrice: { input: 2, output: 8 },
        emit: () => {}, controller: new AbortController(), log: () => {},
      });
    }, { dataDir: dir, intervalMs: 20, log: () => {} });
    try {
      scheduler.start();
      await new Promise((r) => setTimeout(r, 250));
    } finally { scheduler.stop(); globalThis.fetch = realFetch; }
    eq(jobs.get(job.id).lastStatus, 'ok', '到期后应记一次成功');
    assert(seen.some((b) => JSON.stringify(b.messages).includes('CRON_DUE_PROMPT')), 'prompt 应作为用户消息发给模型');
    assert(store.records(session.id).some((r) => r.t === 'user' && r.text === 'CRON_DUE_PROMPT'), '注入式 turn 应落进会话转录');
    assert(jobs.get(job.id).nextRunAt > Date.now(), 'nextRunAt 应被推进到未来');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('cron 工具: add/list/update/remove/run/get_time（假执行器）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-jobs-'));
  try {
    const jobs = new JobStore(dir);
    const ran = [];
    const tool = createCronRuntime(jobs, {
      sessionId: 'sess-1', runJob: async (j) => { ran.push(j.id); }, publish: () => {},
    }).tools[0];
    eq(tool.name, 'cron', '工具名应为 cron');
    eq(tool.action, 'cron', '权限 action 应为 cron');
    const created = await tool.run({ action: 'add', name: '巡检', prompt: '看看服务还在吗', schedule: { kind: 'interval', everyMs: 60000 } });
    assert(created.includes('已创建'), `add 回执应说明创建成功，实际：${created}`);
    const job = jobs.list()[0];
    eq(job.sessionId, 'sess-1', '未显式给 session_id 时落到当前会话');
    const list = await tool.run({ action: 'list' });
    assert(list.includes('巡检') && list.includes('每 60 秒'), 'list 应列出任务与计划');
    assert((await tool.run({ action: 'list', session_id: '别的会话' })).includes('没有定时任务'), 'list 按会话过滤');
    assert((await tool.run({ action: 'get_time' })).includes('当前时间'), 'get_time 应回当前时间');
    const upd = await tool.run({ action: 'update', job_id: job.id, enabled: false });
    assert(upd.includes('已更新'), `update 应生效，实际：${upd}`);
    eq(jobs.get(job.id).enabled, false, 'update 应真的停用');
    const runOut = await tool.run({ action: 'run', job_id: job.id });
    assert(runOut.includes('已立即执行'), `run 应经注入的执行器跑一次，实际：${runOut}`);
    eq(ran.length, 1, '执行器应被调用一次');
    eq(jobs.get(job.id).lastStatus, 'ok', 'run 后应记一次成功');
    assert((await tool.run({ action: 'remove', job_id: job.id })).includes('已删除'), 'remove 应删除');
    eq(jobs.list().length, 0, '删除后无任务');
    // 非法输入回中文原因而非抛异常：模型看得懂就能自己改对重试
    const badCron = await tool.run({ action: 'add', name: '坏', prompt: 'x', schedule: { kind: 'cron', expr: 'nope' } });
    assert(badCron.includes('创建失败') && badCron.includes('cron'), `非法 cron 应回中文原因，实际：${badCron}`);
    const badEvery = await tool.run({ action: 'add', name: '坏', prompt: 'x', schedule: { kind: 'interval', everyMs: 500 } });
    assert(badEvery.includes('60 秒'), '间隔下限应说清');
    eq(jobs.list().length, 0, '失败的创建不应落库');
    assert((await tool.run({ action: 'bogus' })).includes('未知操作'), '未知动作应提示可用集合');
    assert((await tool.run({ action: 'run', job_id: '不存在' })).includes('没有 id'), '未知任务 id 应说明');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('cron-cmd: /cron 参数解析、展示行与前缀取任务', () => {
  eq(parseCronArg('').action, 'list', '无参列出');
  eq(parseCronArg('  ').action, 'list', '空白按无参处理');
  eq(parseCronArg('help').action, 'help', 'help 子命令');
  const add = parseCronArg('add 早报 | 0 9 * * * | 汇总今天的待办');
  eq(add.action, 'add', 'add 子命令');
  eq(add.name, '早报', '名称取第一段');
  eq(add.schedule.kind, 'cron', 'cron 表达式');
  eq(add.schedule.expr, '0 9 * * *', '表达式原样保留');
  eq(add.prompt, '汇总今天的待办', '到期内容取第三段');
  const every = parseCronArg('add 巡检 | every 30 | 看看服务');
  eq(every.schedule.kind, 'interval', 'every N 解析为间隔');
  eq(every.schedule.everyMs, 1800000, '分钟转毫秒');
  eq(parseCronArg('add 早报 | 0 9 * * *').action, 'error', '缺段报错');
  assert(parseCronArg('add 早报 | 0 9 * * *').message.includes('用法'), '报错应带用法');
  assert(parseCronArg('add 早报 | 坏表达式 | 内容').message.includes('无法解析'), '表达式无法解析应说明');
  assert(parseCronArg('add 早报 | every 0 | 内容').message.includes('无法解析'), '间隔为 0 应拒绝');
  eq(parseCronArg('run').action, 'error', 'run 缺 id 报错');
  eq(parseCronArg('rm abc').action, 'remove', 'rm 是 remove 同义');
  eq(parseCronArg('off abc').action, 'off', 'off 停用');
  eq(parseCronArg('bogus').action, 'error', '未知子命令报错');
  eq(formatJobLines([])[0].includes('没有定时任务'), true, '空列表给可操作提示');
  const lines = formatJobLines([{ id: 'abcdef12-1111-2222', name: '早报', schedule: { kind: 'cron', expr: '0 9 * * *' }, enabled: true, nextRunAt: Date.now() + 3600000, lastStatus: 'ok' }]);
  assert(lines[0].includes('早报') && lines[0].includes('cron 0 9 * * *') && lines[0].includes('abcdef12'), '展示行应含名称、计划与 id 前缀');
  const picked = pickJob([{ id: 'abcdef12-1111' }, { id: 'zzzz9999-1111' }], 'ABCD');
  eq(picked.job.id, 'abcdef12-1111', '前缀匹配大小写不敏感');
  assert(pickJob([{ id: 'abc' }], 'zz').error.includes('没有 id'), '无命中给中文原因');
  assert(pickJob([{ id: 'abc' }, { id: 'abd' }], 'ab').error.includes('多写几位'), '多命中要求写更长前缀');
  assert(pickJob([], 'a').error.includes('id'), '空列表也要说清要 id');
});

await test('harness / policy / transcript: cron 门控与默认姿态', () => {
  eq(getHarness('minimal').tools.includes('cron'), false, 'minimal 不收 cron');
  eq(getHarness('standard').tools.includes('cron'), true, 'standard 收录 cron');
  eq(getHarness('ultimate').tools.includes('cron'), true, 'ultimate 收录 cron');
  eq(defaultRules().find((r) => r.action === 'cron').effect, 'ask', 'cron 默认询问（到期要花 token）');
  eq(new PermissionPolicy(defaultRules(), { permissionMode: 'never_ask' }).effective('cron', '*'), 'allow', 'never_ask 下放行');
  eq(new PermissionPolicy(defaultRules()).effective('cron', '*'), 'ask', '缺省档仍是询问');
  eq(toolLabel('cron'), '定时任务', 'cron 应有可读标签');
  eq(toolIconKey('cron'), 'clock', 'cron 应有图标键');
  assert(toolResourceOf('cron', { schedule: { kind: 'cron', expr: '0 9 * * *' } }).includes('0 9 * * *'), '资源摘要取表达式');
  const fake = [{ name: 'cron', description: 'x', parameters: { type: 'object' } }];
  eq(toolSchemas(getHarness('minimal').tools, fake).length, 0, 'minimal 不应把 cron 发上游');
  const withCron = toolSchemas(getHarness('standard').tools, fake);
  eq(withCron.length, toolSchemas(getHarness('standard').tools, []).length + 1, 'standard 应把 cron 发上游');
  assert(withCron.some((t) => t.function?.name === 'cron'), 'cron 的 OpenAI schema 应在请求里');
});

// ---------- e2e ----------
console.log('\n端到端测试（mock 上游 + 真实 socket）');
const mock = await startMock(MOCK_PORT);
const tmpPng = join(mkdtempSync(join(tmpdir(), 'lc-test-')), 'dot.png');
// 测试数据目录隔离：账本/配置只落临时目录，绝不写真实数据目录
const tmpDataDir = mkdtempSync(join(tmpdir(), 'lc-test-data-'));
writeFileSync(tmpPng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAACCRR8pAAAAC0lEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));

const child = spawn(process.execPath, ['web.mjs'], {
  cwd: join(__dirname, '..'),
  env: { ...process.env, AURORAAGENT_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, PORT: String(WEB_PORT), NO_OPEN: '1', AURORAAGENT_API_KEY: 'ak-test-key', LOG_LEVEL: 'error', AURORAAGENT_DATA_DIR: tmpDataDir, AURORAAGENT_EXPERIMENTAL_MCP: '1' },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1200));

try {
  await test('GET / 返回 AuroraAgent 工作台（React 构建产物）', async () => {
    const r = await fetch(`${BASE}/`);
    eq(r.status, 200);
    const html = await r.text();
    assert(html.includes('<title>AuroraAgent</title>'), '标题应为 AuroraAgent');
    assert(html.includes('id="root"'), '应返回应用挂载点');
    assert(html.includes('/app/assets/'), '应引用 /app 基准的资产路径');
    eq(await (await fetch(`${BASE}/index.html`)).text(), html, '/index.html 与 / 同一份产物');
    eq(await (await fetch(`${BASE}/app/`)).text(), html, '/app/ 与 / 同一份产物');
  });
  await test('构建产物契约：哈希资产存在、设计令牌在场、零 emoji', async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    const cssMatch = /\/app\/assets\/[A-Za-z0-9._-]+\.css/.exec(html);
    const jsMatch = /\/app\/assets\/[A-Za-z0-9._-]+\.js/.exec(html);
    assert(cssMatch && jsMatch, 'HTML 应引用 CSS 与 JS 资产');
    const css = await (await fetch(`${BASE}${cssMatch[0]}`)).text();
    const js = await (await fetch(`${BASE}${jsMatch[0]}`)).text();
    assert(css.includes('--accent:#4d8df6'), '设计令牌（强调蓝）应在构建产物中');
    assert(css.includes('--ok:') && css.includes('--danger:'), '语义色令牌应在场');
    const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
    assert(!emoji.test(css) && !emoji.test(js) && !emoji.test(html), '构建产物不应含 emoji');
  });
  await test('构建产物内置 KaTeX 公式渲染：样式、woff2 字体与回退样式都在场', async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    const cssUrl = /\/app\/assets\/[A-Za-z0-9._-]+\.css/.exec(html)[0];
    const css = await (await fetch(`${BASE}${cssUrl}`)).text();
    assert(css.includes('.katex{'), 'KaTeX 基础样式应打进产物');
    assert(css.includes('.katex-display{'), '显示公式样式应打进产物');
    assert(css.includes('.math-err{'), '公式解析失败的回退样式应打进产物');
    const font = /url\(([^)]+\.woff2)\)/.exec(css);
    assert(font, 'KaTeX 字体应以 woff2 引用（ttf/woff 回退不入库）');
    const fr = await fetch(`${BASE}${font[1]}`);
    eq(fr.status, 200, '字体资产应可服务');
    eq(fr.headers.get('content-type'), 'font/woff2', '字体应按 woff2 MIME 服务');
  });
  await test('公式渲染源码契约：不开 trust、异常回退源码、Markdown 已接入', () => {
    const latex = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'latex.tsx'), 'utf8');
    assert(latex.includes('trust: false'), '不得开启 trust：\\href / \\includegraphics / HTML 扩展必须被 KaTeX 拒绝');
    assert(latex.includes('throwOnError: true'), '解析异常必须可捕获');
    assert(latex.includes("output: 'htmlAndMathml'"), '应同时输出视觉排版与 MathML');
    assert(latex.includes('math-err'), '解析失败应回退展示原始源码');
    const md = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'markdown.tsx'), 'utf8');
    assert(md.includes("from './math-split.mjs'"), 'Markdown 渲染器应接入公式分段');
    assert(md.includes('isDisplayMathStart'), '段落累积应在显示公式块前断开');
    assert(md.includes('<MathView'), '显示公式应经 KaTeX 组件渲染');
  });
  await test('计划模式与权限三档源码契约：计划卡 / 权限选择器 / 计划开关在场', () => {
    const plan = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'PlanCard.tsx'), 'utf8');
    assert(plan.includes('批准执行') && plan.includes('驳回'), '计划卡应有批准 / 驳回动作');
    assert(plan.includes("decided: 'pending'") || plan.includes("plan.decided === 'pending'"), '计划卡应区分待决状态');
    const pickers = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ComposerPickers.tsx'), 'utf8');
    assert(pickers.includes('PERM_LABEL') && pickers.includes('always_ask') && pickers.includes('never_ask'), '输入区应有权限三档选择器');
    const composer = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Composer.tsx'), 'utf8');
    assert(composer.includes('composer-plan') && composer.includes('composer-plan-sep') && composer.includes('planMode'), '计划模式应在输入区作状态标记（开关已并入 /plan 斜杠命令）');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    assert(app.includes("case 'plan':") && app.includes('changePlan(arg !== '), 'App 应经 /plan on|off 切换计划模式');
    const te = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'turn-events.ts'), 'utf8');
    assert(app.includes('respondPlan') && (app + te).includes('plan_proposed') && (app + te).includes('plan_approved'), 'App 应接线计划决策回传与计划事件');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'tokens.css'), 'utf8');
    assert(css.includes('--diff-add:') && css.includes('--diff-del:'), 'tokens.css 应有 diff 语义令牌');
  });
  await test('通知与错误上报源码契约：toast 视口、全局捕获与崩溃兜底页', () => {
    const t = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'toast.tsx'), 'utf8');
    assert(t.includes('ToastViewport') && t.includes('useSyncExternalStore'), '应有 toast 视口与单例 store');
    assert(t.includes('toast-viewport') && t.includes('aria-live'), '视口应挂 aria-live 供读屏软件播报');
    assert(t.includes("role={t.level === 'error' ? 'alert' : 'status'}"), '错误通知应用 role=alert');
    assert(/VISIBLE_MAX = 4/.test(t) && t.includes('DEDUPE_WINDOW'), '应限同屏条数并对重复提示去重');
    assert(t.includes('items = items.map((t) => (t.id === hit.id') && !/hit\.repeat \+=/.test(t), '重复提示必须换新快照（useSyncExternalStore 靠引用变化重渲染），不能原地改');
    assert(!hasEmoji(t), 'toast 零 emoji 铁律');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    assert(app.includes('<ToastViewport />'), 'App 应挂通知视口');
    assert(app.includes("toast.error('切换模型失败'"), '操作类失败应走通知而非只写横幅');
    const rep = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'error-report.ts'), 'utf8');
    assert(rep.includes("addEventListener('error'") && rep.includes("addEventListener('unhandledrejection'"), '应装全局错误捕获');
    assert(rep.includes('/api/logs/errors'), '未捕获错误应上报服务端错误日志');
    assert(rep.includes('shouldReport'), '上报应去重，崩溃循环不刷屏');
    const bd = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'error-boundary.tsx'), 'utf8');
    assert(bd.includes('getDerivedStateFromError') && bd.includes('componentDidCatch'), '应有错误边界两个生命周期钩子');
    assert(bd.includes('重新加载') && bd.includes('复制详情'), '崩溃页应可重载与复制详情');
    assert(bd.includes('frontend_crash'), '渲染崩溃应记 frontend_crash');
    const main = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'main.tsx'), 'utf8');
    assert(main.includes('<AppErrorBoundary>') && main.includes('installGlobalErrorHandlers()'), '入口应包错误边界并装全局捕获');
    const sb = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'ScopedErrorBoundary.tsx'), 'utf8');
    assert(sb.includes('getDerivedStateFromError') && sb.includes('componentDidCatch'), '分区边界应有错误边界两个生命周期钩子');
    assert(sb.includes('resetKeys') && sb.includes('scope'), '分区边界应支持 resetKeys 自动恢复与 scope 归因');
    assert(sb.includes('重试') && sb.includes('重新加载') && sb.includes('role="alert"'), '分区兜底卡应可重试 / 重载并挂 alert 语义');
    assert(app.includes('<ScopedErrorBoundary scope="sidebar"') && app.includes('<ScopedErrorBoundary scope="main"'), '侧栏与主列应各包一层分区边界（单区崩溃不拖垮整棵工作台）');
    assert(rep.includes('scope') && rep.includes('作用域'), '错误上报应带作用域归因，落日志能定位崩在哪');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.toast-viewport') && css.includes('.crash-card'), '应有通知视口与崩溃页样式');
  });
  await test('首屏骨架源码契约：会话列表加载中不与空态混淆', () => {
    const sidebar = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Sidebar.tsx'), 'utf8');
    assert(sidebar.includes('loading') && sidebar.includes('sb-skel'), '侧栏应有加载骨架');
    assert(sidebar.includes('aria-busy'), '加载态应标记 aria-busy 供读屏软件感知');
    assert(sidebar.includes('!loading && sessions.length === 0'), '空态文案应在加载结束后才出现');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    assert(app.includes('setBooting(false)') && app.includes('loading={booting}'), 'App 应在会话列表回来后收起骨架');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.sb-skel-line') && css.includes('@keyframes shimmer'), '骨架应有微光动画');
    assert(css.includes('prefers-reduced-motion'), '动画应尊重系统减少动效设置');
  });
  await test('长会话性能源码契约：历史行延迟渲染、流式行不延迟', () => {
    const msg = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Message.tsx'), 'utf8');
    const view = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ChatView.tsx'), 'utf8');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(msg.includes('row row-user hist') && msg.includes('row row-ai hist'), '历史消息行应带 hist 标记');
    assert(!view.includes('row row-ai hist'), '流式 LiveRow 不能延迟渲染（内容在动，跳过绘制会闪）');
    assert(css.includes('content-visibility:auto') && css.includes('contain-intrinsic-size:auto 160px'), 'hist 行应 content-visibility 延迟渲染并记住上次高度');
  });
  await test('侧栏源码契约：像素级对齐 dsh web 的 SidebarRoot + WorkspaceBrowser 数值', () => {
    const sidebar = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Sidebar.tsx'), 'utf8');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    // 栏体：280px 宽 / 48px 顶部浮层带 + 12px 内容上距（ZCode h-12 拖拽带 + py-3）/ 基准字号 1rem（=界面字号，默认 14px）/ 专用填充
    assert(css.includes('width:280px'), '侧栏宽应为 dsh 的 280px');
    assert(css.includes('padding:60px 12px 6px; font-size:1rem;'), '侧栏应留 48px 浮层带 + 12px 内容上距并保持 dsh 基准字号（rem 化：1rem=界面字号）');
    assert(css.includes('background:var(--sidebar-fill)'), '侧栏应用专用填充色而非面板色');
    assert(!css.includes('.sidebar.rail'), '收回态不应再是 56px 图标导轨（ZCode 语义：左边整体消失，只留 Header）');
    // 侧栏填充必须拉满整列高：块容器里 .sidebar 的 height:auto 会塌成内容高，展开态下面留一大块空白
    assert(css.includes('.sb-panel {\n  display:flex;'), '侧栏裁剪容器应为 flex 行容器，让 .sidebar 沿交叉轴拉满高度');
    assert(css.includes('.sb-panel > .sidebar { flex:none; }'), '内层侧栏须定宽不收缩，收起才是「擦除」而不是「挤压」');
    assert(app.includes("localStorage.getItem('auroraagent.sidebar')") && app.includes("localStorage.setItem('auroraagent.sidebar'"), '收回偏好应落 localStorage（受控后持久化随状态上移到 App）');
    // ZCode 侧栏没有大 Logo：aside 首段是 48px 空拖拽带，品牌只在浮层切换钮里（左上角已有一枚）
    assert(!css.includes('.sb-logo') && !css.includes('.sb-brand'), '侧栏品牌行样式应随 ZCode 复刻退役（Logo 只在顶部浮层）');
    assert(!sidebar.includes('sb-brand') && !sidebar.includes('sb-logo'), 'Sidebar 不应再渲染品牌行（ZCode：展开态侧栏无大 Logo）');
    // 切换入口已整体迁到 WorkspaceTopOverlay（ZCode DesktopTopOverlay）
    assert(!css.includes('.sb-iconbtn'), '侧栏图标钮样式应随切换钮迁出而退役');
    assert(!sidebar.includes('IconPanelLeftClose') && !sidebar.includes('sb-rail') && !sidebar.includes('onToggleRail'), 'Sidebar 不应再有切换钮 / 56px 导轨分支 / onToggleRail prop');
    // 新建任务钮（ZCode NewTaskButtonGroup 像素级）：w-full h-8 rounded-lg ghost、pl-2.5 pr-2.5 gap-2，
    // MessageCirclePlus 16px +「新建任务」14px truncate + 右侧快捷键标签（12px 三次色 ml-auto）
    const newBtn = /\.sb-new \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['width:100%', 'height:32px', 'border-radius:8px', 'gap:8px', 'padding:0 10px', 'font-size:1rem', 'line-height:1.4286']) {
      assert(newBtn.includes(decl), `新建任务钮应按 ZCode NewTaskButtonGroup 数值声明 ${decl}`);
    }
    assert(!newBtn.includes('border:1px'), 'ZCode 新建任务钮是 ghost 无描边（不是旧 dsh 细描边钮）');
    assert(css.includes('.sb-new-key { flex:none; margin-left:auto; font-size:0.8571rem; line-height:1.3333; color:var(--faint); }'), '新建任务钮右侧快捷键标签应按 ZCode text-ui-xs 三次色声明（rem 化后 0.8571rem=12px）');
    assert(sidebar.includes('<IconMessageCirclePlus size={16} />') && sidebar.includes('>新建任务<') && sidebar.includes('sb-new-key') && sidebar.includes('newSessionLabel()'), '新建任务钮应含 MessageCirclePlus 图标 + 文案 + 快捷键标签');
    assert(!sidebar.includes('title="新会话"'), '按钮已自带文案与快捷键，不再挂重复 tooltip（ZCode 同款纪律）');
    // 会话区：36px 区头 + 可展开搜索 + 32px 行 / 圆角 8px / 行距 2px
    const head = /\.sb-sechead \{[^}]*\}/.exec(css)?.[0] || '';
    assert(head.includes('height:36px'), '区头高应为 dsh 的 36px');
    assert(css.includes('.sb-search.on') && css.includes('height:30px') && css.includes('border-radius:10px'), '搜索应可展开（dsh 30px / 圆角 10px）');
    assert(sidebar.includes('placeholder="搜索会话"') && sidebar.includes('setQ'), '会话列表应支持实时搜索过滤');
    const row = /\.sb-row \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['height:32px', 'border-radius:8px']) {
      assert(row.includes(decl), `会话行应按 dsh 数值声明 ${decl}`);
    }
    assert(css.includes('.sb-row + .sb-row { margin-top:2px; }'), '行距应为 dsh 的 2px');
    assert(css.includes('.sb-row-title { flex:1; min-width:0; font-size:1rem; line-height:1.4286;'), '行标题应按 dsh 14px/20px 省略（rem 化后 1rem / 1.4286）');
    assert(css.includes('.sb-row-time { flex:none; font-size:0.8571rem;'), '行时间应按 dsh 12px 三次色（rem 化后 0.8571rem=12px）');
    assert(css.includes('.sb-row:hover .sb-row-time') && css.includes('display:none'), '悬停时时间让位给操作钮（同 dsh）');
    assert(css.includes('.sb-row-acts { display:none;') && css.includes('.sb-row:hover .sb-row-acts'), '操作钮应悬停现形');
    // 栏脚：panelRow 形态设置入口（36px / 圆角 8px / padding 7px 8px）
    const foot = /\.sb-foot-row \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['min-height:36px', 'border-radius:8px', 'padding:7px 8px', 'gap:8px']) {
      assert(foot.includes(decl), `设置入口应按 dsh panelRow 数值声明 ${decl}`);
    }
    // 旧版侧栏类名应全部退役
    for (const dead of ['.brand {', '.newbtn {', '.sess-list {', '.sess-main {', '.mode-seg {', '.side-btn {', '.side-foot {']) {
      assert(!css.includes(dead), `旧侧栏样式 ${dead} 应退役`);
    }
    assert(!sidebar.includes('mode-seg') && !sidebar.includes('onHarness'), '模式切换应只在输入区（侧栏不再放模式分段控件）');
  });
  await test('快捷键平台标签：Apple 显示 ⌘B / ⌘K、其他平台 Ctrl+B / Ctrl+K', () => {
    eq(sidebarToggleLabel({ platform: 'MacIntel' }), '⌘B', 'macOS 应显示 ⌘B');
    eq(sidebarToggleLabel({ platform: 'Win32' }), 'Ctrl+B', 'Windows 应显示 Ctrl+B');
    eq(sidebarToggleLabel({ platform: 'Linux x86_64' }), 'Ctrl+B', 'Linux 应显示 Ctrl+B');
    eq(sidebarToggleLabel({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), '⌘B', 'UA 兜底应识别 Mac');
    eq(newSessionLabel({ platform: 'MacIntel' }), '⌘K', 'macOS 新建会话应显示 ⌘K');
    eq(newSessionLabel({ platform: 'Win32' }), 'Ctrl+K', 'Windows 新建会话应显示 Ctrl+K');
    eq(isAppleKeyboardPlatform({ platform: 'MacIntel' }), true, 'platform 命中 mac 应为 Apple 键盘平台');
    eq(isAppleKeyboardPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), false, 'Windows 不应判为 Apple');
  });
  await test('侧栏收回源码契约：ZCode 语义——左边整体消失只留 Header 与顶部浮层，200ms 擦除动画', () => {
    const header = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'WorkspaceHeader.tsx'), 'utf8');
    const overlay = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'WorkspaceTopOverlay.tsx'), 'utf8');
    const sidebar = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Sidebar.tsx'), 'utf8');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    const tip = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'ControlTooltip.tsx'), 'utf8');
    // 结构：侧栏不卸载但宽高归零 + 淡出（ZCode data-workspace-sidebar-panel）；
    // Header 常驻承载工作区上下文 / 标题 / 菜单，切换与新建等全局入口迁到常驻顶部浮层
    assert(app.includes('sb-panel') && app.includes('<WorkspaceHeader') && app.includes('<WorkspaceTopOverlay'), 'App 应把侧栏包进裁剪容器并渲染 WorkspaceHeader 与 WorkspaceTopOverlay');
    assert(app.includes('aria-hidden={rail || undefined}') && app.includes('inert={rail}'), '收回态侧栏应 aria-hidden + inert（不可见也不可聚焦）');
    assert(app.includes('collapsed={rail}'), 'Header 应收住态受控（collapsed 由 rail 驱动）');
    assert(app.includes('scope="header"') && app.includes('resetKeys={[currentId, rail]}'), 'Header 应自带分区错误边界（ZCode scope=workspace-header 同款，崩了不拖垮整列对话）');
    assert(app.includes('scope="top-overlay"'), '顶部浮层应自带分区错误边界');
    assert(header.includes('ws-head') && header.includes('ws-act') && header.includes('onOpenSettings'), 'Header 应自带工作区卡 / 标题 / 更多菜单 / 帮助 / 设置入口');
    assert(!sidebar.includes('sb-rail') && !sidebar.includes('rail ?'), 'Sidebar 不应再有 56px 导轨分支');
    // 动画规格：侧栏过渡 width / opacity 200ms ease-out，不许退回 all
    const panel = /\.sb-panel \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['width:280px', 'overflow:hidden', 'transition:width 200ms var(--ease), opacity 200ms var(--ease)']) {
      assert(panel.includes(decl), `侧栏裁剪容器应按 ZCode transition-[width,opacity] 声明 ${decl}`);
    }
    assert(css.includes('.sb-panel.off { width:0; opacity:0; pointer-events:none; }'), '收回态应宽高归零 + 淡出 + 断指针（ZCode collapsedSidebarWidthPx=0）');
    // Header 常驻 48px（ZCode h-12）：分隔线走 inset 阴影，不参与布局，与主区顶部严格对齐
    const head = /\.ws-head \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['height:48px', 'overflow:hidden', 'box-shadow:inset 0 -1px 0 var(--line)']) {
      assert(head.includes(decl), `Header 常驻态应按 ZCode h-12 + border-b 声明 ${decl}`);
    }
    assert(!css.includes('.ws-head.on'), 'Header 常驻后不应再有展开态类（不存在塌缩动画）');
    // ZCode WorkspaceHeader 内行：h-12 / p-2 / items-center / justify-between / gap-2 / overflow-hidden
    const row = /\.ws-head-row \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['display:flex', 'align-items:center', 'justify-content:space-between', 'gap:8px', 'height:48px', 'padding:8px', 'overflow:hidden', 'container-type:inline-size']) {
      assert(row.includes(decl), `Header 内行应按 ZCode h-12 + p-2 + gap-2 规格声明 ${decl}`);
    }
    // 左组 gap-1 / 右组 gap-0.5（WorkspaceHeaderTitleSection 与 WorkspaceHeaderActionSection）
    assert(css.includes('.ws-head-left { display:flex; align-items:center; gap:4px;'), 'Header 左组应按 ZCode gap-1 排布工作区卡与标题');
    assert(css.includes('.ws-head-right { display:flex; align-items:center; gap:2px;'), 'Header 右组应按 ZCode gap-0.5 排布');
    // 标题（ZCode TID_WORKSPACE_TITLE）：14px/600 + max-w 400 + 容器查询窄档 30vw/22vw + 双击重命名
    const title = /\.ws-title \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['max-width:400px', 'font-size:1rem', 'font-weight:600']) {
      assert(title.includes(decl), `会话标题应按 ZCode max-w-100 + text-ui-base 规格声明 ${decl}`);
    }
    assert(css.includes('@container (max-width:560px) { .ws-title { max-width:30vw; } }'), '标题窄档应按 ZCode @max-[560px] 收 30vw');
    assert(css.includes('@container (max-width:420px) { .ws-title { max-width:22vw; } }'), '标题更窄档应按 ZCode @max-[420px] 收 22vw');
    assert(header.includes('ws-title-input') && header.includes('onDoubleClick'), '标题应支持双击原位重命名（ZCode TaskRenameDialog 轻量替代）');
    // 帮助钮气泡（ZCode WorkspaceHelpMenuButton：ControlHintTooltip 包住 DropdownMenuTrigger）
    assert(header.includes("tip={{ title: '帮助' }}"), '帮助菜单触发器应挂「帮助」气泡（ZCode 同款：hover 即显）');
    // 工作区上下文卡：hover 即显 + 点击 pin，路径 home 缩写 + 最近活动 + git 分支（懒拉取按工作目录缓存）
    assert(header.includes('abbreviateHome') && header.includes('getWorkspace('), '工作区卡应经 abbreviateHome 缩写路径并按工作目录懒拉取 GET /api/workspace');
    assert(header.includes('ct-rich-rows') && header.includes('ctxHover') && header.includes('ctxPinned'), '工作区卡应支持 hover 即显 + 点击 pin（ZCode workspaceContextOpen 受控模式）');
    // 入口钮统一 Button ghost icon-md：28px + rounded-lg + 只过渡颜色，图标 size-4
    const act = /\.ws-act \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['width:28px', 'height:28px', 'border-radius:8px', 'transition:background-color 150ms var(--ease), color 150ms var(--ease)']) {
      assert(act.includes(decl), `入口钮应按 ZCode ghost icon-md 规格声明 ${decl}`);
    }
    assert(header.includes('<IconGear size={16} />'), '设置入口应按 ZCode size-4 图标规格');
    assert(header.includes('<IconFolder size={16} />') && header.includes('<IconEllipsis size={16} />') && header.includes('<IconCircleHelp size={16} />'), '工作区卡 / 更多菜单 / 帮助菜单触发器应按 size-4 图标规格');
    // 帮助菜单面板导航：快捷键 / 关于 / 返回项必须 preventDefault，否则「选中即关」会把菜单关掉
    assert((header.match(/setHelpPane\('shortcuts'\)/g) || []).length >= 1 && header.includes("onSelect={(e) => { e.preventDefault(); setHelpPane('shortcuts'); }}"), '快捷键面板导航应阻止关菜单');
    assert(header.includes("onSelect={(e) => { e.preventDefault(); setHelpPane('about'); }}") && header.includes("onSelect={(e) => { e.preventDefault(); setHelpPane('root'); }}"), '关于与返回面板导航应阻止关菜单');
    assert(header.includes('side="bottom"'), 'Header 气泡应在按钮下方（ZCode side=bottom）');
    // 顶部浮层（ZCode DesktopTopOverlay）：切换 / 上一个 / 下一个 / 新建 / 更新全在这
    assert(overlay.includes('ws-overlay') && overlay.includes('ws-overlay-group') && overlay.includes('ws-overlay-new'), '浮层应按 ZCode DesktopTopOverlay 结构组织');
    // 新建任务图标：ZCode 用 lucide MessageCirclePlus（聊天气泡 + 加号），不是裸加号
    assert(overlay.includes('<IconMessageCirclePlus size={16} />') && overlay.includes('aria-label="新建任务"'), '浮层新建任务应按 ZCode 用 MessageCirclePlus 图标与「新建任务」文案');
    const icons = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'icons.tsx'), 'utf8');
    assert(icons.includes('IconMessageCirclePlus') && icons.includes('M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29'), 'MessageCirclePlus 应取 lucide 1.17.0 精确路径（ZCode 同版本）');
    assert(overlay.includes('<IconMessageCirclePlus size={16} />') && overlay.includes('newSessionLabel()'), '新建任务钮应带 MessageCirclePlus 图标与 ⌘K/Ctrl+K 快捷键提示（对齐 ZCode newTaskShortcutLabel）');
    assert(overlay.includes('IconArrowLeft') && overlay.includes('IconArrowRight'), '浮层左组应有后退 / 前进箭头（ZCode taskNav 形态）');
    assert(overlay.includes('canBack') && overlay.includes('canForward') && overlay.includes('onBack') && overlay.includes('onForward'), '后退 / 前进应各自由 canBack / canForward 门控（栈首 / 栈尾禁用）');
    assert(overlay.includes('title="后退"') && overlay.includes('title="前进"'), '箭头气泡应是「后退 / 前进」，不是消息内的上一条 / 下一条');
    assert(overlay.includes('navBackLabel()') && overlay.includes('navForwardLabel()'), '后退 / 前进气泡应带快捷键键帽（⌘[ / ⌘]，与 ZCode navigateBack / navigateForward 同键位）');
    assert(overlay.includes('IconPanelLeftOpen') && overlay.includes('IconPanelLeftClose'), '切换钮应按 ZCode SidebarToggleIcon 语义取「打开 / 关闭面板」双图标');
    assert(overlay.includes('ControlTooltip') && overlay.includes('title="切换侧边栏"') && overlay.includes('sidebarToggleLabel()'), '浮层切换钮应挂 ControlTooltip 并带快捷键标签');
    assert(overlay.includes('updateUrl') && overlay.includes('ws-upd'), '发现新版本时浮层应出现更新入口（ZCode 教训：收回态不能按宽度阈值隐藏全局更新入口）');
    assert(css.includes('.ws-overlay { position:absolute; left:0; top:0; height:48px; z-index:20; pointer-events:none;'), '浮层应常驻 absolute 定位且外层不吃事件（空白处点击归侧栏）');
    assert(css.includes('.ws-overlay-new.on { width:28px; opacity:1; }') && css.includes('transition:opacity 300ms var(--ease), width 300ms var(--ease)'), '新建钮应按 ZCode isNewTaskButtonVisible 语义做 opacity/width 300ms 过渡');
    assert(app.includes('overlayInset={overlayW}'), 'Header 收回态应按实测浮层宽让位（ZCode shouldOffsetHeaderForWindowControls 同思路）');
    // 侧栏顶部留出 48px 浮层带（ZCode overlay h-14 盖住侧栏顶部同款）
    assert(css.includes('padding:60px 12px 6px; font-size:1rem;'), '侧栏应留 48px 浮层带 + 12px 内容上距（ZCode h-12 拖拽带 + py-3；rem 化后 1rem=界面字号）');
    assert(css.includes('.app { position:relative;'), '布局根应 relative 让浮层绝对定位有锚点');
    // App 侧接线：浮层宽实测 / 窄窗自动收起 / 更新检查 / 导航请求 / 重命名
    assert(app.includes('overlayW') && app.includes('ResizeObserver'), 'App 应实测浮层宽度供 Header 让位');
    // 浮层是 absolute：外包 flex 容器零宽，ref 必须直挂浮层根节点，否则实测恒 0、Header 让位失效
    assert(/WorkspaceTopOverlay\s+ref=\{overlayRef\}/.test(app), '浮层 ref 应直挂 WorkspaceTopOverlay 根节点（量外包容器恒为 0）');
    assert(overlay.includes('ref={ref}') && overlay.includes('ref?: Ref<HTMLDivElement>'), '浮层组件应声明并透出根节点 ref');
    assert(app.includes('mainRef') && app.includes('360'), '主列过窄时应自动收回侧栏（ZCode AUTO_COLLAPSE 阈值 360px 同款）');
    assert(app.includes('checkUpdate') && app.includes('UpdateInfo'), 'App 进页面应拉一次版本更新状态');
    assert(!app.includes('navReq') && !app.includes('requestNav'), '浮层箭头改后退 / 前进（会话导航历史）后，消息内导航不再需要外部请求管道——梯状轨自己的点击 / 悬浮即入口');
    assert(app.includes('renameCurrent') && app.includes('patchSession(current.id, { name })'), 'Header 重命名应走 PATCH 落 meta');
    assert(!/\.ws-head[^{]*\{[^}]*transition:all/.test(css) && !/\.sb-panel[^{]*\{[^}]*transition:all/.test(css), '过渡必须显式枚举属性，不许 transition:all（ZCode 同款教训）');
    assert(css.includes('prefers-reduced-motion: reduce) { .sb-panel, .ws-overlay-new'), '减弱动效下侧栏擦除与浮层过渡应直接跳终态');
    // 浮层切换钮：ZCode DesktopTopOverlay 那枚 ghost 方钮（logo / 图标两层叠加 + 「打开 / 关闭面板」语义）
    const btn = /\.ws-toggle \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['width:28px', 'height:28px', 'border-radius:8px', 'position:relative', 'overflow:hidden']) {
      assert(btn.includes(decl), `切换钮应按 ZCode rounded-lg 规格声明 ${decl}`);
    }
    const logo = /\.ws-toggle-logo \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['width:20px', 'height:20px', 'border-radius:6px']) {
      assert(logo.includes(decl), `非 hover 态品牌砖应按 ZCode size-5 规格声明 ${decl}`);
    }
    const icon = /\.ws-toggle-icon \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['position:absolute', 'inset:0', 'margin:auto', 'width:16px', 'height:16px']) {
      assert(icon.includes(decl), `面板图标应绝对居中且按 ZCode size-4 规格声明 ${decl}`);
    }
    assert(css.includes('.ws-toggle:hover .ws-toggle-logo { opacity:0; }'), 'hover 时品牌砖应淡出（group-hover:opacity-0 同义）');
    assert(css.includes('.ws-toggle:hover .ws-toggle-icon { opacity:1; }'), 'hover 时面板图标应淡入');
    // 气泡工程与视觉：portal 单例 root、role=tooltip、Esc 可关、8px 圆角壳、16px 键帽
    assert(tip.includes('createPortal') && tip.includes("root.id = 'tooltip-root'"), '气泡应经 portal 挂模块级单例 root（绕开 overflow 裁剪，别按实例建上下文）');
    assert(tip.includes('role="tooltip"') && tip.includes("e.key === 'Escape'"), '气泡应有 role=tooltip 且 Esc 可关');
    // 退出动画期间必须保留上次定位与挂载：清了会让气泡瞬间跳到 left/top 0，而 visibility 过渡
    // 会让它在左上角继续被绘制满 120ms——就是「移出触发区时 tooltip 闪现」的根因
    assert(!/setPos\(null\)/.test(tip), '退出态不得清空定位（淡出必须发生在按钮原地）');
    assert(tip.includes('if (!render) return;') && tip.includes('setRender(false), FADE_MS'), '退出态应保留挂载与定位 120ms 后卸载');
    assert(tip.includes("data-phase={visible ? 'in' : 'out'}"), '进入 / 退出相位应由 visible 驱动');
    assert(css.includes('@starting-style') && css.includes('.ct-tip[data-phase="out"]'), '进入 / 退出动画应由 CSS @starting-style 与 data-phase 承担');
    // 富内容卡与受控模式：ZCode 工作区上下文卡（ControlHintTooltip 的 open/onOpenChange + popover content）
    assert(tip.includes('rich = typeof title') && tip.includes('ct-tip-rich'), 'title 传节点应切富内容卡变体');
    assert(tip.includes('onOpenChange?.(true)') && tip.includes('onOpenChange?.(false)'), '受控模式应把开合交给消费方（ZCode workspaceContextOpen 模式）');
    assert(tip.includes("align === 'start'") && tip.includes("align === 'end'"), '水平对齐应支持 start / center / end（ZCode align=start）');
    // ref 组合：触发器可能已带 ref（Menu 克隆出的 trigger 要量定位），覆盖会让消费方拿不到节点
    assert(tip.includes('composedRef') && tip.includes("child.props as { ref?: Ref<HTMLElement> }"), 'ControlTooltip 应组合子元素既有 ref（ZCode setRef 同款教训）');
    assert(css.includes('.ct-tip-rich {') && css.includes('width:288px') && css.includes('background:var(--panel)'), '富内容卡应按 ZCode w-72 popover 规格（--panel 底、288px、12px 距）');
    assert(css.includes('.ct-rich-row.git { border-top:1px solid var(--line); padding-top:12px; }'), 'git 行应有顶部分隔（ZCode border-t pt-3）');
    assert(!tip.includes('requestAnimationFrame'), '组件不应自行 rAF 驱动动画（交给合成器）');
    const shell = /\.ct-tip \{[^}]*\}/.exec(css)?.[0] || '';
    assert(shell.includes('border:1px solid var(--tooltip-line)') && shell.includes('border-radius:8px') && shell.includes('background:var(--tooltip-bg)'), '气泡壳应按 ZCode 规格 1px 边框 + 8px 圆角 + tooltip 令牌底');
    const kbd = /\.ct-kbd \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['height:16px', 'border-radius:6px', 'background:var(--kbd-bg)']) {
      assert(kbd.includes(decl), `快捷键键帽应按 ZCode 规格声明 ${decl}`);
    }
    // 快捷键绑定与持久化：Cmd/Ctrl+B 切换收回态，偏好随受控状态落 App
    assert(app.includes("e.key.toLowerCase() === 'b'") && app.includes('setRail((v) => !v)'), 'App 应绑 Cmd/Ctrl+B 切换收回态');
    assert(app.includes('toggleRail') && app.includes('onToggle={toggleRail}'), 'App 应持有收回态并把切换回调注入顶部浮层');
    const tokens = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'tokens.css'), 'utf8');
    assert(tokens.includes('--tooltip-bg:') && tokens.includes('--kbd-bg:') && tokens.includes('--tooltip-ink:') && tokens.includes('--kbd-ink:'), 'tokens.css 双主题应提供 tooltip / kbd 令牌');
    assert((tokens.match(/--tooltip-bg:/g) || []).length === 2 && (tokens.match(/--kbd-bg:/g) || []).length === 2, 'tooltip / kbd 令牌应深浅双主题各一份');
  });

  await test('菜单组件源码契约：零依赖 Menu 复刻 ZCode DropdownMenu 交互与视觉', () => {
    const menu = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'Menu.tsx'), 'utf8');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(menu.includes('createPortal') && menu.includes("root.id = 'menu-root'"), '菜单应经 portal 挂模块级单例 root（与气泡同一思路，别按实例建上下文）');
    assert(menu.includes('role="menu"') && menu.includes("'aria-haspopup': 'menu'"), '触发器应挂 aria-haspopup 与 role=menu');
    assert(menu.includes("'aria-expanded': open"), '触发器应同步 aria-expanded');
    assert(menu.includes("e.key === 'Escape'") && menu.includes('triggerRef.current?.focus()'), 'Esc 应关闭并把焦点还给触发器');
    assert(menu.includes("e.key === 'ArrowDown'") && menu.includes("e.key === 'ArrowUp'") && menu.includes("e.key === 'Home'") && menu.includes("e.key === 'End'"), '键盘应支持上下移动与 Home / End');
    assert(menu.includes("e.key === 'Enter'") && menu.includes("e.key === ' '"), '回车与空格应触发激活项');
    assert(menu.includes("e.key === 'Tab'"), 'Tab 应关闭菜单（焦点继续走表单序）');
    assert(menu.includes('pointerdown') && menu.includes('contains(t)'), '点外面应关闭（trigger 与菜单内不算外面）');
    // 选中即关 + preventDefault 例外：复刻 Radix DropdownMenuItem onSelect 语义——
    // Header 帮助菜单的面板导航（快捷键 / 关于 / 返回）靠它在菜单内切面板而不关菜单
    assert(menu.includes('MenuItemSelectEvent') && menu.includes('preventDefault: () => { prevented = true; }'), 'onSelect 应收到可 preventDefault 的事件');
    assert(menu.includes('if (!prevented) menu?.close();'), '仅当 onSelect 未 preventDefault 时才关菜单');
    assert(menu.includes('[role="menuitem"]:not([disabled])'), '键盘导航应跳过禁用项');
    // 触发器气泡（tip）：复刻 ZCode「ControlHintTooltip 包住 DropdownMenuTrigger」；
    // 菜单开着时传 open=false 压掉气泡，避免与下方菜单重叠
    assert(menu.includes('tip?: { title: string; shortcut?: string }') && menu.includes('<ControlTooltip title={tip.title}'), 'Menu 应支持 tip 属性把气泡包到触发器上');
    assert(menu.includes('open={render && open ? false : undefined}'), '菜单开着时应压掉触发器气泡（同朝下方会重叠）');
    // 退出动画保留挂载：与 tooltip 闪现修复同源的教训——退出态保留定位，淡出在原地发生
    assert(menu.includes('setRender(false), FADE_MS') && menu.includes("data-phase={open ? 'in' : 'out'}"), '退出动画期间应保留挂载与定位');
    assert(!/transition:all/.test(menu), '组件不许退回 transition:all');
    assert(!hasEmoji(menu), '菜单组件零 emoji');
    const pop = /\.menu-pop \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['border-radius:12px', 'border:1px solid var(--line-strong)', 'background:var(--panel)', 'box-shadow:var(--shadow-pop)', 'padding:6px']) {
      assert(pop.includes(decl), `菜单壳应按 mpick 词汇声明 ${decl}`);
    }
    assert(css.includes('@starting-style { .menu-pop[data-phase="in"]') && css.includes('.menu-pop[data-phase="out"]'), '进入 / 退出动画应由 @starting-style 与 data-phase 承担');
    assert(/transition:opacity 120ms var\(--ease\), transform 120ms var\(--ease\), visibility 120ms/.test(pop), '菜单过渡应显式枚举 opacity / transform / visibility，不退回 all');
    const item = /\.menu-item \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['border-radius:8px', 'padding:8px 10px', 'font-size:0.9286rem']) {
      assert(item.includes(decl), `菜单项应按 ZCode 紧凑密度声明 ${decl}`);
    }
    assert(css.includes('.menu-item.danger { color:var(--danger-ink); }'), '危险项（删除会话）应走 danger 令牌');
    assert(css.includes('#menu-root { position:fixed; left:0; top:0; z-index:130; pointer-events:none; }'), '菜单 root 应常驻视口且不抢指针（z-index 高于气泡的 120）');
  });

  await test('回合导航条目构建：按 turn 聚合并助手摘录、相邻提问共享、运行态仅最后一项', () => {
    const items = buildTurnNavItems([
      { kind: 'user', key: 'u0', text: '第一问' },
      { kind: 'assistant', key: 'a0', parts: [{ kind: 'text', text: '第一答' }, { kind: 'tool' }] },
      { kind: 'user', key: 'u1', text: '第二问' },
      { kind: 'assistant', key: 'a1', parts: [{ kind: 'tool' }] },
      { kind: 'user', key: 'u2', text: '第三问' },
    ], { running: true });
    eq(items.length, 3, '每条用户行应成一个导航项（助手 / 系统行不成项）');
    eq(items[0].key, 'u0');
    eq(items[0].userPreview, '第一问');
    eq(items[0].assistantPreview, '第一答', '助手预览应取同一用户轮的文本段');
    eq(items[0].assistantKind, 'text');
    eq(items[0].running, false);
    eq(items[1].assistantPreview, '暂无助手正文', '无文本的助手轮应回落空态文案');
    eq(items[1].assistantKind, 'empty');
    eq(items[2].running, true, '运行态只应标在最后一项');
    eq(items[2].assistantPreview, '助手仍在工作');
    eq(items[2].assistantKind, 'running');
    eq(buildTurnNavItems([{ kind: 'user', key: 'u0', text: '   ' }])[0].userPreview, '用户输入', '空提问应回落兜底文案');
    eq(buildTurnNavItems([]).length, 0, '空转录应无导航项');
    // 相邻且尚未得到回复的提问归入同一 turn，共享该 turn 的助手摘录（复刻 ZCode render-unit 语义）
    const merged = buildTurnNavItems([
      { kind: 'user', key: 'u0', text: '问甲' },
      { kind: 'user', key: 'u1', text: '问乙' },
      { kind: 'assistant', key: 'a0', parts: [{ kind: 'text', text: '合并答复' }] },
      { kind: 'user', key: 'u2', text: '问丙' },
    ]);
    eq(merged.length, 3, '相邻未回复提问仍逐条成项');
    eq(merged[0].assistantPreview, '合并答复', '同一 turn 的多条提问应共享该 turn 的助手摘录');
    eq(merged[1].assistantPreview, '合并答复', '相邻提问共享助手摘录（对齐 ZCode product turn 聚合）');
    eq(merged[2].assistantPreview, '暂无助手正文', '已收尾 turn 之后的新提问应重新计轮');
    // 流式进行中：已产出的文本并入最后一个 turn 的摘录
    const streaming = buildTurnNavItems([
      { kind: 'user', key: 'u0', text: '第一问' },
      { kind: 'assistant', key: 'a0', parts: [{ kind: 'text', text: '第一答' }] },
      { kind: 'user', key: 'u1', text: '第二问' },
    ], { running: true, liveParts: [{ kind: 'text', text: '正在流出的答复' }, { kind: 'tool' }] });
    eq(streaming[1].assistantPreview, '正在流出的答复', '流式已产出文本应并入最后一项摘录');
    eq(streaming[1].running, true, '运行态只应标在最后一项');
    eq(streaming[1].assistantKind, 'text', '已有流式正文时应按 text 呈现而非 running 占位');
    // 系统行（上下文压缩摘要）不成项但切分 turn；notice 回执不成项也不切分
    const marked = buildTurnNavItems([
      { kind: 'system', key: 's0', text: '早期对话摘要' },
      { kind: 'user', key: 'u0', text: '问甲' },
      { kind: 'assistant', key: 'a0', parts: [{ kind: 'text', text: '答甲' }] },
      { kind: 'notice', key: 'n0', text: '已切换提供方' },
      { kind: 'user', key: 'u1', text: '问乙' },
    ]);
    eq(marked.length, 2, '系统行与 notice 回执都不成项');
    eq(marked[0].assistantPreview, '答甲', '压缩摘要之后的提问正常配对');
    eq(marked[1].assistantPreview, '暂无助手正文', 'notice 之后的提问应重新计轮');
    eq(buildTurnNavItems([
      { kind: 'assistant', key: 'a0', parts: [{ kind: 'text', text: '孤儿答复' }] },
      { kind: 'user', key: 'u0', text: '问' },
    ]).length, 1, '无用户提问的助手段不成项（对齐 ZCode realUserInputs 为空即跳过）');
  });
  await test('回合导航预览文本：段落归一与 220 字截断', () => {
    eq(normalizePreviewText('  第一段   含   折叠空白  \n\n 第二段 \n\n 第三段 '), '第一段 含 折叠空白\n第二段', '最多保留 2 段且段内空白折叠');
    const cut = normalizePreviewText('x'.repeat(300));
    eq(cut.length, 220, '超长预览应截到 220 字');
    assert(cut.endsWith('...'), '截断应加省略号');
    eq(normalizePreviewText('短文本'), '短文本', '短文本原样返回');
    eq(normalizePreviewText(undefined), '', 'undefined 应安全返回空串');
  });
  await test('回合导航悬浮山峰视觉：距焦点 0/1/2/3+ 的透明度与缩放', () => {
    const peak = resolveBarVisualState(3, 3);
    eq(peak.tone, 'peak'); eq(peak.colorTone, 'focus'); eq(peak.opacity, 1); eq(peak.scaleX, 2.6);
    const near = resolveBarVisualState(4, 3);
    eq(near.tone, 'near'); eq(near.opacity, 0.86); eq(near.scaleX, 1.7);
    const mid = resolveBarVisualState(5, 3);
    eq(mid.tone, 'mid'); eq(mid.opacity, 0.72); eq(mid.scaleX, 1.25);
    const idle = resolveBarVisualState(9, 3);
    eq(idle.tone, 'idle'); eq(idle.opacity, 0.58); eq(idle.scaleX, 1);
    eq(resolveBarVisualState(2, 3).tone, 'near', '距离应取绝对值（焦点上方同样衰减）');
    eq(resolveBarVisualState(1, 3).tone, 'mid', '距焦点 2 格应回落 mid');
    eq(resolveBarVisualState(3, undefined).opacity, 0.58, '无悬浮 / 焦点时应全部回落静止态');
  });
  await test('回合导航活动条目与虚拟窗口：视口内取距顶最近、越界钳制', () => {
    const positions = [0, 1, 2, 3].map((i) => ({ index: i, start: i * 500, end: i * 500 + 400 }));
    eq(resolveActiveItemIndex(positions, 1050, 600), 2, '视口内应取距滚动顶部最近的行');
    eq(resolveActiveItemIndex(positions, 120, 600), 0);
    eq(resolveActiveItemIndex(positions, 5000, 600), 3, '视口下方应取上方最后一个');
    eq(resolveActiveItemIndex([], 0, 600), -1, '空位置表应回 -1');
    const range = resolveVisibleRange(100, 250, 300);
    eq(range.start, 19, '窗口起点应减 overscan');
    eq(range.end, 61, '窗口终点应加 overscan');
    const clamped = resolveVisibleRange(5, 0, 300);
    eq(clamped.end, 5, '窗口不越界');
    eq(resolveVisibleRange(0, 0, 300).end, 0, '零条目不渲染');
    eq(resolveRailScrollTopForActive(30, 0, 300), 155, '活动项在可视带外时应滚到居中附近');
    eq(resolveRailScrollTopForActive(3, 0, 300), 0, '活动项已在带内则不动');
  });
  await test('回合导航源码契约：复刻 ZCode ConversationTurnNavigator 的离散梯状历史轨', () => {
    const nav = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'TurnNavigator.tsx'), 'utf8');
    const chat = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ChatView.tsx'), 'utf8');
    const msg = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Message.tsx'), 'utf8');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(chat.includes('chat-wrap') && chat.includes('<TurnNavigator'), '对话区应包定位包裹层并挂回合导航');
    assert(msg.includes('data-turn-key={msg.key}'), '用户行应带 data-turn-key 供跳转定位');
    assert(nav.includes('items.length >= 2') && nav.includes('TURN_NAV_MIN_WIDTH'), '少于 2 问不渲染、窄于 864px 不渲染');
    assert(nav.includes('resolveVisibleRange') && nav.includes('resolveRailScrollTopForActive'), '应有虚拟窗口与活动项跟进');
    assert(nav.includes('resolveBarVisualState') && nav.includes('scaleX('), '梯状山峰应走距离衰减 + 横向缩放');
    assert(nav.includes('liveParts'), '流式已产出文本应并入最后一项摘录');
    assert(nav.includes('CARD_OPEN_MS = 120') && nav.includes('CARD_CLOSE_MS = 80') && nav.includes('CARD_GAP = 8'), '预览卡应按 ZCode HoverCard 时序与偏移');
    assert(nav.includes('createPortal') && nav.includes('tn-tip-user') && nav.includes('tn-tip-ai'), '预览卡应 portal 挂载且含用户 / 助手两层摘录');
    assert(nav.includes('aria-label="对话问题导航"') && nav.includes('aria-posinset') && nav.includes('prefers-reduced-motion'), '应有导航语义、位置标注与减少动效适配');
    assert(nav.includes("behavior: reduced ? 'auto' : 'smooth'"), '跳转应在减少动效时改用 auto');
    const rail = /\.turn-nav-rail \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['width:36px', 'overflow-x:hidden', 'overflow-y:auto', 'max-height:calc(100% - 96px)']) {
      assert(rail.includes(decl), `导航轨应按 ZCode 规格声明 ${decl}`);
    }
    const item = /\.tn-item \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['width:36px', 'height:10px', 'position:absolute']) {
      assert(item.includes(decl), `导航项应按 ZCode h-2.5 w-9 规格声明 ${decl}`);
    }
    const bar = /\.tn-bar \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['width:12px', 'height:2px', 'border-radius:99px', 'transform-origin:left center']) {
      assert(bar.includes(decl), `短棒应按 ZCode h-0.5 w-3 rounded-full 规格声明 ${decl}`);
    }
    assert(css.includes('transition:height 150ms var(--ease), opacity 150ms var(--ease), transform 150ms var(--ease), background-color 150ms var(--ease)'), '短棒过渡应只动高度 / 透明度 / 变换 / 背景色');
  });
  await test('会话导航历史：浏览器式前进 / 后退栈（复刻 ZCode taskNavigationHistory）', () => {
    let h = createNavHistory();
    assert(h.cursor === -1 && h.entries.length === 0 && !canGoBack(h) && !canGoForward(h), '空历史两个方向都不可走');
    h = pushNav(h, 'a'); h = pushNav(h, 'b'); h = pushNav(h, 'c');
    assert(h.entries.join(',') === 'a,b,c' && h.cursor === 2, '连续打开应按序入栈');
    assert(canGoBack(h) && !canGoForward(h), '栈尾只能后退');
    const back = goBack(h); h = back.history;
    assert(back.id === 'b' && h.cursor === 1, '后退一步回到上一个会话');
    const fwd = goForward(h); h = fwd.history;
    assert(fwd.id === 'c' && h.cursor === 2, '前进一步重放');
    assert(goBack(createNavHistory()) === null && goForward(createNavHistory()) === null, '空历史进退都返回 null');
    // 相邻去重：回退到当前会话、重复点当前行都不该重新入栈
    h = pushNav(h, 'c'); h = pushNav(h, 'c');
    assert(h.entries.join(',') === 'a,b,c' && h.cursor === 2, '相邻去重：重复入栈不增生条目');
    // 后退后打开新会话：截断 cursor 之后的前进历史（浏览器式语义）
    h = goBack(h).history;
    h = pushNav(h, 'd');
    assert(h.entries.join(',') === 'a,b,d' && h.cursor === 2 && !canGoForward(h), '新入栈应截断前进历史');
    // 删除会话：当前条目被摘则沿用旧位置选最近目标；未被摘则 cursor 按索引位移
    let r = removeNav(h, 'd');
    assert(r.entries.join(',') === 'a,b' && r.cursor === 1, '删当前会话：回退到最近目标');
    h = pushNav(createNavHistory(), 'a'); h = pushNav(h, 'b'); h = pushNav(h, 'c'); h = pushNav(h, 'a');
    r = removeNav(h, 'b');
    assert(r.entries.join(',') === 'a,c,a' && r.cursor === 2, '删中间会话：cursor 左移被摘条数，仍指向同一会话');
    assert(removeNav(h, 'zz').entries.length === 4, '删不存在的会话：历史原样返回');
    assert(removeNav(createNavHistory(), 'a').cursor === -1, '删空历史的会话：仍是空历史');
    // 封顶 50：溢出丢最旧条目，cursor 随之回移
    let big = createNavHistory();
    for (let i = 0; i < NAV_HISTORY_MAX + 10; i += 1) big = pushNav(big, `s${i}`);
    assert(big.entries.length === NAV_HISTORY_MAX && big.cursor === NAV_HISTORY_MAX - 1, '历史封顶 50 条');
    assert(big.entries[0] === 's10' && big.entries[big.entries.length - 1] === `s${NAV_HISTORY_MAX + 9}`, '溢出丢弃最旧条目');
    assert(pushNav(h, '').entries.length === 4, '空 id 不入栈');
  });
  await test('会话导航与运行态源码契约：后退 / 前进接线、侧栏加载圈、Composer 添加上下文', () => {
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    const overlay = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'WorkspaceTopOverlay.tsx'), 'utf8');
    const sidebar = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Sidebar.tsx'), 'utf8');
    const com = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Composer.tsx'), 'utf8');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    const shortcut = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'shortcut.ts'), 'utf8');
    // 后退 / 前进接线
    assert(app.includes("import { canGoBack, canGoForward, createNavHistory, goBack, goForward, pushNav, removeNav } from './nav-history.mjs'"), 'App 应接导航历史纯函数层');
    assert(app.includes('const navGo = useCallback'), '应有 navGo 后退 / 前进执行器');
    assert(app.includes("if (record) setNavHist((h) => pushNav(h, id));"), '用户主动打开 / 新建会话才入栈（后退 / 前进不重复入栈）');
    assert(app.includes("void openSession(step.id, false);"), '后退 / 前进目标照常打开但不再入栈');
    assert(app.includes("setNavHist((h) => removeNav(h, id));"), '删除会话应把它从历史里摘掉');
    assert(/e\.key === '\[' \|\| e\.key === '\]'/.test(app), '应绑 Cmd/Ctrl+[ 与 Cmd/Ctrl+]（ZCode navigateBack / navigateForward 同键位）');
    assert(app.includes("onBack={() => navGo('back')}") && app.includes('canBack={canGoBack(navHist)}'), '浮层应拿 canBack / canForward 门控');
    assert(shortcut.includes("export function navBackLabel") && shortcut.includes("export function navForwardLabel"), '应有后退 / 前进的平台相关快捷键标签');
    assert(overlay.includes('navBackLabel()') && overlay.includes('navForwardLabel()'), '浮层箭头气泡应带快捷键键帽');
    // 侧栏运行态：16px 前置槽 + 灰色加载圈
    assert(sidebar.includes('className="sb-row-lead"') && sidebar.includes('className="sb-spin"') && sidebar.includes('running?.has(s.id)'), '侧栏行应有 16px 前置槽，运行中填加载圈');
    assert(sidebar.includes('running?: ReadonlySet<string>'), '运行态应由 App 以 id 集合下发（运行中可切会话，不能拿 busy && currentId 推导）');
    assert(app.includes('const [running, setRunning] = useState<Set<string>>(() => new Set());'), 'App 应持运行中会话集合');
    assert(app.includes("setRunning((prev) => new Set(prev).add(cur.id));"), '主 / 侧边 turn 开始应登记运行态');
    assert(app.includes('next.delete(sessionId); return next;'), 'turn 收尾应摘掉运行态');
    const lead = /\.sb-row-lead \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['flex:none', 'width:16px', 'height:16px']) {
      assert(lead.includes(decl), `前置槽应按 ZCode size-4 leading slot 声明 ${decl}`);
    }
    const row = /\.sb-row \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['gap:8px', 'padding:0 4px 0 10px']) {
      assert(row.includes(decl), `会话行应按 ZCode gap-2 pl-2.5 pr-1 声明 ${decl}（标题整体右移）`);
    }
    const spin = /\.sb-spin \{[^}]*\}/.exec(css)?.[0] || '';
    assert(spin.includes('border-radius:50%') && spin.includes('animation:spin'), '加载圈应为旋转圆环（零依赖，不引图标库）');
    assert(css.includes('.sb-spin {') && /prefers-reduced-motion[^}]*\.sb-spin/.test(css.replace(/\n/g, ' ')), '减少动效时应放慢加载圈');
    // Composer 添加上下文（ZCode ChatPromptActionMenu）
    assert(com.includes('className="composer-plus"') && com.includes('aria-label="添加上下文"'), '输入区应有「添加上下文」加号钮');
    assert(com.includes('label="添加上下文"') && com.includes('上传文件') && com.includes('引用工作目录文件'), '加号菜单应含上传文件与引用工作目录文件两项');
    assert(com.includes('type="file"') && com.includes('uploadFiles') && com.includes('ATTACH_MAX_BYTES'), '上传应走隐藏 file input 并带上限守门');
    assert(com.includes('openMention') && com.includes('barRef') && com.includes('dataset.compact'), '应有提及唤起与窄屏紧凑收纳');
    const plus = /\.composer-plus \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['width:28px', 'height:28px', 'border-radius:8px']) {
      assert(plus.includes(decl), `加号钮应按 ZCode ghost icon-md 声明 ${decl}`);
    }
    const shell = /\.composer-card \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['border-radius:16px', 'padding:12px', 'gap:12px']) {
      assert(shell.includes(decl), `输入壳应按 ZCode rounded-2xl + p-3 + gap-3 声明 ${decl}`);
    }
    assert(css.includes('.composer-card:focus-within { border-color:var(--accent-line); background:var(--surface-hover); }'), '聚焦只换边框与底色，不铺 glow（ZCode focus-within 语义）');
    const send = /\.sendbtn \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['width:28px', 'height:28px', 'border-radius:8px']) {
      assert(send.includes(decl), `发送钮应按 ZCode icon-md 声明 ${decl}`);
    }
    assert(com.includes('<IconArrowUp size={16} />') && com.includes('sendbtn-stop'), '发送用 ArrowUp，生成中换方形停止钮');
  });
  await test('工具卡紧缩形态源码契约：ZCode ToolSummaryRow 无框摘要行 + 加号菜单净化', () => {
    const tool = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ToolCard.tsx'), 'utf8');
    const com = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Composer.tsx'), 'utf8');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    // 加号菜单：只剩上传文件与引用工作目录文件两项——说明性 disabled 行与分隔线已删
    assert(!com.includes('MenuSeparator'), '加号菜单不应再引入分隔线（只剩两项）');
    assert(!com.includes('disabled>斜杠命令'), '加号菜单不应有指示斜杠输入的说明行（用户点名毫无意义）');
    assert(!com.includes('技能调用随输入展开'), '说明行文案应彻底移除');
    // 紧缩摘要行：无框、无底、Hug 宽度（ZCode inline-flex self-start gap-2）
    const card = /\.toolcard \{[^}]*\}/.exec(css)?.[0] || '';
    assert(card.includes('align-self:flex-start') && card.includes('max-width:100%'), '摘要行应 Hug 内容宽度（align-self:flex-start）');
    assert(!card.includes('border:1px') && !card.includes('background:'), '摘要行不应有边框与底色（不再是框起来的卡片）');
    const summary = /\.toolcard > details > summary \{[^}]*\}/.exec(css)?.[0] || '';
    assert(summary.includes('gap:8px'), '行内元素间距应对齐 ZCode gap-2');
    assert(/padding:3px 0/.test(summary), '摘要行垂直内距应收敛到 3px（一行文本的高度）');
    const chevron = /\.toolcard > details > summary::after \{[^}]*\}/.exec(css)?.[0] || '';
    assert(chevron.includes('opacity:0'), '展开箭头应默认隐藏（ZCode：hover 才现）');
    assert(css.includes('.toolcard > details > summary:hover::after { opacity:1; }'), 'hover 时应显出箭头');
    assert(css.includes('.toolcard > details[open] > summary::after { transform:rotate(225deg); opacity:1; }'), '展开态箭头常显并转向');
    const res = /\.tc-res \{[^}]*\}/.exec(css)?.[0] || '';
    assert(!res.includes('background:') && !res.includes('border-radius'), '资源（命令 / URL）应是纯截断文本，不是chip');
    const body = /^\.tc-body \{[^}]*\}/m.exec(css)?.[0] || '';
    for (const decl of ['border:1px solid var(--line)', 'border-radius:10px', 'background:var(--surface)']) {
      assert(body.includes(decl), `展开后的内容应收成面板（ZCode 展开态 rounded-xl border bg-panel）：${decl}`);
    }
    assert(css.includes('.toolcard.tc-ask > details > .tc-body { border-color:var(--accent-line); }'), '授权态语义边框应改挂到展开面板');
    // 运行时状态词仍在摘要行内联展示（流式期间不额外占行）
    assert(tool.includes("case 'running': return { cls: 'run'") && tool.includes('执行中'), '运行中状态应内联在摘要行');
  });
  await test('思考过程纯函数：剥开头空行、取最后一个非空行、溢出判定（复刻 ZCode ReasoningTrigger）', () => {
    eq(normalizeThinkingText(''), '');
    eq(normalizeThinkingText('\n\n先想一遍'), '先想一遍');
    eq(normalizeThinkingText('\n  \n\t再想一遍'), '\t再想一遍');
    eq(normalizeThinkingText('  \n \n保留缩进'), '保留缩进');
    eq(normalizeThinkingText('\r\n\r\nCRLF 前缀'), 'CRLF 前缀');
    eq(normalizeThinkingText('先想一遍'), '先想一遍');
    eq(normalizeThinkingText('\n\n'), '');
    eq(normalizeThinkingText('第一行\n\n\n第二行'), '第一行\n\n\n第二行');
    eq(resolveReasoningStreamingSummary(''), '');
    eq(resolveReasoningStreamingSummary('\n\n   \n'), '');
    eq(resolveReasoningStreamingSummary('先想一遍\n再想一遍'), '再想一遍');
    eq(resolveReasoningStreamingSummary('先想一遍\n\n  \n'), '先想一遍');
    eq(resolveReasoningStreamingSummary('a\r\nb\r\n'), 'b');
    eq(resolveReasoningStreamingSummary('a\n  行尾带空白   '), '行尾带空白');
    assert(!isReasoningSummaryOverflowing(200, 200), '恰好等于视口不算溢出');
    assert(!isReasoningSummaryOverflowing(200, 201), '1px 容差内不算溢出');
    assert(isReasoningSummaryOverflowing(200, 240), '超出 1px 容差应判溢出（该挂渐隐遮罩）');
  });
  await test('消息行与思考过程 ZCode 化源码契约：无头像、用户右对齐、Reasoning 紧缩行', () => {
    const msg = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Message.tsx'), 'utf8');
    const chat = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ChatView.tsx'), 'utf8');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    // 无头像（ZCode Message / MessageContent 不带 avatar，层级靠对齐与底色）
    assert(!msg.includes('avatar') && !chat.includes('avatar'), '消息行不应再渲染头像（用户与助手都不要）');
    assert(!css.includes('.avatar'), '头像样式应彻底移除');
    assert(msg.includes('className="row row-user hist is-user"') && msg.includes('className="row row-ai hist is-assistant"'), '消息行应带 ZCode is-user / is-assistant 状态类');
    assert(chat.includes('className="row row-ai is-assistant"'), '流式行同样去头像并带 is-assistant');
    // 用户消息右对齐 + w-fit 气泡（ZCode is-user：ml-auto justify-end + rounded-lg bg-secondary px-4 py-3）
    const rowUser = /\.row-user \{[^}]*\}/.exec(css)?.[0] || '';
    assert(rowUser.includes('justify-content:flex-end'), '用户消息整行应推右（ZCode justify-end）');
    const bubble = /\.bubble-user \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['width:fit-content', 'border-radius:8px', 'background:var(--surface-hover)', 'padding:10px 16px']) {
      assert(bubble.includes(decl), `用户气泡应按 ZCode is-user 变体声明 ${decl}`);
    }
    // 思考过程（ZCode Reasoning）：无框内联行 + 左侧导线展开内容 + 限高滚动
    const think = /^\.think \{[^}]*\}/m.exec(css)?.[0] || '';
    assert(think.includes('align-self:flex-start') && !think.includes('border:'), '思考摘要行应无框 Hug 内容（与工具摘要行同一密度语言）');
    const head = /\.think-head \{[^}]*\}/.exec(css)?.[0] || '';
    assert(head.includes('display:inline-flex') && head.includes('gap:8px') && head.includes('font-size:1rem'), '思考触发器是 inline-flex 内联行、gap-2、字号 text-ui-base（ZCode gap-2 + text-ui-base）');
    assert(css.includes('.think-label.stream { animation:think-shimmer'), '流式「正在思考」应扫光（只动颜色）');
    assert(css.includes('.think-label.stream { animation:none; color:var(--text); }'), '减少动效时扫光应定色');
    const body = /\.think-body \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['border-left:1px solid var(--line)', 'max-height:240px', 'padding-left:14px']) {
      assert(body.includes(decl), `思考展开内容应按 ZCode ml-2 border-l pl-3.5 + max-h-60 声明 ${decl}`);
    }
    assert(/if \(!streaming && !interacted\.current\) setOpen\(false\);/.test(msg), '流式结束应自动收起思考（用户手动展开过则不打扰）');
    assert(msg.includes("from '../reasoning.mjs'"), '思考过程应接入纯函数层 reasoning.mjs');
    assert(msg.includes('streaming && !open ? resolveReasoningStreamingSummary(body)'), '摘要只在流式且收起时出现（ZCode isStreaming && !isOpen）');
    assert(msg.includes('isReasoningSummaryOverflowing(el.clientWidth, el.scrollWidth)') && msg.includes('el.scrollLeft = el.scrollWidth'), '溢出重测并把单行视口推到末尾（ZCode syncSummaryViewport + scrollReasoningSummaryToEnd）');
    assert(msg.includes("{streaming ? '正在思考' : '思考'}"), '标签用「正在思考 / 思考」（ZCode chat.reasoning.thinking / thought）');
    assert(msg.includes('<IconBrain size={16} />') && msg.includes('<IconChevronRight size={16} className="think-chev" />'), 'brain 与 chevron 都用 16px（ZCode size-4）');
    assert(msg.includes('normalizeThinkingText(text)') && msg.includes('<div className="think-body">{body}</div>'), '展开正文应先剥开头空行（模型常吐 \n\n 导致第一行空白）');
    assert(!msg.includes('IconBulb'), '思考行用 brain 语义图标，不再用灯泡');
    assert(!chat.includes('defaultOpen'), '流式思考同样默认收起（ZCode：streaming/complete 都默认收起，默认展开会挤压工具与正文）');
    const chev = /\.think-chev \{[^}]*\}/.exec(css)?.[0] || '';
    assert(chev.includes('opacity:0') && css.includes('.think-head:hover .think-chev { opacity:1; }') && css.includes('.think.open .think-chev { transform:rotate(90deg); opacity:1; }'), 'chevron 静止透明、hover 显、展开转向 90°（ZCode opacity-0 group-hover + rotate-90）');
    assert(css.includes('.think-dot') && msg.includes('className="think-dot"'), '摘要前有 · 分隔（ZCode streamingSummary 前的 shrink-0 间隔点）');
    assert(css.includes('.think-summary.over {') && css.includes('linear-gradient(90deg, transparent 0, #000 16px'), '摘要溢出才挂左右 16px 渐隐（ZCode getReasoningSummaryMaskStyle）');
    const sumCss = /\.think-summary \{[^}]*\}/.exec(css)?.[0] || '';
    assert(sumCss.includes('font-size:1rem'), '摘要字号同触发器（ZCode 不另设字号，继承 text-ui-base）');
    const bodyCss = /\.think-body \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['margin-top:12px', 'margin-left:8px', 'font-size:1rem']) {
      assert(bodyCss.includes(decl), `思考展开内容应按 ZCode pt-3 / ml-2 / text-ui-base 声明 ${decl}`);
    }
  });
  await test('更新检查源码契约：设置页入口、路由与缓存语义', () => {
    const general = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'GeneralPanel.tsx'), 'utf8');
    assert(general.includes('checkUpdate(true)') && general.includes('检查更新'), '设置页应有检查更新入口');
    assert(general.includes('updateAvailable') && general.includes('查看发布页与安装包'), '发现新版本应给出去发布页的链接');
    assert(!general.includes('useState(() => {'), '面板副作用应走 useEffect，不得在渲染期发起请求');
    const web = readFileSync(join(__dirname, '..', 'web.mjs'), 'utf8');
    assert(web.includes("/api/update/check") && web.includes("checkUpdate({ current: VERSION"), 'web.mjs 应接更新检查路由');
    const upd = readFileSync(join(__dirname, '..', 'util', 'update.mjs'), 'utf8');
    assert(upd.includes('CACHE_TTL_MS') && upd.includes('releases/latest'), '应有 6 小时缓存与 GitHub latest 查询');
    assert(upd.includes('FETCH_TIMEOUT_MS'), '查询应带超时，别让界面干等');
    assert(upd.includes('readCache(cachePath, current)') && upd.includes('j.current !== current'), '缓存必须按本地版本号作 key：本地版本一变，旧 latest 结论立刻作废');
  });
  await test('设置弹层分级导航源码契约：左分类轨、懒挂载缓存与壳承担 section 标题', () => {
    const settings = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'SettingsDialog.tsx'), 'utf8');
    assert(settings.includes('set-rail') && settings.includes('set-nav-cell') && settings.includes('set-content'), '设置弹层应为左导航轨 + 右侧内容区的分级布局（对齐 dsh web SettingsRoot）');
    assert(settings.includes("aria-current={on ? 'page' : undefined}"), '当前分类应标记 aria-current 供读屏软件感知');
    assert(settings.includes('const [mounted, setMounted]') && settings.includes('hidden={id !== active}'), '各 section 应懒挂载并用 hidden 缓存（切换保留面板内部草稿态）');
    for (const id of ['general', 'appearance', 'providers', 'failover', 'network', 'skills', 'mcp', 'terminal', 'usage', 'errlog']) {
      assert(settings.includes(`id: '${id}'`), `分类轨应登记 ${id}`);
      assert(settings.includes(`case '${id}':`), `设置壳应挂载 ${id} 面板`);
    }
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.set-rail {') && css.includes('.set-row {') && css.includes('.set-group-t {'), 'app.css 应有分级导航与行式条目样式');
    assert(css.includes('.set-page[hidden] { display:none; }'), '缓存的非当前 section 应真正隐藏');
    assert(!css.includes('.pv-sec {'), 'section 标题已由壳 header 承担，旧包裹样式应退役');
    // 弹层几何：显式居中 + 遮罩模糊 + 固定高度（对齐 dsh web，修「不居中 / 无模糊 / 高度乱抖」）
    assert(/\.dlg \{[^}]*position:fixed;[^}]*inset:0;[^}]*margin:auto/.test(css), 'dialog 应显式四边为 0 + margin:auto 居中（UA 对 :modal 的 inset 处理不一致）');
    assert((css.match(/backdrop-filter:blur\(6px\)/g) || []).length >= 2, '遮罩应在深色与浅色主题下都模糊');
    assert(/\.dlg-settings \{ width:min\(860px[^}]*height:min\(800px/.test(css), '设置弹层应固定宽高（不再 fit-content 随内容抖）');
    assert(css.includes('.dlg-settings .dlg-panel { flex-direction:row; height:100%; max-height:100%; }'), '设置面板应撑满固定高度，滚动交给内容区');
    assert(!css.includes('max-height:inherit'), '面板不得再 inherit max-height（inherit 取不到弹层 used 值，等于没限高）');
  });
  await test('停止按钮方块源码契约：Composer 与 GoalBar 共用同一图标，方块按 dsh 比例放大', () => {
    const icons = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'icons.tsx'), 'utf8');
    const stop = /export const IconStop[\s\S]*?<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"/.exec(icons);
    assert(stop, '应有 IconStop 方块图标');
    const w = Number(stop[3]);
    assert(w >= 14, `停止方块应占满图标可视区（当前 ${w}/24，dsh 为 15/24）`);
    assert(Number(stop[1]) === (24 - w) / 2 && Number(stop[2]) === (24 - w) / 2, '停止方块应居中');
    assert(icons.split('export const IconStop').length - 1 === 1, '停止按钮应只有一份图标定义（Composer / GoalBar 共用，改一处两处生效）');
  });
  await test('侧边对话界面源码契约：turn 事件处理器主 / 侧同源、横幅与 Ctrl+/ 切换在场', () => {
    const te = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'turn-events.ts'), 'utf8');
    assert(te.includes('export function createTurnEventHandlers') && te.includes('export async function finishTurnProjection'), 'turn 事件处理器应抽为共享模块（主 / 侧同源）');
    assert(te.includes("scope === 'side'") && te.includes('getSideSession'), '侧边通道应按侧边转录重投影');
    assert(te.includes("ev.sessionId === currentIdRef.current"), 'goal 事件仍带会话归属校验，防串会话');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    assert(app.includes('const [side, setSide]') && app.includes('sideActive'), 'App 应持有侧边对话状态');
    assert(app.includes('sendSide') && app.includes('discardBtw') && app.includes('toggleSide'), '应有侧边发送 / 丢弃 / 切换');
    assert(app.includes("(e.metaKey || e.ctrlKey) && e.key === '/'"), '应有 Ctrl+/ 主 / 侧边对话切换快捷键');
    assert(app.includes('sideActive ? side?.msgs || [] : messages'), '对话区应按当前通道渲染消息');
    assert(app.includes('side: true'), '侧边 turn 应带 side:true');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.side-banner') && css.includes('.side-banner-acts'), '应有侧边横幅样式与动作区');
    const api = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'api.ts'), 'utf8');
    assert(api.includes('getSideSession') && api.includes('discardSide'), 'api.ts 应登记侧边对话查询与丢弃');
  });
  await test('设置通用面板源码契约：生成参数（温度 / 最大输出 / API Key）可改且走新端点', () => {
    const gp = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'GeneralPanel.tsx'), 'utf8');
    assert(gp.includes('saveGeneration') && gp.includes('saveApiKey') && gp.includes('getKeyState'), '通用面板应经 api.ts 走生成参数与 Key 端点');
    assert(gp.includes('aria-label="温度"') && gp.includes('aria-label="单次最大输出"') && gp.includes('aria-label="API Key"'), '生成参数组应有温度 / 最大输出 / Key 三行');
    assert(!hasEmoji(gp), '通用面板零 emoji 铁律');
    const api = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'api.ts'), 'utf8');
    assert(api.includes('/api/settings/generation') && api.includes('/api/settings/key'), 'api.ts 应登记两个新端点');
    assert(readFileSync(join(__dirname, '..', 'util', 'settings-generation.mjs'), 'utf8').includes('handleGenerationApi'), '应有生成参数 HTTP 面模块');
    assert(readFileSync(join(__dirname, '..', 'web.mjs'), 'utf8').includes("url.startsWith('/api/settings/generation')"), 'web.mjs 应委派新端点');
  });
  await test('设置外观面板源码契约：ZCode appearance 一级目录 + 主题下拉（不是分段按钮）', async () => {
    const dlg = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'SettingsDialog.tsx'), 'utf8');
    assert(dlg.includes("id: 'appearance'") && dlg.includes("case 'appearance': return <AppearancePanel />;"), '设置弹层应登记并挂载外观面板（ZCode appearance 一级目录）');
    assert(dlg.includes("label: '外观'") && dlg.includes('IconPalette'), '外观分类应按 ZCode 用 Palette 图标');
    // ZCode 目录顺序：general 之后紧跟 appearance
    assert(dlg.indexOf("id: 'general'") < dlg.indexOf("id: 'appearance'") && dlg.indexOf("id: 'appearance'") < dlg.indexOf("id: 'providers'"), '外观应排在通用之后、提供方之前（ZCode basics 组同序）');
    const ap = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'AppearancePanel.tsx'), 'utf8');
    assert(ap.includes('界面设置') && ap.includes('界面主题') && ap.includes('选择浅色、深色或跟随系统主题。'), '外观面板应按 ZCode 文案呈现界面设置与主题行');
    assert(ap.includes('width={260}'), '主题下拉应按 ZCode w-[260px] 宽度');
    assert(ap.includes('useThemePreference') && !hasEmoji(ap), '外观面板应复用 theme.ts 偏好且零 emoji');
    // 主题控件是下拉：选项带图标时分段按钮排不下，且下拉与设置页其它选择器语言一致
    assert(ap.includes('<Select') && ap.includes('SelectOption'), '主题选择应走零依赖 Select 下拉');
    const gp = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'GeneralPanel.tsx'), 'utf8');
    assert(!gp.includes('mode-seg') && !gp.includes('THEME_OPTIONS') && !gp.includes('useThemePreference'), '通用面板不应再留主题分段控件（已迁往外观面板）');
    // Select 组件契约：ZCode trigger input 变体 lg 尺寸 + 内容壳 + Radix 键盘全集 + dialog 内 portal
    const sel = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'Select.tsx'), 'utf8');
    assert(sel.includes('role="combobox"') && sel.includes('aria-haspopup="listbox"'), '触发器应挂 combobox 语义');
    assert(sel.includes('role="option"') && sel.includes('aria-selected'), '选项应挂 listbox / option 语义与选中态');
    assert(sel.includes("e.key === 'Escape'") && sel.includes("e.key === 'ArrowDown'") && sel.includes("e.key === 'Home'") && sel.includes("e.key === 'Enter'"), 'Select 应有 Radix 键盘全集（Esc / 上下 / Home / End / 回车空格）');
    assert(sel.includes("trigger?.closest('dialog')"), 'portal 宿主应取最近的 dialog（模态内挂 body 会被 top-layer 对话框盖住）');
    assert(sel.includes("data-phase={open ? 'in' : 'out'}") && !sel.includes('transition:all'), '退出淡出应走 data-phase，禁 transition:all');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    const trig = /\.sel-trigger \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['height:32px', 'border-radius:8px', 'border:1px solid var(--line-strong)', 'padding:0 8px 0 12px']) {
      assert(trig.includes(decl), `Select 触发器应按 ZCode input 变体 lg 尺寸声明 ${decl}`);
    }
    const pop = /\.sel-pop \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['border-radius:8px', 'border:1px solid var(--line-strong)', 'background:var(--panel)', 'box-shadow:var(--shadow-pop)', 'padding:4px']) {
      assert(pop.includes(decl), `Select 内容壳应按 ZCode SelectContent 规格声明 ${decl}`);
    }
    assert(css.includes('#select-root { position:fixed; left:0; top:0; z-index:140; pointer-events:none; }'), 'Select root 应常驻且不抢指针（z-index 高于菜单的 130）');
    assert(css.includes('.ap-card') && css.includes('.ap-row') && css.includes('.ap-title'), '外观面板应有 ZCode Card + SettingsRow 形态样式');
    // 构建产物在场：改了 web-ui 忘了 build:web 会红
    const html = await (await fetch(`${BASE}/`)).text();
    const js = await (await fetch(`${BASE}${/\/app\/assets\/[A-Za-z0-9._-]+\.js/.exec(html)[0]}`)).text();
    for (const marker of ['sb-new-key', 'sel-trigger', 'sel-pop', 'ap-card']) {
      assert(js.includes(marker), `构建产物应含 ${marker}（改了 web-ui 忘了 build:web 会红）`);
    }
  });
  await test('外观页全量迁移源码契约：ZCode appearance 的界面 / 代码 / 预览三段选项逐个在场', async () => {
    const ap = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'AppearancePanel.tsx'), 'utf8');
    // 第一段：界面设置（ZCode settings.appearance.interface*）
    assert(ap.includes('界面设置') && ap.includes('设置应用主题和界面文字大小。'), '应有 ZCode「界面设置」标题与描述');
    assert(ap.includes('界面主题') && ap.includes('选择浅色、深色或跟随系统主题。'), '界面主题行应在场');
    assert(ap.includes('界面字号') && ap.includes('调整应用界面的文字大小，图标和布局尺寸不受影响。'), '界面字号行应在场（ZCode uiFontSize）');
    // 第二段：代码设置（ZCode settings.lightTheme / darkTheme / showLineNumbers / wrapLongLines / fontSize）
    assert(ap.includes('代码设置') && ap.includes('设置代码内容的主题、字号和显示方式，不受界面字号影响。'), '应有 ZCode「代码设置」标题与描述');
    for (const row of ['浅色代码主题', '深色代码主题', '显示行号', '长行自动换行', '代码字号']) {
      assert(ap.includes(row), `代码设置应有「${row}」行`);
    }
    assert((ap.match(/<Select/g) || []).length >= 3, '主题 / 浅色代码主题 / 深色代码主题三个选择都应是下拉');
    assert((ap.match(/<Switch/g) || []).length === 2 && (ap.match(/<NumberField/g) || []).length === 2, '行号与换行走开关、界面与代码字号走数字输入');
    assert(ap.includes('MIN_FONT_SIZE_PX') && ap.includes('MAX_FONT_SIZE_PX'), '两处字号行都应钳制 12~20');
    // 第三段：代码预览（ZCode ThemePreviewCard ×2 + 当前生效角标）
    assert(ap.includes('代码预览') && ap.includes('同时预览浅色与深色代码主题，当前界面使用的主题会标记为「当前生效」。'), '应有 ZCode「代码预览」标题与描述');
    assert(ap.includes('浅色预览') && ap.includes('深色预览') && ap.includes('当前生效'), '预览卡应浅 / 深并排并带当前生效角标');
    assert(ap.includes('<Markdown text={PREVIEW_CODE}') && ap.includes('paletteVars(codePalette('), '预览卡应跑真实 Markdown 并按模式覆写 --code-* 调色板变量');
    assert(ap.includes('prefersDark(themePref)') && !hasEmoji(ap), '预览卡应标记当前界面明暗且零 emoji');
    // 偏好模块：默认值 / 存储键 / 钳制 / 调色板 / 落地 / 订阅
    const appear = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'appearance.ts'), 'utf8');
    assert(appear.includes("auroraagent.ui-font-size") && appear.includes('auroraagent.code-font-size') && appear.includes('auroraagent.code-line-numbers') && appear.includes('auroraagent.code-wrap'), '外观偏好应落 localStorage（ZCode 同款键名纪律）');
    assert(appear.includes('auroraagent.code-theme-light') && appear.includes('auroraagent.code-theme-dark'), '浅 / 深代码主题应分别持久化');
    assert(appear.includes('MIN_FONT_SIZE_PX = 12') && appear.includes('MAX_FONT_SIZE_PX = 20') && appear.includes('DEFAULT_UI_FONT_SIZE_PX = 14'), '字号范围应与 ZCode 一致（12~20，默认 14）');
    assert(appear.includes("codeLineNumbers: false") && appear.includes('codeWrap: false'), '默认值应保持现有观感：行号关、不换行');
    for (const theme of ['aurora', 'github', 'vitesse', 'catppuccin', 'contrast']) {
      assert(appear.includes(`${theme}: {`) && appear.includes('light: { key:') && appear.includes('dark: { key:'), `代码主题 ${theme} 应有浅 / 深两套调色板`);
    }
    assert(appear.includes("root.style.setProperty('--ui-font-size'") && appear.includes("root.style.setProperty('--code-font-size'"), '落地应写字号基准变量（只动字号不动布局，ZCode 同纪律）');
    assert(appear.includes('root.dataset.codeLn') && appear.includes('root.dataset.codeWrap'), '行号 / 换行应落 dataset 供 CSS 消费');
    assert(appear.includes('useSyncExternalStore') && appear.includes('watchAppearance'), '偏好应是迷你真外部存储且启动时补落地 + 监听系统主题');
    // 回归：localStorage 读不到是 null，Number(null)===0 会被误当合法值钳成 12px 下限
    assert(appear.includes("raw === null ? Number.NaN : Number(raw)") && appear.includes('const num = (key: string)'), '读偏好必须先判空再转数（无偏好 = 默认值，不是下限）');
    // 控件：NumberField 提交语义 / Switch 语义
    const nf = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'NumberField.tsx'), 'utf8');
    assert(nf.includes('Math.min(max, Math.max(min, Math.round(parsed)))') && nf.includes("e.key === 'Enter'") && nf.includes("e.key === 'Escape'"), '数字输入应钳制范围、回车提交、Esc 还原（ZCode FontSizeInput 语义）');
    assert(nf.includes('type="number"') && nf.includes('inputMode="numeric"') && !nf.includes('transition:all'), '数字输入应为数字键盘形态且禁 transition:all');
    const sw = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'Switch.tsx'), 'utf8');
    assert(sw.includes('role="switch"') && sw.includes('aria-checked={checked}'), '开关应挂 switch 语义');
    // 令牌与样式：默认调色板 / html 字号基准 / 行号槽 / 换行开关
    const tokens = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'tokens.css'), 'utf8');
    assert(tokens.includes('--ui-font-size:14px') && tokens.includes('--code-font-size:13px'), 'tokens.css 应有界面 / 代码字号默认令牌');
    for (const v of ['--code-key', '--code-str', '--code-num', '--code-com', '--code-fn', '--code-type']) {
      assert(tokens.includes(`${v}:var(`), `tokens.css 应有默认调色板变量 ${v}`);
    }
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('html { font-size: var(--ui-font-size, 14px); }'), '界面字号应经 html 基准变量生效（全文件 font-size 已 rem 化）');
    assert(!/font-size:[0-9.]+px/.test(css) && !/line-height:[0-9.]+px/.test(css), 'app.css 不应再留 px 字号 / 行高（否则界面字号设置无效）');
    assert(css.includes('.md pre .c-key { color:var(--code-key); }') && css.includes('.md pre .c-type { color:var(--code-type); }'), '高亮 token 应走 --code-* 调色板变量');
    assert(css.includes('.md pre.code-ln { padding-left:48px; }') && css.includes('.md pre .code-no {') && css.includes('position:sticky; left:0;'), '行号槽应粘性钉在左缘（横向滚动不跟着跑）');
    assert(css.includes('html[data-code-wrap="on"] .md pre { white-space:pre-wrap;'), '长行换行开关应落 CSS');
    assert(css.includes('.tc-pre { font-size:var(--code-font-size); }'), '工具输出预览应随代码字号变');
    assert(css.includes('.nf-input') && css.includes('.nf-suffix') && css.includes('.sw {') && css.includes('.ap-prevs {'), 'NumberField / Switch / 预览卡样式应在场');
    assert(css.includes('font-variant-numeric:tabular-nums'), '数字输入应等宽数字（ZCode tabular-nums）');
    // 结构侧：Markdown 按行切分 + 序号 span + 偏好订阅
    const md = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'markdown.tsx'), 'utf8');
    assert(md.includes('splitTokenLines') && md.includes('className="code-no"') && md.includes('useAppearance'), '代码块应按偏好切分行号结构');
    // 首帧与启动：index.html 预置 + main.tsx 运行期落地
    const html = readFileSync(join(__dirname, '..', 'web-ui', 'index.html'), 'utf8');
    assert(html.includes('--ui-font-size') && html.includes('auroraagent.code-line-numbers') && html.includes('auroraagent.code-wrap'), '首帧脚本应预置界面 / 代码字号与行号 / 换行（防刷新回跳闪烁）');
    assert(html.includes('if (raw === null) return dflt;'), '首帧脚本同样必须判空（曾因 Number(null)===0 把默认字号错钳成 12px）');
    const main = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'main.tsx'), 'utf8');
    assert(main.includes('watchAppearance()'), '启动应补代码调色板落地并监听系统主题翻转');
    // 构建产物在场
    const page = await (await fetch(`${BASE}/`)).text();
    const js = await (await fetch(`${BASE}${/\/app\/assets\/[A-Za-z0-9._-]+\.js/.exec(page)[0]}`)).text();
    for (const marker of ['code-ln', 'code-no', 'nf-input', 'sw-thumb', 'ap-prev']) {
      assert(js.includes(marker), `构建产物应含 ${marker}（改了 web-ui 忘了 build:web 会红）`);
    }
  });
  await test('新建任务纪律源码契约：空新会话不允许再堆一个空会话', () => {
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    // 守卫：当前会话无任何轮次且未在生成 → 已是「空新会话」
    assert(app.includes('const isPristineSession = Boolean(current && current.turns === 0 && !busy);'), '应判定空新会话（无轮次且未在生成）');
    assert(app.includes('const newSession = () => { if (isPristineSession) return; void createSessionNow(); };'), '新建任务入口应受守卫约束');
    // 恢复路径（删光会话后）必须能创建第一个会话，不能被守卫误伤
    assert(app.includes('else void createSessionNow();'), '删除当前会话后的空列表恢复应走原始创建（不受守卫约束）');
    // Ctrl/Cmd+K 与按钮同规则：静默无效，不弹错误
    assert(/e\.key\.toLowerCase\(\) === 'k'[\s\S]{0,160}newSession\(\);/.test(app), 'Ctrl/Cmd+K 应走守卫后的 newSession');
    const sidebar = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Sidebar.tsx'), 'utf8');
    assert(sidebar.includes('newDisabled?: boolean;') && sidebar.includes('disabled={newDisabled}'), '侧栏新建任务钮应接收并落地禁用态');
    const overlay = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'WorkspaceTopOverlay.tsx'), 'utf8');
    assert(overlay.includes('newDisabled') && overlay.includes('disabled={newDisabled}'), '收回态浮层新建钮应与侧栏同规则禁用');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.sb-new:disabled { color:var(--faint); cursor:not-allowed; }') && css.includes('.sb-new:disabled:hover { background:none; }'), '禁用态应按 ZCode 纪律：沉到最弱色且不响应 hover');
  });
  await test('对话区跟手与渲染性能源码契约：贴底才跟随、历史 memo、快捷键聚焦', () => {
    const chat = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ChatView.tsx'), 'utf8');
    assert(chat.includes('stickRef') && chat.includes('scrollHeight - el.scrollTop - el.clientHeight < 96'), '应只在贴底时跟随滚动');
    assert(chat.includes('chat-jump') && chat.includes('回到最新'), '上翻后应有一键回到底部');
    assert(!/endRef\?.*scrollIntoView\([^)]*\);[^}]*\}, \[messages, live\]/.test(chat) || chat.includes('if (stickRef.current)'), '滚动副作用应受贴底条件保护');
    const msg = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Message.tsx'), 'utf8');
    assert(msg.includes('memo(function Message'), '历史消息应 memo，避免流式期间反复重渲染整段历史');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    assert(app.includes("e.key.toLowerCase() === 'k'") && app.includes("e.key === '/'"), '应有 Ctrl/Cmd+K 新建与会话 / 聚焦输入框快捷键');
    const composer = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Composer.tsx'), 'utf8');
    assert(composer.includes('focusNonce'), '输入区应接受外部聚焦请求');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.chat-jump'), '应有回到底部按钮样式');
  });
  await test('用量与错误日志面板源码契约：设置弹层两块新面板在场', () => {
    const settings = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'SettingsDialog.tsx'), 'utf8');
    assert(settings.includes("case 'usage': return <UsagePanel />;") && settings.includes("case 'errlog': return <ErrorLogPanel />;"), '设置弹层应接入用量与错误日志面板');
    const usage = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'UsagePanel.tsx'), 'utf8');
    assert(usage.includes('DayBars') && usage.includes('usage-stack'), '用量面板应有逐日柱状与构成占比条');
    assert(usage.includes('getUsage'), '用量面板应走 /api/usage');
    assert(!hasEmoji(usage), '用量面板零 emoji 铁律');
    // 措辞去 token 化：面向用户只讲输入多少 / 输出多少 / 费用多少，不抛术语
    assert(usage.includes('<dt>输入</dt>') && usage.includes('<dt>输出</dt>'), '总计应直接写输入 / 输出');
    assert(usage.includes('<th>输入 / 输出</th>'), '最近请求表头应写输入 / 输出');
    assert(!/>[^<]*tokens</.test(usage) && !usage.includes('每日 token'), '用量面板不得再出现 token 字样');
    assert(!usage.includes('含被中止的'), '用量面板不必向用户解释被中止与标题请求这两类特殊记录');
    for (const f of ['Message', 'ChatView']) {
      const src = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', `${f}.tsx`), 'utf8');
      assert(!src.includes('tokens 输入'), `${f} 用量脚注应去掉 tokens 前缀，只留输入 / 输出 / 费用`);
    }
    const errlog = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ErrorLogPanel.tsx'), 'utf8');
    assert(errlog.includes('listErrorLogs') && errlog.includes('clearErrorLogs'), '错误日志面板应支持查看与清空');
    assert(!hasEmoji(errlog), '错误日志面板零 emoji 铁律');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.usage-chart') && css.includes('.errlog-head'), '应有面板样式');
    const agg = readFileSync(join(__dirname, '..', 'util', 'usage.mjs'), 'utf8');
    assert(agg.includes('stats({ days = 30'), '账本应提供统计聚合入口');
  });
  await test('双主题源码契约：浅色令牌整套覆盖、首帧防闪、设置页切换', () => {
    const tokens = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'tokens.css'), 'utf8');
    assert(tokens.includes(':root[data-theme="light"]'), 'tokens.css 应有浅色主题变量块');
    for (const v of ['--bg:', '--panel:', '--text:', '--dim:', '--accent:', '--ok-ink:', '--danger-ink:', '--diff-add:', '--shadow-pop:']) {
      assert(tokens.includes(v), `令牌 ${v} 应在场（双主题同名覆盖）`);
    }
    // 浅色块必须真的改掉中性色，而不是把深色值抄一遍
    const lightBlock = tokens.slice(tokens.indexOf(':root[data-theme="light"]'));
    assert(/--bg:\s*#f[0-9a-f]{5}/i.test(lightBlock), '浅色背景应为亮色');
    assert(/--text:\s*#1[0-9a-f]{5}/i.test(lightBlock), '浅色文字应为暗色');
    assert(lightBlock.includes('color-scheme:light'), '浅色块应声明 color-scheme');
    const html = readFileSync(join(__dirname, '..', 'web-ui', 'index.html'), 'utf8');
    assert(html.includes("localStorage.getItem('auroraagent.theme')") && html.includes('dataset.theme'), 'index.html 应首帧预置 data-theme 防闪');
    const theme = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'theme.ts'), 'utf8');
    assert(theme.includes('watchSystemTheme') && theme.includes("matchMedia('(prefers-color-scheme: dark)')"), 'theme.ts 应跟随系统主题');
    const general = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'GeneralPanel.tsx'), 'utf8');
    const apPanel = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'AppearancePanel.tsx'), 'utf8');
    assert(apPanel.includes('useThemePreference'), '设置页应有主题切换（外观面板的界面主题下拉）');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(!/box-shadow:0 14px 44px rgb\(0 0 0/.test(app), '浮层阴影应走令牌，浅色下自动变淡');
  });
  await test('思考强度两级选择器源码契约：思考按钮已并入模型选择器、档位表按上游能力组织', async () => {
    const com = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Composer.tsx'), 'utf8');
    assert(com.includes("useState<'root' | 'model' | 'effort'>('root')"), '模型选择器应为两级结构（根菜单 -> 模型 / 思考强度列表）');
    assert(com.includes('思考强度') && com.includes('mpick-effort') && com.includes('mpick-cell'), '根菜单应有「模型 / 思考强度」两行，触发钮带强度 caption');
    assert(com.includes('EFFORT_LEVELS') && com.includes("id: 'standard'") && com.includes("id: 'off'"), '档位表应按上游真实能力组织（当前仅标准 / 关闭两档，禁虚构轻量深度档）');
    assert(com.includes('onEffort') && !com.includes('onThinking'), '输入区应改用 effort 属性，独立思考按钮已删除');
    assert(!com.includes('bulb') && !com.includes('IconBulb'), '思考按钮（灯泡图标）不应再出现');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    assert(app.includes('changeEffort') && app.includes('patchSession(current.id, { thinking: on })'), 'App 应经 PATCH meta.thinking 落盘思考开关');
    assert(app.includes("setEffort(got.meta.thinking === false ? 'off' : 'standard')"), '打开会话应按 meta.thinking 还原强度');
    assert(app.includes('thinking: effort !== \'off\''), 'turn 请求应按强度带 thinking 布尔');
    const types = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'types.ts'), 'utf8');
    assert(types.includes('thinking?: boolean'), 'SessionMeta 应声明 thinking 字段');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.mpick-effort {') && css.includes('.mpick-chevron'), 'app.css 应有强度 caption 与箭号样式');
    const html = await (await fetch(`${BASE}/`)).text();
    const js = await (await fetch(`${BASE}${/\/app\/assets\/[A-Za-z0-9._-]+\.js/.exec(html)[0]}`)).text();
    assert(js.includes('onEffort'), '构建产物应含强度选择器接线（改了 web-ui 忘了 build:web 会红）');
  });
  await test('输入区窄屏布局源码契约：工具栏可换行、芯片不收缩不折行、尾部右对齐', () => {
    const com = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Composer.tsx'), 'utf8');
    assert(com.includes('className="composer-tail"'), '模型选择器与发送键应收进尾部组，窄屏整组换行不拆散');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    const bar = /\.composer-bar \{[^}]*\}/.exec(css)?.[0] || '';
    assert(!bar.includes('flex-wrap:wrap'), '工具栏不应换行（ZCode 用紧凑收纳代替换行：换行会把输入框顶跳）');
    for (const decl of ['display:flex', 'align-items:flex-end', 'gap:12px']) {
      assert(bar.includes(decl), `工具栏应按 ZCode flex items-end gap-3 声明 ${decl}`);
    }
    const tools = /\.composer-tools \{[^}]*\}/.exec(css)?.[0] || '';
    assert(tools.includes('flex:1') && tools.includes('min-width:0'), '左组应吃剩余宽度并可被压缩（ZCode leading actions）');
    const inner = /\.composer-tools-inner \{[^}]*\}/.exec(css)?.[0] || '';
    for (const decl of ['display:flex', 'align-items:center', 'gap:4px', 'flex:none']) {
      assert(inner.includes(decl), `左组内层应按 ZCode shrink-0 + gap-1 声明 ${decl}`);
    }
    assert(css.includes('.composer-bar[data-compact="1"] .tchip-text'), '窄屏应收成图标钮（ZCode useComposerToolbarFit 首档语义）');
    assert(/\.tchip\s*\{[^}]*flex:none/.test(css), '芯片应禁止收缩，窄屏不被压扁');
    assert(/\.tchip\s*\{[^}]*white-space:nowrap/.test(css), '芯片文字应禁止折行（窄屏标签两行错字的根因）');
    assert(css.includes('.composer-tail {') && css.includes('margin-left:auto'), '尾部组应右对齐，换行后仍贴右');
    assert(/\.tchip-model\s*\{[^}]*min-width:0/.test(css) && /\.tchip-model\s*\{[^}]*flex:0 1 auto/.test(css), '模型芯片应可收缩并以省略号收尾');
  });
  await test('会话标题自动总结源码契约：事件登记、前端实时刷新与产物同步', async () => {
    const events = readFileSync(join(__dirname, '..', 'util', 'agent', 'events.mjs'), 'utf8');
    assert(events.includes("'session_renamed'"), '事件协议应登记 session_renamed');
    const types = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'types.ts'), 'utf8');
    assert(types.includes("type: 'session_renamed'"), '前端事件类型应声明 session_renamed');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    const te = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'turn-events.ts'), 'utf8');
    assert((app + te).includes("ev.type === 'session_renamed'"), 'App 应处理 session_renamed 并实时刷新会话标题');
    const turn = readFileSync(join(__dirname, '..', 'util', 'agent', 'terminal-turn.mjs'), 'utf8');
    assert(turn.includes("case 'session_renamed':"), '终端渲染器应呈现标题更新提示');
    assert(turn.includes('titleMode: TITLE_MODES.includes(session.titleMode)'), '终端应把标题生成方式透传 Loop');
    const term = readFileSync(join(__dirname, '..', 'util', 'agent', 'terminal.mjs'), 'utf8');
    assert(term.includes("{ name: 'title'") && term.includes("argHint: '<local|model>'"), '终端应有 /title 切换命令');
    assert(term.includes("name: 'new'") && term.includes('titleMode: TITLE_MODES.includes(meta.titleMode)'), '终端新建会话应继承标题生成方式');
    const footer = readFileSync(join(__dirname, '..', 'util', 'tui', 'footer.mjs'), 'utf8');
    assert(footer.includes("state.titleMode === 'model'"), '状态栏应在模型总结模式下提示标题段');
    const pickers = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ComposerPickers.tsx'), 'utf8');
    assert(pickers.includes('function TitlePicker'), '标题生成方式选择器应拆在 ComposerPickers');
    const composer = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Composer.tsx'), 'utf8');
    assert(composer.includes('<TitlePicker'), '输入区应挂载标题生成方式选择器');
    assert(pickers.includes("TITLE_HINT.local") === false && pickers.includes('本地推导') && pickers.includes('模型总结'), '选择器应说明两种方式的代价');
    assert(app.includes('changeTitleMode') && app.includes('onTitleMode={changeTitleMode}'), 'App 应接线标题生成方式切换');
    assert(app.includes("setTitleMode(got.meta.titleMode || 'local')"), '打开会话应同步标题生成方式');
    const js2 = await (await fetch(`${BASE}${/\/app\/assets\/[A-Za-z0-9._-]+\.js/.exec(await (await fetch(`${BASE}/`)).text())[0]}`)).text();
    assert(js2.includes('onTitleMode'), '构建产物应含标题选择器接线（改了 web-ui 忘了 build:web 会红；产物里中文被转义，故用 ASCII 标识断言）');
    const html = await (await fetch(`${BASE}/`)).text();
    const js = await (await fetch(`${BASE}${/\/app\/assets\/[A-Za-z0-9._-]+\.js/.exec(html)[0]}`)).text();
    assert(js.includes('session_renamed'), '构建产物应含标题刷新逻辑（改了 web-ui 忘了 build:web 会红）');
  });
  await test('多提供方故障转移源码契约：事件登记、两端渲染、配置与路由在场', () => {
    const events = readFileSync(join(__dirname, '..', 'util', 'agent', 'events.mjs'), 'utf8');
    assert(events.includes("'provider_switched'"), '事件协议应登记 provider_switched');
    const types = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'types.ts'), 'utf8');
    assert(types.includes("type: 'provider_switched'"), '前端事件类型应声明 provider_switched');
    assert(types.includes('PROVIDER_SWITCH_REASONS'), '前端应有切换原因中文映射');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    const te = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'turn-events.ts'), 'utf8');
    assert((app + te).includes("ev.type === 'provider_switched'"), 'App 应处理 provider_switched 并落提示');
    const turn = readFileSync(join(__dirname, '..', 'util', 'agent', 'terminal-turn.mjs'), 'utf8');
    assert(turn.includes("case 'provider_switched':"), '终端渲染器应呈现切换提示');
    const cfg = readFileSync(join(__dirname, '..', 'util', 'config.mjs'), 'utf8');
    assert(cfg.includes('parseFailoverConfig') && cfg.includes('providerFailover'), '配置层应解析故障转移字段');
    const web = readFileSync(join(__dirname, '..', 'web.mjs'), 'utf8');
    assert(web.includes('handleFailoverApi') && web.includes('/api/settings/failover'), 'web.mjs 应委派故障转移设置路由');
    assert(web.includes('candidates: () => providers.all()'), '/api/chat 应接入候选源');
    const loop = readFileSync(join(__dirname, '..', 'util', 'agent', 'loop.mjs'), 'utf8');
    assert(loop.includes('activeProvider') && loop.includes('failoverIo'), 'Loop 应保持 turn 内粘性并接线故障转移');
    const prov = readFileSync(join(__dirname, '..', 'util', 'llm', 'provider.mjs'), 'utf8');
    assert(prov.includes('isFailoverable') && prov.includes('pickFailoverCandidate'), 'openChatStream 应做转移判定与候选挑选');
    const settings = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'SettingsDialog.tsx'), 'utf8');
    assert(settings.includes("case 'failover': return <FailoverPanel />;"), '设置弹层应接入故障转移面板');
    const panel = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'FailoverPanel.tsx'), 'utf8');
    assert(panel.includes('getFailoverSettings') && panel.includes('saveFailoverSettings'), '面板应走 /api/settings/failover 读写');
    assert(!hasEmoji(panel), '故障转移面板零 emoji 铁律');
  });
  await test('Goal 终端接线源码契约：/goal 命令、状态栏芯片与三类事件呈现', async () => {
    const term = readFileSync(join(__dirname, '..', 'util', 'agent', 'terminal.mjs'), 'utf8');
    assert(term.includes("name: 'goal'") && term.includes('parseGoalCommand(arg)'), '终端 /goal 应走共享解析器');
    assert(term.includes('setUserGoalObjective(goals, meta.id, intent.objective'), '终端应支持 /goal <目标内容> 设立或改写');
    assert(term.includes('clearUserGoal(goals, meta.id)'), '终端应支持 /goal clear 移除');
    assert(term.includes("rl.write(`/goal ") && term.includes('GOAL_COMMAND_HELP'), '终端应支持 edit 回填与帮助输出');
    assert(term.includes("goalUsageChip(g) : null") && term.includes("g.status === 'active'"), '状态栏仅对进行中目标显示芯片');
    const turn = readFileSync(join(__dirname, '..', 'util', 'agent', 'terminal-turn.mjs'), 'utf8');
    assert(turn.includes("case 'goal_created':"), '终端应呈现目标创建');
    assert(turn.includes("case 'goal_status_changed':") && turn.includes('lastGoalStatus'), '终端应去重呈现状态变更');
    assert(turn.includes("case 'goal_wait_changed':") && turn.includes('GOAL_WAIT_LABELS[p.reason]'), '终端应呈现等待中');
    const footer = readFileSync(join(__dirname, '..', 'util', 'tui', 'footer.mjs'), 'utf8');
    assert(footer.includes("state.goal") && footer.includes("label: '目标'"), '状态栏应有目标段');
    const types = readFileSync(join(__dirname, '..', 'util', 'agent', 'goal', 'types.mjs'), 'utf8');
    assert(types.includes('GOAL_WAIT_LABELS'), 'goal 类型模块应有等待原因文案表');
  });
  await test('Goal 前端接线源码契约：GoalBar 单行条、四类事件联合类型与产物同步', async () => {
    const types = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'types.ts'), 'utf8');
    for (const t of ["type: 'goal_created'", "type: 'goal_status_changed'", "type: 'goal_usage_updated'", "type: 'goal_wait_changed'"]) {
      assert(types.includes(t), `前端事件类型应声明 ${t}`);
    }
    assert(types.includes('GoalStatus') && types.includes('goalActionsFor'), '前端应有 Goal 状态类型与动作裁剪函数');
    const bar = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'GoalBar.tsx'), 'utf8');
    assert(bar.includes('goalbar-chip') && bar.includes('GOAL_STATUS_LABELS[goal.status]'), '目标条应有状态芯片');
    assert(bar.includes('goalActionsFor(goal.status)'), '目标条动作应按状态裁剪');
    assert(bar.includes('tokenBudget != null'), '目标条应展示预算上限');
    assert(bar.includes('goal.turnsUsed') && bar.includes('formatGoalDuration'), '目标条应展示轮次用量与活跃时长');
    assert(bar.includes('setInterval') && bar.includes('goalActionHint(goal.status)'), '目标条应有 live elapsed 与随状态动作提示');
    assert(bar.includes("goal.status === 'complete') return null"), '目标条 complete 时隐藏（回执由 notice 承载，对齐 MiniMax banner）');
    assert(bar.includes('GOAL_WAIT_LABELS[goal.executionWait') && bar.includes('chipLabel'), 'active 等待时用等待标签替换状态芯片（对齐 MiniMax goalPresentation）');
    assert(bar.includes('goalbar-verify') && bar.includes('notMetStreak'), '目标条应压入验证结论芯片（verdict × 连击）');
    assert(bar.includes('goalbar-objective') && bar.includes('data-goal-bar'), '目标条应为单行结构（目标省略 + data 钩子），不是半透明遮罩');
    assert(!hasEmoji(bar), 'GoalBar 零 emoji 铁律');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    const te = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'turn-events.ts'), 'utf8');
    assert((app + te).includes("ev.type === 'goal_created'") && (app + te).includes('setGoal(ev.goal)'), 'App 应处理四类 goal 事件');
    assert(app.includes('goalAction(currentId, action)') && app.includes('onAction={decideGoal}'), 'App 应接线目标条动作回传');
    assert(app.includes('handleGoalCommand') && app.includes('onGoalCommand={handleGoalCommand}'), 'App 应接线 /goal 命令处理');
    assert(app.includes('parseGoalCommand(rawArgs)') && app.includes('createGoal(sid') && app.includes('editGoal(sid'), 'App 应走共享解析器并区分创建与改写');
    assert(app.includes("kind: 'notice'") && !app.includes("kind: 'system', key: `g"), 'goal 命令输出应走 notice 消息（不套压缩摘要前缀）');
    assert(app.includes('onlyIfEmpty: true') && app.includes('输入已保留'), 'goal 命令失败应原样回填用户输入（对齐 MiniMax goal-flow 的 retained 语义）');
    assert(app.includes('当前没有会话'), '无会话时 goal 命令应给出提示而非静默（对齐 MiniMax 的 session 缺失告警）');
    assert(app.includes("'已暂停', resume: '已恢复', stop: '已停止'") && app.includes('GOAL_STATUS_LABELS[r.goal.status]'), 'pause/resume/stop 应回执状态（与终端 REPL 同源）');
    assert(app.includes('编辑目标文本后按 Enter 提交'), '/goal edit 回填后应给出操作提示（对齐 MiniMax setHint）');
    assert(/open = parts\.findIndex\(\(p\) => p\.kind === 'tool' && p\.id === ev\.toolId && p\.phase !== 'done'/.test(app + te), '流式 tool_event 同 id 多调用应优先更新未完结卡片（上游复用 id 不顶掉已完结调用）');
    assert((app + te).includes('else if (idx < 0) parts.push(view)'), '重复完成事件不得重复补卡（同 id 前一个调用已完结时忽略）');
    assert((app + te).includes("scope === 'main' && setGoal && ev.sessionId === currentIdRef.current) setGoal(ev.goal)"), 'SSE goal 事件应校验会话归属（对齐 MiniMax goal-flow.project 首行 sessionId 校验）');
    assert(app.includes('const stale = () => goalViewEpochRef.current !== epoch || currentIdRef.current !== sid;'), 'goal 命令回调应捕获发起时会话与纪元（对齐 MiniMax canProjectOperation）');
    assert(app.split('if (stale()) return;').length - 1 >= 4, 'goal 命令四类异步回调（clear / create / budget / pause·resume·stop）应依次防串会话');
    assert(app.includes('existing = (await getGoal(sid)).goal;') && app.includes('if (stale()) return;\n    setGoal(existing);'), 'goal 命令执行前应取新鲜目标快照再分派（对齐 MiniMax execute() 的 runtime.getGoal）');
    assert(/unfinished = existing !== null && existing\.status !== 'complete';/.test(app), 'create-or-edit 判定应基于新鲜快照而非 React state');
    assert(/if \(!currentId && intent\.kind !== 'create'\)/.test(app), '无会话时非 create 意图应直接告警（对齐 MiniMax execute() 的 session 缺失分支）');
    assert(app.includes('await createSession({})') && app.includes('await openSession(s.id)') && app.includes('currentIdRef.current = s.id;'), '无会话且 create 应先自动建会话再设立目标（对齐 MiniMax ensureSessionId；等会话落地防回执被投影冲掉）');
    assert(app.includes('无法为当前目标创建会话'), '自动建会话失败应给出可操作提示（对齐 MiniMax 的 ensureSessionId 失败分支）');
    const goalEvents = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'goal-events.ts'), 'utf8');
    assert(goalEvents.includes('/api/agent/events?sessionId=') && goalEvents.includes("'goal_cleared'"), 'goal-events 模块应订阅 /api/agent/events 并覆盖 goal_cleared');
    assert(app.includes('connectGoalEvents(currentId') && app.includes("ev.type === 'goal_cleared'"), 'App 应接线跨客户端 goal 事件流并按 goal_cleared 清横幅（对齐 MiniMax 全局事件投影）');
    assert(app.includes('if (ev.sessionId !== currentIdRef.current) return;'), '跨客户端事件流应校验会话归属（切会话后迟到的帧不投影）');
    assert(app.includes('const epoch = ++goalViewEpochRef.current;') && app.includes('if (goalViewEpochRef.current !== epoch) return;'), 'openSession 迟到响应应凭纪元丢弃（快切会话不投影旧会话内容）');
    assert(/当前没有会话[\s\S]{0,240}setGoalPrefill/.test(app), '无会话时 goal 命令应原样回填草稿（对齐 MiniMax retained 语义）');
    const msg = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Message.tsx'), 'utf8');
    assert(msg.includes("msg.kind === 'notice'") && msg.includes('row-notice'), 'Message 应渲染 notice 行');
    assert(/msg\.kind === 'notice'[\s\S]{0,200}\{msg\.text\}/.test(msg), 'notice 行应直出文本（不套压缩摘要前缀）');
    assert(app.includes('<GoalBar goal={goal}') && app.indexOf('<GoalBar') < app.indexOf('<Composer'), 'App 应在输入框上方挂载目标条（不再走 ChatView 半透明横幅）');
    const composerSrc = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Composer.tsx'), 'utf8');
    assert(composerSrc.includes('onGoalCommand') && composerSrc.includes("/^\\/goal(\\s|$)/"), 'Composer 应拦截 /goal 命令');
    assert(composerSrc.includes('goalPrefill') && composerSrc.includes('lastPrefillNonce'), 'Composer 应支持 edit 回填（nonce 去重）');
    assert(composerSrc.includes('Enter 不拦截，落到下方统一提交'), '技能调色板无匹配时不应吞掉 /goal 命令的 Enter');
    assert(composerSrc.includes('onlyIfEmpty'), 'Composer 回填应支持 onlyIfEmpty（失败保留不覆盖新输入）');
    const goalCmdIdx = composerSrc.indexOf('/^\\/goal(\\s|$)/.test(t) && onGoalCommand');
    const busyGuardIdx = composerSrc.indexOf('if (busy) {');
    assert(goalCmdIdx >= 0 && busyGuardIdx > goalCmdIdx, 'Composer 应放行 /goal 命令穿越 busy（对齐 MiniMax：catalog 命令在 turn 运行中直接 dispatch）');
    assert(composerSrc.includes('composer-queue') && composerSrc.includes('onQueuePromote'), 'Composer 应渲染消息队列条（#3212）');
    // 底部那行长提示已按要求整行移除；「生成中可管目标」改由斜杠命令目录发现
    assert(!composerSrc.includes('composer-hint'), 'Composer 底部提示行应已移除（用户明确要求删掉）');
    const slashSrc = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'slash-commands.ts'), 'utf8');
    assert(slashSrc.includes("name: 'goal'") && slashSrc.includes('会话目标'), '/goal 家族应仍在斜杠命令目录里（输入 / 即列，生成中可直接 dispatch）');
    // turn 收尾刷新：notice（/goal 命令回执）只存在于本地、不在服务端转录里，整体替换会把它冲掉，
    // 「生成中可管理目标」就收不到任何反馈；同时按会话守卫，避免旧 turn 投影写进已切走的会话
    assert(app.includes('currentIdRef.current === sessionId') && (app + te).includes("prev.filter((m) => m.kind === 'notice')"), 'turn 收尾刷新应保留本地 notice 并按会话守卫');
    const api = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'api.ts'), 'utf8');
    assert(api.includes('/api/agent/goal/${sessionId}') && api.includes('/api/agent/goal/${action}'), 'api 客户端应覆盖 goal 读与动作');
    assert(api.includes('createGoal') && api.includes('editGoal') && api.includes('clearGoal'), 'api 客户端应覆盖设立 / 改写 / 移除');
    const html = await (await fetch(`${BASE}/`)).text();
    const js = await (await fetch(`${BASE}${/\/app\/assets\/[A-Za-z0-9._-]+\.js/.exec(html)[0]}`)).text();
    assert(js.includes('goalbar'), '构建产物应含目标条（改了 web-ui 忘了 build:web 会红）');
    // @ 提及：调色板组件、Composer 接线与产物同步
    const mention = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'MentionPalette.tsx'), 'utf8');
    assert(mention.includes('mentionpal-item') && mention.includes('kind') && !hasEmoji(mention), 'MentionPalette 应有列表项与类型徽标且零 emoji');
    const composer = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Composer.tsx'), 'utf8');
    assert(composer.includes('MentionPalette') && composer.includes('insertMention') && composer.includes('searchFiles(sessionId, q)'), 'Composer 应接 @ 提及时调色板与防抖搜索');
    assert(composer.includes('/api/files/search') === false, '前端不直连路径，走 api.ts');
    assert(js.includes('mentionpal'), '构建产物应含提及调色板（改了 web-ui 忘了 build:web 会红）');
    // 会话派生：侧栏入口、api 客户端、App 接线与产物同步
    const sidebar = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Sidebar.tsx'), 'utf8');
    assert(sidebar.includes('sb-act') && sidebar.includes('onFork(s.id)') && !hasEmoji(sidebar), '侧栏应有派生入口且零 emoji');
    const api2 = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'api.ts'), 'utf8');
    assert(api2.includes('/api/agent/sessions/${id}/fork') && api2.includes('forkSession'), 'api 客户端应覆盖会话派生');
    assert(app.includes('forkSession(id)') && app.includes('onFork={forkSessionById}'), 'App 应接线派生会话');
    assert(js.includes('sb-act'), '构建产物应含侧栏行操作钮（改了 web-ui 忘了 build:web 会红）');
    // 终端偏好面板：标题项序 / 通知三档 / 浏览器通知开关
    const tuiPanel = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'TuiPanel.tsx'), 'utf8');
    assert(tuiPanel.includes('tui-chip') && tuiPanel.includes('saveTuiSettings') && tuiPanel.includes('browserNotifyEnabled') && !hasEmoji(tuiPanel), 'TuiPanel 应有芯片开关与保存接线且零 emoji');
    assert(tuiPanel.includes('/api/settings/tui') === false, '前端不直连路径，走 api.ts');
    const api3 = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'api.ts'), 'utf8');
    assert(api3.includes('/api/settings/tui') && api3.includes('getTuiSettings') && api3.includes('saveTuiSettings'), 'api 客户端应覆盖终端偏好读写');
    const dlg = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'SettingsDialog.tsx'), 'utf8');
    assert(dlg.includes("case 'terminal': return <TuiPanel />;"), '设置弹层应挂载终端偏好面板');
    assert(js.includes('tui-chip'), '构建产物应含终端偏好面板（改了 web-ui 忘了 build:web 会红）');
    // 网络面板：代理输入、保存接线与产物同步
    const proxyPanel = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ProxyPanel.tsx'), 'utf8');
    assert(proxyPanel.includes('validateProxyInput') && proxyPanel.includes('setAgentProxy') && proxyPanel.includes('127.0.0.1:7890') && !hasEmoji(proxyPanel), 'ProxyPanel 应有校验 / 保存接线与端口示例且零 emoji');
    assert(proxyPanel.includes('/api/settings/proxy') === false, '前端不直连路径，走 api.ts');
    assert(dlg.includes("case 'network': return <ProxyPanel />;"), '设置弹层应挂载网络面板');
    assert(js.includes('np-input'), '构建产物应含网络面板（改了 web-ui 忘了 build:web 会红）');
  });
  await test('OSC 终端标题接线源码契约：状态词随模式变、挂起清除、退出清空', async () => {
    const term = readFileSync(join(__dirname, '..', 'util', 'agent', 'terminal.mjs'), 'utf8');
    assert(term.includes('buildTerminalTitle(cfg.tui.terminalTitle'), '标题应按 tui.terminalTitle 项序拼装');
    assert(term.includes("state: btwMode ? '侧边对话' : busy ? '生成中' : '就绪'"), '状态词应随侧边/生成态切换');
    assert(term.includes("process.on('SIGTSTP'") && term.includes("'SIGSTOP'"), '挂起应用不可捕获的 SIGSTOP 真正停下（Node 会拦截 SIGTSTP 重发）');
    assert(term.includes("process.on('SIGCONT'") && term.includes('applyTitle'), '恢复后应重设标题');
    assert(term.includes('const cleanExit = ()') && term.split('process.exit(0)').length - 1 <= 1, '退出应统一走 cleanExit 清标题');
    const title = readFileSync(join(__dirname, '..', 'util', 'tui', 'title.mjs'), 'utf8');
    assert(title.includes('export function oscTitle') && title.includes('export function clearTitle'), '标题模块应导出写/清两个函数');
    // 通知接线：创建处传配置、渲染器四类事件各有着落
    assert(term.includes('createNotifier({ notifications: cfg.tui.notifications })'), '协调器应建通知器');
    const turn = readFileSync(join(__dirname, '..', 'util', 'agent', 'terminal-turn.mjs'), 'utf8');
    assert(turn.includes("notifier?.notify('turn-complete'") && turn.includes("notifier?.notify('turn-failed'"), '完成与失败应通知');
    assert(turn.includes("notifier?.notify('permission-required'") && turn.includes("notifier?.notify('question-required'"), '授权询问与计划待批准应通知');
    const notify = readFileSync(join(__dirname, '..', 'util', 'tui', 'notify.mjs'), 'utf8');
    assert(notify.includes('probeFocused') && notify.includes('timeout: timeoutMs'), '焦点探测应带超时');
    assert(notify.includes('resolve(false)') || notify.includes('done(false)'), '探测失败应按未聚焦处理');
  });
  await test('侧边对话接线源码契约：/btw 命令、Ctrl+/ 切换、丢弃与侧边路由', async () => {
    const term = readFileSync(join(__dirname, '..', 'util', 'agent', 'terminal.mjs'), 'utf8');
    assert(term.includes("name: 'btw'") && term.includes('argHint: \'<问题>\''), '终端应有 /btw 命令');
    assert(term.includes('new SideSession(meta, { prefix: store.records(meta.id) })'), '/btw 应带主会话历史前缀开侧边会话');
    assert(term.includes('goalStore: side ? null : goals'), '侧边对话不接管 goal');
    // Ctrl+/ 监听必须先于 createInterface（data 监听按注册序触发，先摘 keypress 防缓冲污染）
    assert(term.indexOf("process.stdin.on('data'") < term.indexOf('const rl = createInterface'), 'Ctrl+/ 监听必须早于 readline 创建');
    assert(term.includes("String(d) !== '\\x1f'") && term.includes("removeListener('keypress'"), 'Ctrl+/ 应先摘 keypress 监听再处理');
    assert(term.includes('ctrlSlash.handler = () => {') && term.includes('btwMode = !btwMode'), 'Ctrl+/ 应切换主/侧边模式');
    assert(term.includes("else if (btwMode) discardBtw();"), '侧边模式 Ctrl+C 应丢弃侧边对话');
    assert(term.includes('await runTurn(line, btwMode && Boolean(btw))'), '普通输入应按模式路由');
    assert(term.includes('redrawPrompt') && term.includes('rl.prompt(true)'), '异步输出后应重绘提示符');
  });
  await test('流式活动状态行源码契约：轮次 / 工具数 / 计时与费用行统一', () => {
    const cv = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ChatView.tsx'), 'utf8');
    assert(cv.includes('live-status') && cv.includes('useElapsed') && cv.includes('第 {live.round || 1} 轮'), '流式行应有活动状态（轮次 / 工具 / 计时）');
    assert(cv.includes('fmtCostYen'), '流式费用行应走统一格式化');
    const msg = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Message.tsx'), 'utf8');
    assert(msg.includes('fmtCostYen') && !msg.includes('toFixed(6)'), '历史费用行应走统一格式化且不再私持逻辑');
    const proj = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'projection.ts'), 'utf8');
    assert(proj.includes('export const fmtCostYen'), 'projection 应导出费用行助手');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.live-status'), 'app.css 应有状态行样式');
  });
  await test('turn 级时间线源码契约：历史与流式同形态 parts，回答不被工具调用切断', () => {
  const types = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'types.ts'), 'utf8');
  assert(types.includes('export type MsgPart') && types.includes("kind: 'text'") && types.includes("kind: 'tool'"), 'types 应声明 parts 时间线类型');
  assert(!types.includes('tools: ToolView[]'), 'assistant 视图不应再平铺 tools 列表（按时间线交错渲染）');
  const proj = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'projection.ts'), 'utf8');
  assert(proj.includes('parts: t.parts.map'), '历史投影应按 parts 映射');
  const msg = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Message.tsx'), 'utf8');
  assert(msg.includes('msg.parts.map') && msg.includes("p.kind === 'text'"), '历史消息应按 parts 顺序渲染文本与工具卡');
  const cv = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ChatView.tsx'), 'utf8');
  assert(cv.includes('live.parts.map') && cv.includes("p.kind === 'text'"), '流式行应按 parts 顺序渲染');
  const te = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'turn-events.ts'), 'utf8');
  assert(te.includes('appendTextPart'), '文本增量应追到最后文本片段（工具后的新文本开新片段）');
  const tr = readFileSync(join(__dirname, '..', 'util', 'agent', 'transcript.mjs'), 'utf8');
  assert(tr.includes("parts.push({ kind: 'tool'") && tr.includes('t.text = t.parts.filter'), '后端投影应产出 parts 时间线与兼容视图');
});
await test('代码高亮源码契约：Markdown 代码块接入零依赖高亮器', () => {
    const md = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'markdown.tsx'), 'utf8');
    assert(md.includes("from './highlight'") && md.includes('highlightCode(buf.join'), '代码块应走高亮器');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.md pre .c-key') && css.includes('.md pre .c-str') && css.includes('.md pre .c-com'), '高亮 token 应有语义样式');
  });
  await test('技能界面源码契约：设置技能目录在场，技能并入斜杠命令菜单', () => {
    const sp = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'SkillsPanel.tsx'), 'utf8');
    assert(sp.includes('listSkills') && sp.includes('/<技能名>'), '技能目录应列出并说明调用方式');
    assert(!existsSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'SkillPalette.tsx')), '独立技能调色板应退役（技能已并入斜杠命令菜单）');
  });
  await test('斜杠命令菜单源码契约：命令目录、实时过滤、dsh 数值与两档回车', () => {
    const cat = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'slash-commands.ts'), 'utf8');
    // 目录与终端 baseCommands 同源：16 条基础命令一个不落
    for (const name of ['help', 'new', 'sessions', 'model', 'harness', 'theme', 'mcp', 'title', 'goal', 'btw', 'plan', 'think', 'temp', 'max', 'key', 'quit']) {
      assert(cat.includes(`name: '${name}'`), `命令目录应登记 /${name}`);
    }
    assert(cat.includes('aliases:') && cat.includes('exit'), '同义名应登记（/exit 即 /quit）');
    assert(cat.includes('export function filterEntries') && cat.includes('export function findEntry') && cat.includes('export function buildRows'), '应导出过滤 / 精确查找 / 行合成三个纯函数');
    assert(/startsWith\(q\) \? 0 : 1/.test(cat), '排名应让前缀命中排前（对齐 dsh rankByName）');
    const pal = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'CommandPalette.tsx'), 'utf8');
    assert(pal.includes('role="listbox"') && pal.includes('aria-activedescendant') && pal.includes('role="option"'), '菜单应具备 listbox / option 无障碍语义');
    assert(pal.includes('onMouseDown={(e) => { e.preventDefault(); onPick(r); }}'), '点选应阻止默认行为，别抢走输入框焦点');
    assert(pal.includes('scrollIntoView'), '键盘导航时应把高亮行滚入可视区');
    assert(!hasEmoji(pal), '斜杠菜单零 emoji 铁律');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    // 数值对齐 dsh web MenuView
    const menuBlock = /\.cmdpal \{([^}]*)\}/.exec(css)?.[1] || '';
    for (const decl of ['max-height:320px', 'border-radius:20px', 'padding:4px', 'bottom:calc(100% + 4px)', 'left:0; right:0', 'z-index:100']) {
      assert(menuBlock.includes(decl), `菜单应按 dsh 数值声明 ${decl}`);
    }
    assert(css.includes('min-height:40px') && css.includes('border-radius:10px') && css.includes('font-size:1rem'), '菜单行应按 dsh 数值：40px / radius10 / 1rem（rem 化后 1rem=界面字号 14px）');
    assert(css.includes('.cmdpal-section') && css.includes('min-height:26px'), '组标题应按 dsh 数值：26px 高');
    assert(!css.includes('.skillpal-item'), '旧调色板样式应退役');
    const com = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Composer.tsx'), 'utf8');
    assert(com.includes('CommandPalette') && com.includes('slashRows'), '输入区应接入斜杠命令菜单并持有过滤结果');
    assert(com.includes('/(^|\\s)\\/([^\\s]*)$/'), '斜杠触发应是「行首或空白之后的 / 开头词」，URL 里的斜杠不触发');
    assert(com.includes('buildRows(slashQuery, skills)'), '菜单行应随输入实时重组（命令 + 技能）');
    assert(com.includes('completeSlash') && com.includes('rowImmediate'), '回车应分两档：无参数命令即执行，带参数命令只补全');
    assert(com.includes('if (e.key === \'Tab\') {') && com.includes('Tab 只补全'), 'Tab 只补全不执行');
    assert(com.includes('Enter 不拦截，落到下方统一提交'), '无匹配时 Enter 不拦截，/goal 与未知 /xxx 仍能直接发出');
    assert(com.includes('slashDismissed'), 'Esc 只关菜单（用 dismissed 标记防同一内容立刻重开）');
    assert(!com.includes('className="tchip tchip-plan"') && !com.includes('onPlanMode'), '独立计划按钮应退役，开关并入 /plan 命令');
    assert(com.includes('className="composer-plan"') && com.includes('composer-plan-sep') && com.includes('role="status"'), '计划模式改为状态标记（ZCode plan marker：分隔线 + 图标 + 标签）');
    // 命令分发：App 侧落地
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    assert(app.includes('handleCommand') && app.includes('onCommand={'), 'App 应接线斜杠命令分发');
    for (const name of ['help', 'new', 'sessions', 'theme', 'mcp', 'title', 'btw', 'plan', 'think', 'temp', 'max', 'key', 'quit']) {
      assert(app.includes(`case '${name}':`), `App 应落地 /${name}`);
    }
    assert(app.includes('setPickerRequest') && app.includes('pickerNonce={pickerRequest?.nonce}'), '/model 与 /harness 应经 nonce 唤起对应选择器');
    // 色彩语义提示
    assert(com.includes('composer-cmdhint') && com.includes('leadKnown'), '输入合法命令后应给色彩语义提示');
    assert(css.includes('.composer-cmdhint.ok') && css.includes('.composer-cmdhint.warn'), '语义提示应有合法 / 未知两态配色');
    const tokens = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'tokens.css'), 'utf8');
    assert(tokens.includes('--warn-ink:') && tokens.includes(':root[data-theme="light"]'), '警告色应有双主题令牌');
    assert(tokens.includes('--warn-bg:') && tokens.includes('--warn-line:'), '警告色应有背景与描边变体');
  });
  await test('转录投影层源码契约：工具词表两端同源', () => {
    const tr = readFileSync(join(__dirname, '..', 'util', 'agent', 'transcript.mjs'), 'utf8');
    assert(tr.includes('export function toolLabel') && tr.includes('export function projectTurns'), 'transcript.mjs 应导出词表与投影');
    assert(existsSync(join(__dirname, '..', 'util', 'agent', 'transcript.d.mts')), '应有配套类型声明供 Web 取类型');
    const proj = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'projection.ts'), 'utf8');
    assert(proj.includes("from '../../util/agent/transcript.mjs'") && proj.includes('projectTurns(records'), 'Web 投影应委托 transcript 的分组规则');
    const card = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ToolCard.tsx'), 'utf8');
    assert(card.includes("from '../../../util/agent/transcript.mjs'") && card.includes('toolLabel(tool.name)') && card.includes('toolIconKey(tool.name)'), '工具卡标签与图标应取自共享词表');
    assert(!card.includes('TOOL_META'), '工具卡不应再私持标签表（曾漂移缺 task / MCP）');
    const term = readFileSync(join(__dirname, '..', 'util', 'agent', 'terminal-format.mjs'), 'utf8');
    assert(term.includes("export { toolLabel, fmtCost } from './transcript.mjs'"), '终端词表应转置到 transcript');
  });
  await test('MCP 管理面板源码契约：设置弹层可管理服务器与实验门控提示', () => {
    const panel = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'McpPanel.tsx'), 'utf8');
    assert(panel.includes('AURORAAGENT_EXPERIMENTAL_MCP=1'), '未开启实验时应给出开启指引');
    assert(panel.includes('mcp__') && panel.includes('测试连接') && panel.includes('stdio') && panel.includes('http'), '面板应呈现工具命名规则、连接测试与两种传输');
    const settings = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'SettingsDialog.tsx'), 'utf8');
    assert(settings.includes("case 'mcp': return <McpPanel />;"), '设置弹层应嵌入 MCP 面板');
    const api = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'api.ts'), 'utf8');
    assert(api.includes('listMcpServers') && api.includes('createMcpServer') && api.includes('deleteMcpServer') && api.includes('probeMcpServer'), 'api 客户端应覆盖 MCP 四个调用');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.mcp-form') && css.includes('.mcp-form-row'), 'app.css 应有 MCP 表单样式');
  });
  await test('MCP 显示开关源码契约：行尾开关、停用禁探测、后端 enabled 路由', () => {
    const panel = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'McpPanel.tsx'), 'utf8');
    assert(panel.includes('mcp-toggle') && panel.includes('aria-pressed={s.enabled}'), 'MCP 行应有显示开关并标记 aria-pressed');
    assert(panel.includes('setMcpServerEnabled(s.id, !s.enabled)'), '开关应走后端 enabled 路由');
    assert(/disabled=\{busy === `probe:\$\{s\.id\}` \|\| !s\.enabled\}/.test(panel), '停用的服务器不应再允许测试连接');
    assert(panel.includes('已停用') && panel.includes('已启用'), '开关与徽标应说清当前开关状态');
    const api = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'api.ts'), 'utf8');
    assert(api.includes('/api/mcp/servers/${id}/enabled'), 'api 客户端应覆盖显示开关路由');
    const http = readFileSync(join(__dirname, '..', 'util', 'agent', 'http.mjs'), 'utf8');
    assert(http.includes("mcpMatch[2] === '/enabled'") && http.includes('mcp.setEnabled(mcpMatch[1], body.enabled)'), '后端应接 enabled 路由并落盘');
    assert(http.includes("mcpMatch[2] === '/probe'"), 'probe 分支应精确匹配，不能被 /enabled 抢走');
    assert(http.includes("typeof body.enabled !== 'boolean'"), 'enabled 必须做布尔校验');
    const reg = readFileSync(join(__dirname, '..', 'util', 'mcp', 'registry.mjs'), 'utf8');
    assert(reg.includes('setEnabled(id, enabled)') && reg.includes('target.enabled = enabled !== false'), '注册表应提供显示开关并原子落盘');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.mcp-toggle') && css.includes('.mcp-toggle.on'), 'app.css 应有开关两态样式');
  });
  await test('旧 UI 已退役：提供方模块与样式不再服务', async () => {
    eq((await fetch(`${BASE}/providers.mjs`)).status, 404);
    eq((await fetch(`${BASE}/providers.css`)).status, 404);
    assert(!existsSync(join(__dirname, '..', 'public', 'index.html')), '旧聊天页应已删除');
  });
  await test('提供方编辑器移植了服务端校验规则（源码契约）', async () => {
    const src = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'ProviderEditor.tsx'), 'utf8');
    assert(src.includes('export function validateDraft'), '缺少草稿校验函数');
    assert(src.includes('BUILTIN_ID') && src.includes('是内置提供方的 ID'), '缺少内置 ID 保留规则');
    assert(src.includes('ENV_LINE') && src.includes('isQuoted'), '缺少 API 密钥格式规则');
    assert(src.includes('MAX_MODELS'), '缺少模型数量上限');
    assert(src.includes('至少需要一个模型'), '缺少空目录兜底话术');
  });
  await test('静态资源走白名单，目录穿越取不到文件', async () => {
    eq((await fetch(`${BASE}/web.mjs`)).status, 404);
    eq((await fetch(`${BASE}/../web.mjs`)).status, 404);
    eq((await fetch(`${BASE}/util/providers.mjs`)).status, 404);
  });
  await test('GET /util/sse.mjs 提供模块', async () => {
    const r = await fetch(`${BASE}/util/sse.mjs`);
    eq(r.status, 200);
    assert((await r.text()).includes('SseParser'));
  });
  await test('/api/status 报告 Key 状态', async () => {
    const j = await (await fetch(`${BASE}/api/status`)).json();
    eq(j.hasKey, true); eq(j.model, 'LongCat-2.5-Preview');
  });
  await test('/api/models 返回模型目录（可读名 + 标签）', async () => {
    const j = await (await fetch(`${BASE}/api/models`)).json();
    eq(j.ok, true); eq(j.status, 'ready');
    eq(j.default, 'LongCat-2.5-Preview');
    eq(j.models.length, 2);
    const p = j.models.find((m) => m.id === 'LongCat-2.5-Preview');
    eq(p.name, 'LongCat 2.5'); eq(p.tag, 'Preview'); eq(p.owned, true);
    const v2 = j.models.find((m) => m.id === 'LongCat-2.0');
    eq(v2.name, 'LongCat 2.0'); eq(v2.tag, '');
  });
  await test('/api/chat 按前端所选模型请求上游', async () => {
    await readStream(await chat({ messages: [{ role: 'user', content: 'hi' }], model: 'LongCat-2.0' }));
    eq(mock.state.lastChatBody.model, 'LongCat-2.0');
  });
  await test('/api/chat 对非法模型值回退到配置默认', async () => {
    await readStream(await chat({ messages: [{ role: 'user', content: 'hi' }], model: 'bad model!!' }));
    eq(mock.state.lastChatBody.model, 'LongCat-2.5-Preview');
  });
  await test('/api/health 存活', async () => {
    const j = await (await fetch(`${BASE}/api/health`)).json();
    eq(j.ok, true);
  });
  await test('流式对话透传 SSE 且带 usage', async () => {
    const resp = await chat({ messages: [{ role: 'user', content: 'hi' }], thinking: true });
    eq(resp.status, 200);
    eq(resp.headers.get('content-type'), 'text/event-stream');
    const s = await readStream(resp);
    assert(s.raw.includes('LongCat-2.5-Preview'), '缺少回答内容');
    assert(s.think.length > 0, '缺少思考内容');
    assert(s.usage && s.usage.completion_tokens === 15, '缺少 usage');
  });
  await test('思考关闭时不带 thinking.enabled', async () => {
    const resp = await chat({ messages: [{ role: 'user', content: 'hi' }], thinking: false });
    await readStream(resp);
    eq(mock.state.lastChatBody.thinking.type, 'disabled');
  });
  await test('内置提供方的请求载荷保持原样（max_tokens/temperature/thinking）', async () => {
    await readStream(await chat({ messages: [{ role: 'user', content: '载荷检查' }] }));
    const b = mock.state.lastChatBody;
    eq(b.thinking.type, 'enabled');
    eq(b.max_tokens, 32768);
    eq(b.temperature, 0.7);
    eq(b.stream, true);
    eq(mock.state.lastChatMeta.url, '/openai/v1/chat/completions');
    eq(mock.state.lastChatMeta.authorization, 'Bearer ak-test-key');
  });
  await test('图片路径转成视觉消息', async () => {
    const resp = await chat({ messages: [{ role: 'user', content: '占位' }], imagePath: tmpPng, imageText: '这是什么' });
    const s = await readStream(resp);
    assert(s.raw.includes('蓝色的圆形'), '视觉回答不符');
    const last = mock.state.lastChatBody.messages.at(-1);
    assert(Array.isArray(last.content), '最后一条不是视觉消息');
    eq(last.content[0].type, 'image_url');
    assert(last.content[0].image_url.url.startsWith('data:image/png;base64,'), '不是 base64 data URL');
    eq(last.content[1].text, '这是什么');
  });
  await test('401 映射为友好提示', async () => {
    const resp = await chat({ messages: [{ role: 'user', content: 'BAD_KEY' }] });
    const j = await resp.json();
    assert(j.error.message.includes('API Key 无效'), '提示不友好: ' + j.error.message);
  });
  await test('402 映射为额度提示', async () => {
    const resp = await chat({ messages: [{ role: 'user', content: 'NO_QUOTA' }] });
    const j = await resp.json();
    assert(j.error.message.includes('额度'), '提示不友好: ' + j.error.message);
  });
  await test('图片路径不存在时返回可读错误', async () => {
    const resp = await chat({ messages: [{ role: 'user', content: 'x' }], imagePath: '/tmp/definitely-not-here.png' });
    const j = await resp.json();
    assert(j.error.message.includes('图片读取失败'), '错误信息不符');
  });
  await test('用量账本记录并汇总', async () => {
    const before = (await (await fetch(`${BASE}/api/usage`)).json()).totals.requests;
    await (await chat({ messages: [{ role: 'user', content: '记账测试' }] })).body?.cancel();
    await readStream(await chat({ messages: [{ role: 'user', content: '记账测试2' }] }));
    const j = await (await fetch(`${BASE}/api/usage`)).json();
    assert(j.totals.requests >= before + 1, '账本未记录');
    assert(j.totals.inputTokens > 0 && j.totals.outputTokens > 0, 'token 未记录');
  });
  await test('/api/abort 对未知 requestId 返回 aborted:false', async () => {
    const j = await (await fetch(`${BASE}/api/abort`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'no-such-request-id' }),
    })).json();
    eq(j.aborted, false);
  });
  await test('用量汇总带统计视图：逐日补零与四类构成', async () => {
    const j = await (await fetch(`${BASE}/api/usage`)).json();
    assert(j.totals && j.stats, '应同时返回汇总与统计视图');
    eq(j.stats.byDay.length, 30, '近 30 天逐日数据');
    assert(Array.isArray(j.stats.byModel) && Array.isArray(j.stats.byProvider) && Array.isArray(j.stats.bySession), '应有构成分组');
    const lite = await (await fetch(`${BASE}/api/usage?lite=1`)).json();
    assert(lite.totals && !lite.stats, 'lite 模式只取汇总与最近记录');
  });
  await test('错误日志：前端上报落盘、30 秒去重、查看与清空', async () => {
    const post = (body) => fetch(`${BASE}/api/logs/errors`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    eq((await post({ kind: 'frontend_unhandled', message: '测试未捕获错误', detail: 'stack...' })).status, 200);
    const dup = await (await post({ kind: 'frontend_unhandled', message: '测试未捕获错误', detail: 'stack...' })).json();
    eq(dup.deduped, true, '同 kind+message 30 秒内应去重');
    eq((await post({ kind: 'frontend_crash', message: '测试渲染崩溃', detail: '' })).status, 200);
    eq((await post({ kind: 'frontend_crash', message: '' })).status, 400, '空 message 400');
    const listed = await (await fetch(`${BASE}/api/logs/errors?limit=10`)).json();
    assert(listed.ok && listed.entries.length >= 2, '应能查看错误日志');
    eq(listed.entries[0].message, '测试渲染崩溃', '新的在前');
    assert(listed.entries[0].ts && listed.entries[0].version, '记录应带时间与版本');
    const cleared = await (await fetch(`${BASE}/api/logs/errors`, { method: 'DELETE' })).json();
    assert(cleared.ok && cleared.cleared >= 2, '清空应返回行数');
    eq((await (await fetch(`${BASE}/api/logs/errors`)).json()).entries.length, 0, '清空后为空');
  });
  await test('/api/abort 能真正中断生成并记录 stopped 账本', async () => {
    const requestId = 'test-abort-' + Date.now();
    const resp = await chat({ messages: [{ role: 'user', content: 'SLOW 请慢慢说' }], requestId });
    eq(resp.status, 200);
    const reader = resp.body.getReader();
    const first = await reader.read();
    assert(!first.done, '未收到首帧');
    const j = await (await fetch(`${BASE}/api/abort`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId }),
    })).json();
    eq(j.aborted, true);
    const t0 = Date.now();
    for (;;) { const { done } = await reader.read(); if (done) break; }
    assert(Date.now() - t0 < 3000, 'abort 后流没有及时结束');
    let rec = null;
    for (let i = 0; i < 50 && !rec; i++) {
      const u = await (await fetch(`${BASE}/api/usage`)).json();
      rec = u.recent.find((x) => x.requestId === requestId);
      if (!rec) await new Promise((r) => setTimeout(r, 100));
    }
    assert(rec, 'usage 账本没有记录被停止的请求');
    eq(rec.stopped, true);
  });
  // 故障转移开启时每提供方只试一次（网络抖动直接换路，别在同一家上耗 3 次退避）；
  // 关闭故障转移时才沿用历史语义：同提供方内重试 3 次。两条路径各自有用例守住。
  await test('关闭故障转移时网络层失败仍在同提供方内自动重试', async () => {
    const off = await (await fetch(`${BASE}/api/settings/failover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerFailover: false }),
    })).json();
    eq(off.providerFailover, false, '关闭故障转移失败');
    const before = mock.state.requests.length;
    const s = await readStream(await chat({ messages: [{ role: 'user', content: 'FLAKY 网络抖动一下' }] }));
    assert(s.raw.includes('LongCat-2.5-Preview'), '重试后仍未拿到回答');
    assert(mock.state.requests.length >= before + 2, '没有发生连接期重试');
    await (await fetch(`${BASE}/api/settings/failover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerFailover: true, providerFailoverMaxAttempts: 3 }),
    })).json();
  });
  // ---------- 自定义 Provider（e2e） ----------
  const MOCK_ORIGIN = `http://127.0.0.1:${MOCK_PORT}`;
  const draft = {
    id: 'mock-gw', name: '测试网关', protocol: 'openai',
    baseUrl: `${MOCK_ORIGIN}/v1`, apiKey: 'sk-custom-key',
    models: [{ id: 'custom-alpha', name: 'Alpha 模型', contextWindow: '128K' }],
  };
  async function createProvider(body) {
    const r = await fetch(`${BASE}/api/providers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, ...(await r.json()) };
  }
  async function deleteProvider(id) {
    return (await fetch(`${BASE}/api/providers/${id}`, { method: 'DELETE' })).json();
  }
  await test('GET /api/providers 返回内置提供方与协议列表', async () => {
    const j = await (await fetch(`${BASE}/api/providers`)).json();
    eq(j.ok, true);
    eq(j.providers.length, 1, '初始只有内置提供方');
    eq(j.providers[0].id, 'longcat');
    eq(j.providers[0].builtin, true);
    eq(j.providers[0].hasKey, true);
    assert(!JSON.stringify(j).includes('ak-test-key'), '列表泄漏了内置 API Key');
    assert(j.protocols.map((p) => p.id).join(',') === 'openai,anthropic', '协议列表不符');
  });
  await test('POST /api/providers 创建自定义提供方', async () => {
    const j = await createProvider(draft);
    eq(j.ok, true, '创建失败: ' + j.error);
    eq(j.provider.id, 'mock-gw');
    eq(j.provider.hasKey, true);
    assert(!JSON.stringify(j).includes('sk-custom-key'), '回显泄漏了 API Key');
    eq(j.providers.length, 2, '列表应包含新提供方');
  });
  await test('POST /api/providers 拒绝重名 ID 并指出字段', async () => {
    const j = await createProvider(draft);
    eq(j.ok, false);
    eq(j.status, 400);
    eq(j.field, 'id');
    assert(j.error.includes('已有提供方'), '重名提示不友好: ' + j.error);
  });
  await test('POST /api/providers 拒绝空模型目录与坏端点', async () => {
    const noModel = await createProvider({ ...draft, id: 'no-model', models: [] });
    eq(noModel.field, 'models');
    assert(noModel.error.includes('至少需要一个模型'), '空目录提示不符');
    const badUrl = await createProvider({ ...draft, id: 'bad-url', baseUrl: 'not-a-url' });
    eq(badUrl.field, 'baseUrl');
    const list = await (await fetch(`${BASE}/api/providers`)).json();
    eq(list.providers.length, 2, '失败创建不应落盘');
  });
  await test('POST /api/providers 拒绝非法 API 密钥并指出 apiKey 字段', async () => {
    const r = await fetch(`${BASE}/api/providers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'bad-key-gw', name: '坏密钥网关', protocol: 'openai', baseUrl: 'https://a.com', models: [{ id: 'm' }], apiKey: 'MY_KEY=sk-1' }),
    });
    eq(r.status, 400);
    const j = await r.json();
    eq(j.field, 'apiKey', '错误应定位到 apiKey 字段');
    const list = await (await fetch(`${BASE}/api/providers`)).json();
    eq(list.providers.length, 2, '失败创建不应落盘');
  });
  await test('POST /api/providers/discover 拉取可用模型（只读）', async () => {
    const j = await (await fetch(`${BASE}/api/providers/discover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: draft.baseUrl, protocol: 'openai', apiKey: draft.apiKey }),
    })).json();
    eq(j.ok, true, '拉取失败: ' + j.error);
    eq(j.models.length, 2);
    eq(j.models[1].name, 'Beta 模型');
    eq(j.models[1].contextWindow, 262144);
    eq(j.models[1].maxTokens, 16384);
  });
  await test('POST /api/providers/discover 对坏端点给出可读错误', async () => {
    const r = await fetch(`${BASE}/api/providers/discover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'http://127.0.0.1:1/none', protocol: 'openai', apiKey: 'x' }),
    });
    const j = await r.json();
    eq(r.status, 400);
    assert(j.error.includes('无法连接'), '错误提示不可读: ' + j.error);
  });
  await test('PUT /api/providers/:id 更新模型目录与协议', async () => {
    const j = await (await fetch(`${BASE}/api/providers/mock-gw`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: [{ id: 'custom-alpha' }, { id: 'custom-gamma' }] }),
    })).json();
    eq(j.ok, true, '更新失败: ' + j.error);
    eq(j.provider.models.length, 2);
    assert(j.provider.models.some((m) => m.id === 'custom-gamma'), '新模型未保存');
  });
  await test('GET /api/models 汇总自定义提供方的模型', async () => {
    const j = await (await fetch(`${BASE}/api/models`)).json();
    eq(j.ok, true);
    eq(j.providers.length, 2);
    const gamma = j.models.find((m) => m.id === 'custom-gamma');
    assert(gamma, '自定义模型未进目录');
    eq(gamma.provider, 'mock-gw');
    assert(j.models.some((m) => m.id === 'LongCat-2.5-Preview' && m.provider === 'longcat'), '内置模型缺失');
  });
  await test('/api/chat 按 provider 路由到自定义上游', async () => {
    const s = await readStream(await chat({ messages: [{ role: 'user', content: '自定义路由' }], provider: 'mock-gw', model: 'custom-gamma' }));
    assert(s.raw.includes('custom-gamma'), '未走到自定义上游: ' + s.raw.slice(0, 200));
    eq(mock.state.lastChatMeta.url, '/v1/chat/completions');
    eq(mock.state.lastChatMeta.authorization, 'Bearer sk-custom-key');
  });
  await test('/api/chat 未传 provider 时按模型 ID 反查提供方', async () => {
    const s = await readStream(await chat({ messages: [{ role: 'user', content: '反查' }], model: 'custom-alpha' }));
    assert(s.raw.includes('custom-alpha'), '未按模型反查到自定义上游');
    eq(mock.state.lastChatMeta.url, '/v1/chat/completions');
  });
  await test('/api/chat 未知模型仍回退内置提供方', async () => {
    await readStream(await chat({ messages: [{ role: 'user', content: '未知模型' }], model: 'LongCat-2.0' }));
    eq(mock.state.lastChatMeta.url, '/openai/v1/chat/completions');
  });
  await test('Anthropic 线路：按 /messages 请求并翻译成 OpenAI 帧', async () => {
    const created = await createProvider({
      id: 'claude-gw', name: 'Claude 网关', protocol: 'anthropic',
      baseUrl: `${MOCK_ORIGIN}/v1`, apiKey: 'sk-ant-key', models: [{ id: 'claude-9', name: 'Claude 9' }],
    });
    eq(created.ok, true, '创建失败: ' + created.error);
    try {
      const s = await readStream(await chat({ messages: [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '打招呼' },
      ], provider: 'claude-gw', model: 'claude-9' }));
      assert(s.raw.includes('claude-9'), '未走到 Anthropic 上游');
      assert(s.think.length > 0, 'thinking_delta 未被翻译成 reasoning_content');
      eq(mock.state.lastChatMeta.url, '/v1/messages');
      eq(mock.state.lastChatMeta.apiKey, 'sk-ant-key');
      eq(mock.state.lastChatMeta.anthropicVersion, '2023-06-01');
      eq(mock.state.lastChatBody.system, '你是助手', 'system 应拆到顶层');
      eq(mock.state.lastChatBody.messages.length, 1, 'system 不应留在 messages 里');
      eq(mock.state.lastChatBody.max_tokens, 4096, '未声明容量时应给默认值');
      assert(s.usage && s.usage.prompt_tokens === 12, 'message_start 的 usage 未汇总');
      assert(s.usage && s.usage.completion_tokens === 7, 'message_delta 的 usage 未汇总');
    } finally {
      eq((await deleteProvider('claude-gw')).ok, true);
    }
  });

  await test('用量账本按提供方单价计价并记录 provider', async () => {
    const created = await createProvider({
      id: 'priced-gw', name: '计价网关', protocol: 'openai', baseUrl: `${MOCK_ORIGIN}/v1`,
      apiKey: 'sk-priced', price: { input: 10, output: 30 }, models: [{ id: 'custom-priced' }],
    });
    eq(created.ok, true, '创建失败: ' + created.error);
    try {
      const requestId = 'priced-' + Date.now();
      await readStream(await chat({ messages: [{ role: 'user', content: '计价' }], provider: 'priced-gw', model: 'custom-priced', requestId }));
      let rec = null;
      for (let i = 0; i < 50 && !rec; i++) {
        const u = await (await fetch(`${BASE}/api/usage`)).json();
        rec = u.recent.find((x) => x.requestId === requestId);
        if (!rec) await new Promise((r) => setTimeout(r, 100));
      }
      assert(rec, '账本没有记录自定义提供方的请求');
      eq(rec.provider, 'priced-gw');
      eq(rec.inputTokens, 20);
      eq(rec.outputTokens, 15);
      eq(rec.cost, 0.00065, '应按提供方单价计价');
    } finally {
      eq((await deleteProvider('priced-gw')).ok, true);
    }
  });

  await test('用量账本按提供方单价计价：只填一侧时另一侧回退内置价', async () => {
    const created = await createProvider({
      id: 'half-gw', name: '半价网关', protocol: 'openai', baseUrl: `${MOCK_ORIGIN}/v1`,
      apiKey: 'sk-half', price: { input: 5 }, models: [{ id: 'custom-half' }],
    });
    eq(created.ok, true, '创建失败: ' + created.error);
    try {
      const requestId = 'half-' + Date.now();
      await readStream(await chat({ messages: [{ role: 'user', content: '半价' }], provider: 'half-gw', model: 'custom-half', requestId }));
      let rec = null;
      for (let i = 0; i < 50 && !rec; i++) {
        const u = await (await fetch(`${BASE}/api/usage`)).json();
        rec = u.recent.find((x) => x.requestId === requestId);
        if (!rec) await new Promise((r) => setTimeout(r, 100));
      }
      assert(rec, '账本没有记录半价提供方的请求');
      eq(rec.cost, 0.00022, '输入按 5、输出回退内置 8 计价');
    } finally {
      eq((await deleteProvider('half-gw')).ok, true);
    }
  });

  await test('DELETE /api/providers/longcat 拒绝删除内置提供方', async () => {
    const j = await deleteProvider('longcat');
    eq(j.ok, false);
    assert(j.error.includes('不能删除'), '内置提供方应受保护');
  });
  await test('DELETE /api/providers/:id 删除自定义提供方', async () => {
    const j = await deleteProvider('mock-gw');
    eq(j.ok, true);
    eq(j.providers.length, 1, '删除后只剩内置');
    const j2 = await (await fetch(`${BASE}/api/models`)).json();
    assert(!j2.models.some((m) => m.provider === 'mock-gw'), '删除后模型仍留在目录');
  });

// ---------- e2e: Agent 运行时 ----------
console.log('\nAgent 运行时端到端测试');
const AGENT = `${BASE}/api/agent`;

async function createAgentSession(extra = {}) {
  const j = await (await fetch(`${AGENT}/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '测试会话', ...extra }),
  })).json();
  return j.session;
}

/** 打开 Agent SSE 流：next() 逐事件读，流不主动关闭，调用方决定何时 cancel */
function openAgentStream(resp) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  return {
    async next() {
      for (;;) {
        const idx = buf.indexOf('\n\n');
        if (idx >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const m = /^event: (.+)\ndata: (.*)$/s.exec(raw);
          if (m) return { type: m[1], ...JSON.parse(m[2]) };
          continue;
        }
        const { done, value } = await reader.read();
        if (done) return null;
        buf += dec.decode(value, { stream: true });
      }
    },
    cancel() { try { reader.cancel(); } catch {} },
  };
}

/** 读到流结束或 until 命中（命中时保留流，可继续 drain） */
async function drainAgentStream(stream, { until, onEvent } = {}) {
  const events = [];
  for (;;) {
    const ev = await stream.next();
    if (!ev) return events;
    events.push(ev);
    if (onEvent) await onEvent(ev);
    if (until && until(ev)) return events;
  }
}

  // ---------- 多提供方 429 故障转移（e2e） ----------
  // mock 按 Authorization 里的 Key 模拟上游不可用：ak-fail → 429、ak-down → 503（与消息内容无关）
  async function createFailoverProvider(id, apiKey) {
    return createProvider({
      id, name: `故障转移${id}`, protocol: 'openai',
      baseUrl: `${MOCK_ORIGIN}/v1`, apiKey,
      models: [{ id: 'shared-model', name: '共享模型' }],
    });
  }
  await test('Agent turn：主提供方 429 时自动切换提供方，记账归属新提供方', async () => {
    await createFailoverProvider('fo-a', 'ak-fail');
    await createFailoverProvider('fo-b', 'ak-ok');
    const s = await createAgentSession({ name: '故障转移会话', provider: 'fo-a', model: 'shared-model' });
    const before = (await (await fetch(`${BASE}/api/usage`)).json()).totals.requests;
    const resp = await fetch(`${AGENT}/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: s.id, input: '随便问点什么' }),
    });
    const events = await drainAgentStream(openAgentStream(resp));
    const switched = events.find((e) => e.type === 'provider_switched');
    assert(switched, '应推送 provider_switched 事件');
    eq(switched.from, 'fo-a', '切换源应是主提供方');
    eq(switched.to, 'fo-b', '切换目标应是提供同模型且有 Key 的提供方');
    eq(switched.reason, 'rate_limit', '429 的原因词应为 rate_limit');
    eq(switched.attempt, 1, '首次尝试失败即转移');
    assert(events.find((e) => e.type === 'turn_completed'), '转移后应正常跑完 turn');
    const texts = events.filter((e) => e.type === 'text_chunk').map((e) => e.text).join('');
    assert(texts.includes('shared-model'), '终稿应来自切换后的提供方');
    const usage = await (await fetch(`${BASE}/api/usage`)).json();
    assert(usage.totals.requests >= before + 1, '账本应记录这次请求');
    const rows = usage.recent.filter((r) => r.provider === 'fo-b');
    assert(rows.length >= 1, 'token 应记账到真实产出的提供方 fo-b，而非 fo-a');
    assert(!usage.recent.some((r) => r.provider === 'fo-a'), '失败 attempt 无 token 消耗，不应记账到 fo-a');
    await deleteProvider('fo-a');
    await deleteProvider('fo-b');
  });
  await test('Agent turn：候选提供方全部不可用时报出最后一次真实错误', async () => {
    await createFailoverProvider('fo-c', 'ak-fail');
    await createFailoverProvider('fo-d', 'ak-fail');
    const s = await createAgentSession({ name: '双故障会话', provider: 'fo-c', model: 'shared-model' });
    const resp = await fetch(`${AGENT}/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: s.id, input: '随便问点什么' }),
    });
    const events = await drainAgentStream(openAgentStream(resp));
    const failed = events.find((e) => e.type === 'turn_failed');
    assert(failed, '候选耗尽应以 turn_failed 收尾');
    assert(failed.error.includes('请求过于频繁'), '应报出 429 的中文提示: ' + failed.error);
    eq(events.filter((e) => e.type === 'provider_switched').length, 1, 'fo-c → fo-d 只转移一次（默认 3 次尝试用尽）');
    await deleteProvider('fo-c');
    await deleteProvider('fo-d');
  });
  await test('/api/chat：速测通道同样故障转移且不透出错误', async () => {
    await createFailoverProvider('fo-e', 'ak-fail');
    await createFailoverProvider('fo-f', 'ak-ok');
    const s = await readStream(await chat({ messages: [{ role: 'user', content: '速测转移' }], provider: 'fo-e', model: 'shared-model' }));
    assert(s.raw.includes('shared-model'), '应拿到切换后提供方的回答');
    const usage = await (await fetch(`${BASE}/api/usage`)).json();
    const row = usage.recent.find((r) => r.provider === 'fo-f');
    assert(row, '速测账本应归属切换后的提供方');
    await deleteProvider('fo-e');
    await deleteProvider('fo-f');
  });
  await test('/api/chat：HTTP 200 的错误 envelope 也触发故障转移', async () => {
    // 非 SSE 的 200 JSON 错误体
    await createFailoverProvider('fo-env', 'ak-envelope');
    await createFailoverProvider('fo-env-ok', 'ak-ok');
    const s = await readStream(await chat({ messages: [{ role: 'user', content: ' envelope 试探' }], provider: 'fo-env', model: 'shared-model' }));
    assert(s.raw.includes('shared-model'), '200 错误 envelope 应换路后拿到正常回答');
    // SSE 形状的 200 错误帧
    await createFailoverProvider('fo-env-sse', 'ak-envelope-sse');
    const s2 = await readStream(await chat({ messages: [{ role: 'user', content: 'envelope sse 试探' }], provider: 'fo-env-sse', model: 'shared-model' }));
    assert(s2.raw.includes('shared-model'), 'SSE 错误帧也应换路后拿到正常回答');
    assert(!s2.raw.includes('gateway rejected'), '错误 envelope 不应透传给用户');
    for (const id of ['fo-env', 'fo-env-ok', 'fo-env-sse']) await deleteProvider(id);
  });
  await test('/api/chat：首包超时把挂起的上游变成可换路错误', async () => {
    const cfg = await (await fetch(`${BASE}/api/settings/failover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ failover: { firstByteMs: 400 } }),
    })).json();
    eq(cfg.failover.firstByteMs, 400, '首包超时应落盘');
    await createFailoverProvider('fo-hang', 'ak-hang');
    await createFailoverProvider('fo-hang-ok', 'ak-ok');
    const t0 = Date.now();
    const s = await readStream(await chat({ messages: [{ role: 'user', content: 'hang 试探' }], provider: 'fo-hang', model: 'shared-model' }));
    assert(s.raw.includes('shared-model'), '首包挂起应换路后拿到正常回答');
    assert(Date.now() - t0 < 5000, '首包超时后应尽快换路，而不是干等默认 60s');
    await (await fetch(`${BASE}/api/settings/failover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ failover: { firstByteMs: 60000 } }),
    })).json();
    for (const id of ['fo-hang', 'fo-hang-ok']) await deleteProvider(id);
  });
  await test('熔断器：连续失败达阈值后直接跳过该提供方，重置后恢复', async () => {
    const cfg = await (await fetch(`${BASE}/api/settings/failover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ failover: { circuit: { failureThreshold: 2 } } }),
    })).json();
    eq(cfg.failover.circuit.failureThreshold, 2, '熔断阈值应落盘并热更新');
    await createFailoverProvider('cb-a', 'ak-fail');
    await createFailoverProvider('cb-b', 'ak-fail');
    for (let i = 0; i < 2; i++) {
      const s = await createAgentSession({ name: `熔断会话${i}`, provider: 'cb-a', model: 'shared-model' });
      const resp = await fetch(`${AGENT}/turn`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: s.id, input: '踩一次' }),
      });
      await drainAgentStream(openAgentStream(resp));
    }
    const health = (await (await fetch(`${BASE}/api/settings/failover`)).json()).health;
    eq(health.find((h) => h.providerId === 'cb-a')?.state, 'open', '连续失败 2 次后应开闸');
    eq(health.find((h) => h.providerId === 'cb-b')?.state, 'open', '备选提供方同样开闸');
    // 全熔断时连请求都不该发：换过去也只是再撞一次同样的 429
    const before = mock.state.requests.length;
    const s3 = await createAgentSession({ name: '熔断会话三', provider: 'cb-a', model: 'shared-model' });
    const third = await fetch(`${AGENT}/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: s3.id, input: '再踩一次' }),
    });
    const events3 = await drainAgentStream(openAgentStream(third));
    const failed = events3.find((e) => e.type === 'turn_failed');
    assert(failed && failed.error.includes('熔断'), '全部候选熔断时应报熔断，而不是再打一遍上游');
    eq(mock.state.requests.length, before, '熔断期间不应再向上游发请求');
    const reset = await (await fetch(`${BASE}/api/settings/failover/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })).json();
    eq(reset.ok, true, '重置应成功');
    eq(reset.health.filter((h) => h.state === 'open').length, 0, '重置后不应有 open 状态');
    // 还原缺省阈值，避免影响后续用例
    await (await fetch(`${BASE}/api/settings/failover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ failover: { circuit: { failureThreshold: 4 } } }),
    })).json();
    for (const id of ['cb-a', 'cb-b']) await deleteProvider(id);
  });
  await test('故障转移队列：读写、顺序即优先级、删除提供方自动清出', async () => {
    await createFailoverProvider('q-a', 'ak-ok');
    await createFailoverProvider('q-b', 'ak-fail');
    await createFailoverProvider('q-c', 'ak-ok');
    const empty = await (await fetch(`${BASE}/api/providers/failover-queue`)).json();
    eq(empty.queue.length, 0, '初始队列为空');
    const set = await (await fetch(`${BASE}/api/providers/failover-queue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue: ['longcat', 'q-c', 'q-a'] }),
    })).json();
    eq(set.queue.join(','), 'longcat,q-c,q-a', '整队列替换应保持给定顺序');
    const bad = await (await fetch(`${BASE}/api/providers/failover-queue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queue: ['ghost'] }),
    })).json();
    eq(bad.ok, false, '未知提供方 ID 应被拒绝');
    const moved = await (await fetch(`${BASE}/api/providers/failover-queue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ move: { id: 'q-a', delta: -1 } }),
    })).json();
    eq(moved.queue.join(','), 'longcat,q-a,q-c', '上移一位');
    const added = await (await fetch(`${BASE}/api/providers/failover-queue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add: 'q-b' }),
    })).json();
    eq(added.queue.join(','), 'longcat,q-a,q-c,q-b', '入队追加到末尾');
    // 队列顺序即优先级：主提供方 429，队列第一位 longcat 不含该模型，第二位 q-a 顶上
    const s = await createAgentSession({ name: '队列会话', provider: 'q-b', model: 'shared-model' });
    const resp = await fetch(`${AGENT}/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: s.id, input: '队列转移' }),
    });
    const events = await drainAgentStream(openAgentStream(resp));
    const switched = events.find((e) => e.type === 'provider_switched');
    assert(switched, '应按队列转移');
    eq(switched.to, 'q-a', '队列序决定转移目标');
    await deleteProvider('q-a');
    const afterDel = await (await fetch(`${BASE}/api/providers/failover-queue`)).json();
    eq(afterDel.queue.includes('q-a'), false, '删除提供方应同步清出队列');
    await (await fetch(`${BASE}/api/providers/failover-queue`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ queue: [] }),
    })).json();
    for (const id of ['q-b', 'q-c']) await deleteProvider(id);
  });
  await test('热切换偏好：转移成功后同模型优先走新提供方', async () => {
    await createFailoverProvider('pf-a', 'ak-fail');
    await createFailoverProvider('pf-b', 'ak-ok');
    // 不显式指定提供方：按创建顺序落到 pf-a（隐含顺序 = 内置在前 + 自定义按创建序）
    const s = await createAgentSession({ name: '偏好会话', model: 'shared-model' });
    const first = await fetch(`${AGENT}/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: s.id, input: '第一次' }),
    });
    const events = await drainAgentStream(openAgentStream(first));
    assert(events.find((e) => e.type === 'provider_switched'), '首次应发生转移');
    // 第二个会话在偏好写入之后创建：直接解析到 pf-b，不再需要转移
    const s2 = await createAgentSession({ name: '偏好会话二', model: 'shared-model' });
    eq(s2.provider, 'pf-b', '热切换偏好应让新会话直接解析到可用的提供方');
    const second = await fetch(`${AGENT}/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: s2.id, input: '第二次' }),
    });
    const events2 = await drainAgentStream(openAgentStream(second));
    eq(events2.filter((e) => e.type === 'provider_switched').length, 0, '偏好生效后不应再转移');
    assert(events2.find((e) => e.type === 'turn_completed'), '偏好路径应正常跑完');
    // 重置清空偏好：再发起一次又回到从 pf-a 出发（于是再次转移）
    await (await fetch(`${BASE}/api/settings/failover/reset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    })).json();
    const s3 = await createAgentSession({ name: '偏好会话三', model: 'shared-model' });
    const third = await fetch(`${AGENT}/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: s3.id, input: '第三次' }),
    });
    const events3 = await drainAgentStream(openAgentStream(third));
    assert(events3.find((e) => e.type === 'provider_switched'), '重置偏好后应重新转移');
    for (const id of ['pf-a', 'pf-b']) await deleteProvider(id);
  });
  await test('不可转移错误（401）不触发故障转移，原样透传', async () => {
    await createFailoverProvider('fo-g', 'ak-401-a');
    await createFailoverProvider('fo-h', 'ak-401-b');
    const before = mock.state.requests.length;
    const resp = await chat({ messages: [{ role: 'user', content: 'BAD_KEY 鉴权失败' }], provider: 'fo-g', model: 'shared-model' });
    eq(resp.status, 401, '401 应原样透传');
    const j = await resp.json();
    assert(j.error.message.includes('API Key 无效'), '应保留鉴权错误的中文提示');
    eq(mock.state.requests.length, before + 1, '401 不可转移：不应再向其它提供方发请求');
    await deleteProvider('fo-g');
    await deleteProvider('fo-h');
  });
  await test('GET/POST /api/settings/failover 读写故障转移偏好', async () => {
    const got = await (await fetch(`${BASE}/api/settings/failover`)).json();
    eq(got.ok, true);
    eq(got.providerFailover, true, '缺省开启');
    eq(got.providerFailoverMaxAttempts, 3, '缺省 3 次尝试');
    const bad = await (await fetch(`${BASE}/api/settings/failover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerFailover: 'nope' }),
    })).json();
    eq(bad.ok, false, '非布尔值应被拒绝');
    const badMax = await (await fetch(`${BASE}/api/settings/failover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerFailoverMaxAttempts: 99 }),
    })).json();
    eq(badMax.ok, false, '越界次数应被拒绝');
    const saved = await (await fetch(`${BASE}/api/settings/failover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerFailover: false, providerFailoverMaxAttempts: 2 }),
    })).json();
    eq(saved.ok, true);
    eq(saved.providerFailover, false, '关闭应落盘');
    eq(saved.providerFailoverMaxAttempts, 2, '次数应落盘');
    const reread = await (await fetch(`${BASE}/api/settings/failover`)).json();
    eq(reread.providerFailover, false, '重读应保持关闭');
    // 还原缺省，避免影响后续用例
    await (await fetch(`${BASE}/api/settings/failover`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ providerFailover: true, providerFailoverMaxAttempts: 3 }),
    })).json();
  });


await test('GET /api/agent/harnesses 返回三档模式', async () => {
  const j = await (await fetch(`${AGENT}/harnesses`)).json();
  eq(j.harnesses.length, 3);
  eq(j.default, 'standard');
  eq(j.harnesses[0].id, 'minimal');
});

await test('Agent 会话：创建 / 列表 / 详情 / 删除', async () => {
  const s = await createAgentSession();
  assert(s.id && s.harness === 'standard', '创建应带默认 harness');
  eq(s.workspace, join(tmpDataDir, 'workspace'), '工作目录默认在数据目录下');
  const list = await (await fetch(`${AGENT}/sessions`)).json();
  assert(list.sessions.some((x) => x.id === s.id), '列表应含新会话');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  assert(detail.meta && Array.isArray(detail.records), '详情应含元信息与转录');
  const del = await (await fetch(`${AGENT}/sessions/${s.id}`, { method: 'DELETE' })).json();
  eq(del.deleted, true);
  eq((await fetch(`${AGENT}/sessions/${s.id}`)).status, 404, '删除后详情 404');
});

await test('PATCH /api/agent/sessions/:id 切换模式 / 改名 / 换模型', async () => {
  const s = await createAgentSession();
  const j = await (await fetch(`${AGENT}/sessions/${s.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: 'ultimate', name: '改名后的会话', model: 'LongCat-2.0' }),
  })).json();
  eq(j.meta.harness, 'ultimate', '模式应切换为 ultimate');
  eq(j.meta.name, '改名后的会话');
  eq(j.meta.model, 'LongCat-2.0');
  const bad = await fetch(`${AGENT}/sessions/${s.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ harness: 'creative' }),
  });
  eq(bad.status, 400, '未知模式应 400');
  const badModel = await fetch(`${AGENT}/sessions/${s.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: '坏模型/带斜杠' }),
  });
  eq(badModel.status, 400, '非法模型 ID 应 400');
  const title = await (await fetch(`${AGENT}/sessions/${s.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titleMode: 'model' }),
  })).json();
  eq(title.meta.titleMode, 'model', '标题生成方式应可切换为模型总结');
  const think = await (await fetch(`${AGENT}/sessions/${s.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thinking: false }),
  })).json();
  eq(think.meta.thinking, false, '思考开关应可会话级关闭');
  const thinkOn = await (await fetch(`${AGENT}/sessions/${s.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ thinking: true }),
  })).json();
  eq(thinkOn.meta.thinking, true, '思考开关应可会话级开启');
  const badTitle = await fetch(`${AGENT}/sessions/${s.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titleMode: 'magic' }),
  });
  eq(badTitle.status, 400, '未知标题生成方式应 400');
  const empty = await fetch(`${AGENT}/sessions/${s.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  eq(empty.status, 400, '空补丁应 400');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  eq(detail.meta.harness, 'ultimate', '失败的 PATCH 不应改动会话');
  eq((await fetch(`${AGENT}/sessions/nope`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 404, '未知会话 404');
  await fetch(`${AGENT}/sessions/${s.id}`, { method: 'DELETE' });
});

await test('POST /api/agent/sessions/:id/fork 复制历史到新会话，源会话只读不动', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '你好，随便聊聊' }),
  });
  await drainAgentStream(openAgentStream(resp));
  const src = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  assert(src.records.length > 0, '源会话应有转录记录');
  const forked = await (await fetch(`${AGENT}/sessions/${s.id}/fork`, { method: 'POST' })).json();
  const f = forked.session;
  assert(f && f.id !== s.id, '应返回新会话');
  eq(f.name, '测试会话（副本）', '名字应加副本后缀');
  const detail = await (await fetch(`${AGENT}/sessions/${f.id}`)).json();
  eq(detail.records.length, src.records.length, '转录应整体复制');
  eq(JSON.stringify(detail.records), JSON.stringify(src.records), '转录内容应逐条一致');
  eq((await (await fetch(`${AGENT}/sessions/${s.id}`)).json()).records.length, src.records.length, '源会话不应被改动');
  const list = await (await fetch(`${AGENT}/sessions`)).json();
  eq(list.sessions.find((x) => x.id === f.id)?.name, '测试会话（副本）', '列表应能查到派生会话');
  const miss = await fetch(`${AGENT}/sessions/00000000-0000-0000-0000-000000000000/fork`, { method: 'POST' });
  eq(miss.status, 404, '源会话不存在应 404');
  await fetch(`${AGENT}/sessions/${s.id}`, { method: 'DELETE' });
  await fetch(`${AGENT}/sessions/${f.id}`, { method: 'DELETE' });
});

await test('Agent turn：titleMode=model 经上游总结标题并记账', async () => {
  const s = (await (await fetch(`${AGENT}/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })).json()).session;
  await fetch(`${AGENT}/sessions/${s.id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titleMode: 'model' }),
  });
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '帮我把 README 的安装章节改写一下' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  const renamed = all.find((e) => e.type === 'session_renamed');
  assert(renamed && renamed.mode === 'model' && renamed.name === 'README 安装章节改写', '标题应由上游总结出来');
  assert(all.find((e) => e.type === 'turn_completed'), '应以 turn_completed 收尾');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  eq(detail.meta.name, 'README 安装章节改写', '模型标题应落元信息');
  assert(detail.meta.cost > 0, '标题请求成本应计入会话汇总');
});

await test('Agent turn：首条消息自动总结会话标题并落元信息', async () => {
  const created = await (await fetch(`${AGENT}/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })).json();
  const s = created.session;
  eq(s.name, '新会话', '新建会话应带默认名');
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '帮我把 README 的安装章节改写一下' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  const renamed = all.find((e) => e.type === 'session_renamed');
  assert(renamed && renamed.name === '帮我把 README 的安装章…', '应推送自动总结出的标题');
  assert(all.find((e) => e.type === 'turn_completed'), '应以 turn_completed 收尾');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  eq(detail.meta.name, '帮我把 README 的安装章…', '标题应落会话元信息');
  const list = await (await fetch(`${AGENT}/sessions`)).json();
  const row = list.sessions.find((x) => x.id === s.id);
  eq(row.name, '帮我把 README 的安装章…', '会话列表应同步新标题');
  assert(row.preview.includes('帮我把 README'), '预览仍取首条用户消息');
});

await test('Agent turn：只读工具默认放行，无需确认即执行', async () => {
  const ws = join(tmpDataDir, 'workspace');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'mock.txt'), 'MOCK_FILE_OK');
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_TOOL 请读 mock.txt' }),
  });
  const stream = openAgentStream(resp);
  const events = await drainAgentStream(stream);
  const phases = events.filter((e) => e.type === 'tool_event').map((e) => e.phase);
  assert(!phases.includes('confirmation_needed'), '只读工具不应询问');
  assert(phases.includes('completed'), '工具应执行完成');
  const completed = events.find((e) => e.type === 'tool_event' && e.phase === 'completed');
  assert(completed.output.includes('MOCK_FILE_OK'), '工具结果应含文件内容');
  const texts = events.filter((e) => e.type === 'text_chunk').map((e) => e.text).join('');
  assert(texts.includes('MOCK_FILE_OK'), '终稿应带回工具结果');
});

await test('Agent turn：写工具经权限允许后落盘并回填', async () => {
  const ws = join(tmpDataDir, 'workspace');
  mkdirSync(ws, { recursive: true });
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_TOOL_WRITE 请写个文件' }),
  });
  const stream = openAgentStream(resp);
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  const ask = head.find((e) => e.phase === 'confirmation_needed');
  assert(ask.requestId, '确认事件应带 requestId');
  const r = await (await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: ask.requestId, decision: 'allow' }),
  })).json();
  eq(r.ok, true);
  const tail = await drainAgentStream(stream);
  const all = [...head, ...tail];
  const phases = all.filter((e) => e.type === 'tool_event').map((e) => e.phase);
  assert(phases.includes('confirmed') && phases.includes('completed'), '允许后应确认并执行');
  assert(all.at(-1).type === 'turn_completed', '应以 turn_completed 收尾');
  eq(readFileSync(join(ws, 'written_by_agent.txt'), 'utf8'), 'AGENT_WROTE', '工具应真实写盘');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  assert(detail.records.some((x) => x.t === 'tool_call' && x.name === 'write_file'), '工具调用应落转录');
  assert(detail.records.some((x) => x.t === 'tool_result' && x.ok), '工具结果应落转录');
  const usageRec = (await (await fetch(`${BASE}/api/usage`)).json()).recent.find((x) => x.kind === 'agent');
  assert(usageRec, '账本应记 agent 请求');
  eq(usageRec.sessionId, s.id);
});

await test('Agent turn：权限拒绝后循环继续且不落盘', async () => {
  const written = join(tmpDataDir, 'workspace', 'written_by_agent.txt');
  if (existsSync(written)) rmSync(written, { force: true });
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_TOOL_WRITE 写个文件' }),
  });
  const stream = openAgentStream(resp);
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: head.find((e) => e.phase === 'confirmation_needed').requestId, decision: 'deny' }),
  });
  const tail = await drainAgentStream(stream);
  const phases = [...head, ...tail].filter((e) => e.type === 'tool_event').map((e) => e.phase);
  assert(phases.includes('rejected'), '应有 rejected 阶段');
  assert(!phases.includes('completed'), '拒绝后不应执行');
  assert(!existsSync(join(tmpDataDir, 'workspace', 'written_by_agent.txt')), '拒绝后不应落盘');
  assert(tail.some((e) => e.type === 'turn_completed'), '拒绝后仍应正常收尾');
});

await test('技能目录：GET /api/agent/skills 返回内置技能', async () => {
  const r = await (await fetch(`${AGENT}/skills`)).json();
  assert(Array.isArray(r.skills) && r.skills.length >= 3, '至少 3 个内置技能');
  const codeReview = r.skills.find((s) => s.name === 'code-review');
  assert(codeReview && codeReview.description && codeReview.source === 'builtin', '内置技能字段完整');
  assert(!('body' in codeReview), '目录不泄底技能正文');
  // L1 元数据 + L3 资源索引：附属文件名可见、正文不可见
  assert(Array.isArray(codeReview.resources) && Array.isArray(codeReview.warnings), '资源索引与告警在位');
  eq(codeReview.implicit, true, '缺省允许模型隐式调用');
  assert(typeof codeReview.bodyLines === 'number' && codeReview.bodyLines > 0, '正文行数');
  const ops = r.skills.find((s) => s.name === 'auroraagent-ops');
  assert(ops.resources.includes('references/commands.md'), '附属资源清单含 references/ 文件');
  assert(ops.resources.every((p) => p !== 'SKILL.md'), 'SKILL.md 自身不算附属资源');
});

await test('Agent turn：/技能名 斜杠命令经服务端解析为技能注入（与终端同源）', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '/code-review 看看这段代码' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  const done = all.find((e) => e.type === 'turn_completed');
  assert(done, '应以 turn_completed 收尾');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  const userRec = detail.records.find((x) => x.t === 'user');
  assert(userRec && String(userRec.text).includes('<skill_content name="code-review">'), '斜杠命令应展开为技能注入文本');
  assert(String(userRec.text).includes('看看这段代码'), '技能参数应拼在注入文本');
  eq(userRec.skill, 'code-review', '用户记录带 skill 标记（压缩期保护技能规范）');
});

await test('Agent turn：模型调用 skill 工具加载技能指令并回填', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_SKILL 按技能规范审查' }),
  });
  const stream = openAgentStream(resp);
  const all = await drainAgentStream(stream);
  const toolEvents = all.filter((e) => e.type === 'tool_event');
  assert(toolEvents.some((e) => e.phase === 'completed' && e.toolName === 'skill'), 'skill 工具应执行完成');
  assert(!toolEvents.some((e) => e.phase === 'confirmation_needed'), 'skill 只读默认免确认');
  assert(all.at(-1).type === 'turn_completed', '应以 turn_completed 收尾');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  const result = detail.records.find((x) => x.t === 'tool_result' && x.name === 'skill');
  assert(result && result.ok, '工具结果应落转录');
  assert(result.output.includes('<skill_content name="code-review">') && result.output.includes('代码审查技能') && result.output.includes('按严重级分级'), '结果应含技能正文');
  assert(result.output.includes('Skill directory: '), '激活结果带出技能绝对目录（供 L3 资源读取）');
});

await test('Agent turn：模型读取技能附属文件（L3 只读白名单根）', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_SKILL_REF 读一下技能里的命令清单' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  assert(all.at(-1).type === 'turn_completed', '应以 turn_completed 收尾');
  assert(!all.some((e) => e.type === 'turn_failed'), '不应有 turn_failed');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  const result = detail.records.find((x) => x.t === 'tool_result' && x.name === 'read_file');
  assert(result && result.ok, 'read_file 应执行成功（技能目录作为只读白名单根放行）');
  assert(result.output.includes('npm test'), '应读到 skills/auroraagent-ops/references/commands.md 的内容');
  const call = detail.records.find((x) => x.t === 'tool_call' && x.name === 'read_file');
  assert(String(call.args.path).includes('references/commands.md'), '调用参数指向技能附属文件');
});

await test('Agent turn：todo 工具维护清单并持久化到会话', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_TODO 规划一下' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  const done = all.find((e) => e.type === 'tool_event' && e.phase === 'completed' && e.toolName === 'todo');
  assert(done && Array.isArray(done.extra?.todos) && done.extra.todos[0].text === 'mock 待办事项', 'completed 事件应带 todos extra');
  assert(all.at(-1).type === 'turn_completed', '应以 turn_completed 收尾');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  const rec = detail.records.find((x) => x.t === 'tool_result' && x.name === 'todo');
  assert(rec && rec.extra && rec.extra.todos.length === 1, '转录应留 todos extra');
  eq(detail.meta.todos.length, 1, 'todo 应持久化进会话 meta');
  eq(detail.meta.todos[0].done, false);
});

await test('Agent turn：edit_file 回传 diff 结构化负载', async () => {
  const ws = join(tmpDataDir, 'workspace');
  writeFileSync(join(ws, 'edit_me.txt'), '第一行\nold 内容\n末行\n');
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_EDIT 改一下' }),
  });
  const stream = openAgentStream(resp);
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: head.find((e) => e.phase === 'confirmation_needed').requestId, decision: 'allow' }),
  });
  const all = [...head, ...(await drainAgentStream(stream))];
  const done = all.find((e) => e.type === 'tool_event' && e.phase === 'completed' && e.toolName === 'edit_file');
  assert(done && Array.isArray(done.extra?.diff), 'completed 事件应带 diff extra');
  assert(done.extra.diff.some((d) => d.type === 'del' && d.text.includes('old 内容')), 'diff 应含删除行');
  assert(done.extra.diff.some((d) => d.type === 'add' && d.text.includes('new 内容')), 'diff 应含新增行');
  eq(readFileSync(join(ws, 'edit_me.txt'), 'utf8'), '第一行\nnew 内容\n末行\n', '文件应真实改写');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  const rec = detail.records.find((x) => x.t === 'tool_result' && x.name === 'edit_file');
  assert(rec.extra && rec.extra.diff.length > 0, '转录应留 diff extra');
  const toolMsg = detail.records.find((x) => x.t === 'tool_result' && x.name === 'edit_file');
  assert(toolMsg.output.includes('+    2  new 内容'), '模型可见输出含紧凑 diff');
});

await test('Agent turn：计划模式批准后进入执行', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_PLAN 规划一下', planMode: true }),
  });
  const stream = openAgentStream(resp);
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'plan_proposed' });
  const planEv = head.find((e) => e.type === 'plan_proposed');
  assert(planEv && planEv.plan.includes('计划：'), '应先收到计划事件');
  const planReq = JSON.parse(mock.state.requests.at(-1).body);
  const planTools = (planReq.tools || []).map((t) => (t.function ? t.function.name : t.name));
  assert(planTools.length > 0 && planTools.every((n) => ['read_file', 'list_dir', 'grep', 'glob', 'web_fetch', 'todo', 'skill'].includes(n)), '计划轮只能用只读 / 检索 / 待办工具');
  const approved = await fetch(`${AGENT}/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, decision: 'approve' }),
  });
  eq(approved.status, 200);
  const tail = await drainAgentStream(stream);
  const all = [...head, ...tail];
  assert(all.some((e) => e.type === 'plan_approved'), '应有 plan_approved 事件');
  const done = all.find((e) => e.type === 'turn_completed');
  assert(done && done.finishReason === 'stop', '批准后应正常执行收尾');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  assert(detail.records.some((r) => r.t === 'assistant' && String(r.text).includes('计划：')), '计划文本应落转录');
  assert(detail.records.some((r) => r.t === 'user' && String(r.text).includes('【已批准的计划】')), '批准注入应落转录');
});

await test('Agent turn：task 派发子代理并汇总，子会话可查', async () => {
  const before = await (await fetch(`${AGENT}/sessions`)).json();
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_SWARM 派发两个子任务' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  const taskEv = all.find((e) => e.type === 'tool_event' && e.toolName === 'task' && e.phase === 'completed');
  assert(taskEv, 'task 工具应执行完成');
  assert(Array.isArray(taskEv.extra?.children) && taskEv.extra.children.length === 2, '应派发 2 个子代理');
  assert(taskEv.extra.children.every((c) => c.ok), '子代理应成功');
  assert(taskEv.output.includes('子代理甲结果') && taskEv.output.includes('子代理乙结果'), '聚合输出应含两个子代理终稿');
  assert(all.at(-1).type === 'turn_completed', '应以 turn_completed 收尾');
  const after = await (await fetch(`${AGENT}/sessions`)).json();
  const kids = after.sessions.filter((m) => m.name.startsWith('子任务：'));
  eq(kids.length, 2, '应新增 2 个真实子会话');
  const kid = await (await fetch(`${AGENT}/sessions/${kids[0].id}`)).json();
  assert(kid.records.some((r) => r.t === 'user' && String(r.text).includes('子任务')), '子会话转录应含子任务原文');
  assert(kid.records.some((r) => r.t === 'assistant' && String(r.text).includes('子代理')), '子会话转录应含子代理终稿');
  const beforeIds = new Set(before.sessions.map((m) => m.id));
  assert(after.sessions.filter((m) => m.name.startsWith('子任务：')).every((m) => !beforeIds.has(m.id)), '子会话应为本次新建');
});

await test('Agent turn：USE_GOAL 全链路——create_goal → update_goal 提案 → complete(worker_proposal)', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_GOAL 请盯着把 README 安装章节改写并通过自检' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  const created = all.find((e) => e.type === 'goal_created');
  assert(created, '应有 goal_created 事件');
  assert(created.goal.objective.includes('README'), '目标文本应来自模型调用');
  assert(all.find((e) => e.type === 'tool_event' && e.toolName === 'create_goal' && e.phase === 'completed'), 'create_goal 应执行');
  assert(all.find((e) => e.type === 'tool_event' && e.toolName === 'update_goal' && e.phase === 'completed'), 'update_goal 提案应执行');
  const changed = all.find((e) => e.type === 'goal_status_changed' && e.goal.status === 'complete');
  assert(changed, '应有完成状态变更事件');
  eq(changed.statusReason, 'complete(worker_proposal)');
  assert(all.some((e) => e.type === 'goal_usage_updated'), '应发用量事件');
  assert(all.at(-1).type === 'turn_completed', '应以 turn_completed 收尾');
  const goalFile = JSON.parse(readFileSync(join(tmpDataDir, 'goals', `${s.id}.json`), 'utf8'));
  eq(goalFile.status, 'complete');
  eq(goalFile.statusReason, 'complete(worker_proposal)');
  assert(goalFile.tokensUsed >= 70, '两个 goal 轮的用量应入账');
  eq(goalFile.turnsUsed, 2, '应计两个 goal 轮');
});

await test('Agent turn：USE_GOAL_BUDGET 触顶转 budget_limited(token) 并跑唯一收尾轮', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_GOAL_BUDGET 盯着把测试基线扩展到 300 个' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  const changed = all.find((e) => e.type === 'goal_status_changed' && e.goal.status === 'budget_limited');
  assert(changed, '应转 budget_limited');
  eq(changed.statusReason, 'budget_limited(token)');
  assert(all.some((e) => e.type === 'text_chunk' && String(e.text).includes('停止原因')), '收尾轮应总结已完成/未完成/停止原因');
  assert(all.at(-1).type === 'turn_completed', '应以 turn_completed 收尾');
  const goalFile = JSON.parse(readFileSync(join(tmpDataDir, 'goals', `${s.id}.json`), 'utf8'));
  eq(goalFile.status, 'budget_limited');
  eq(goalFile.statusReason, 'budget_limited(token)');
  eq(goalFile.tokenBudget, 10);
  assert(goalFile.tokensUsed > 10, '触顶后用量照记（含收尾轮）');
});

await test('Agent turn：USE_GOAL_IDLE 空转轮后续跑并提案完成', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_GOAL_IDLE 盯着把 README 安装章节改写' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  assert(all.some((e) => e.type === 'text_chunk' && String(e.text).includes('理清现状')), '应先有一轮空转文本');
  assert(mock.state.requests.some((r) => r.body.includes('【目标续跑】')), '应注入 goal 续跑提醒');
  assert(all.find((e) => e.type === 'tool_event' && e.toolName === 'update_goal' && e.phase === 'completed'), '续跑后应提案');
  assert(all.find((e) => e.type === 'goal_status_changed' && e.goal.status === 'complete'), '应结算为完成');
  const goalFile = JSON.parse(readFileSync(join(tmpDataDir, 'goals', `${s.id}.json`), 'utf8'));
  eq(goalFile.status, 'complete');
  assert(goalFile.turnsUsed >= 3, 'create/空转/提案三个 goal 轮都应入账');
});

await test('Agent turn：USE_GOAL_EDIT turn 内改写目标——在飞模型下一轮收到【目标已更新】并按新目标结算', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: `USE_GOAL_EDIT:${s.id} 盯着把 README 安装章节改写并通过自检` }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  const editReq = mock.state.requests.find((r) => r.body.includes('【目标已更新】'));
  assert(editReq, 'turn 内改写目标后，在飞模型下一轮应收到【目标已更新】提醒');
  assert(editReq.body.includes('GOAL_EDIT_NEW') && editReq.body.includes('<untrusted_objective>'), '提醒应带新目标文本并按不可信数据包裹');
  assert(editReq.body.includes('预算快照'), '提醒应附预算快照');
  const changed = all.find((e) => e.type === 'goal_status_changed' && e.goal.status === 'complete');
  assert(changed, '应按新目标结算完成');
  eq(changed.statusReason, 'complete(worker_proposal)');
  assert(changed.goal.objective.includes('GOAL_EDIT_NEW'), '完成事件应透出改写后的新目标');
  const goalFile = JSON.parse(readFileSync(join(tmpDataDir, 'goals', `${s.id}.json`), 'utf8'));
  assert(goalFile.objective.includes('GOAL_EDIT_NEW'), '目标文件应落盘改写后的文本');
  eq(goalFile.status, 'complete');
  assert(all.at(-1).type === 'turn_completed', '应以 turn_completed 收尾');
});

await test('Agent turn：GOAL_TURN2 新用户轮首轮重述进行中目标（跨轮压缩失忆防护）', async () => {
  const s = await createAgentSession();
  const created = await (await fetch(`${AGENT}/goal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: 'GOAL_TURN2 把 README 安装章节改写并通过自检' }),
  })).json();
  eq(created.goal.status, 'active');
  const ws = join(tmpDataDir, 'workspace');
  mkdirSync(ws, { recursive: true });
  writeFileSync(join(ws, 'mock.txt'), 'MOCK_FILE_OK');
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'GOAL_TURN2 请继续推进目标' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  const startReq = mock.state.requests.find((r) => r.body.includes('GOAL_TURN2') && r.body.includes('【进行中的目标】'));
  assert(startReq, '新用户轮首轮应重述进行中目标');
  assert(startReq.body.includes('GOAL_TURN2 把 README 安装章节改写并通过自检') && startReq.body.includes('<objective>'), '重述应带目标文本并按 XML 包裹');
  assert(all.find((e) => e.type === 'tool_event' && e.toolName === 'read_file' && e.phase === 'completed'), '见到重述后模型才调工具（mock 脚本佐证）');
  assert(mock.state.requests.some((r) => r.body.includes('GOAL_TURN2') && r.body.includes('【目标续跑】')), '空转后应注入续跑提醒');
  const changed = all.find((e) => e.type === 'goal_status_changed' && e.goal.status === 'complete');
  assert(changed, '续跑后应结算完成');
  eq(changed.statusReason, 'complete(worker_proposal)');
  const goalFile = JSON.parse(readFileSync(join(tmpDataDir, 'goals', `${s.id}.json`), 'utf8'));
  eq(goalFile.status, 'complete');
  assert(all.at(-1).type === 'turn_completed', '应以 turn_completed 收尾');
});

await test('Agent turn：USE_GOAL_SPIN 复读三轮——第 2 轮注入【无进展提醒】、第 3 轮转 paused(no_progress)', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_GOAL_SPIN 盯着把 README 安装章节改写' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  assert(mock.state.requests.some((r) => r.body.includes('【无进展提醒】')), '第 2 次相同回复应注入无进展纠正提醒');
  assert(mock.state.requests.some((r) => r.body.includes('【目标续跑】') && r.body.includes('【无进展提醒】')), 'nudge 应与续跑提醒合并注入（对齐 renderNudgePrompt）');
  const changed = all.find((e) => e.type === 'goal_status_changed' && e.goal.status === 'paused');
  assert(changed, '第 3 次相同回复应熔断');
  eq(changed.statusReason, 'paused(no_progress)');
  const goalFile = JSON.parse(readFileSync(join(tmpDataDir, 'goals', `${s.id}.json`), 'utf8'));
  eq(goalFile.status, 'paused');
  assert(goalFile.turnsUsed >= 3, 'create/复读/复读三个 goal 轮都应入账');
  assert(all.at(-1).type === 'turn_completed', '应以 turn_completed 收尾');
});

await test('Agent turn：USE_GOAL_VERIFY_MET 经 evaluator 裁决 met → complete(verifier_met)', async () => {
  // goal 验证档配置落临时数据目录（evaluator 同路由小快模型）
  writeFileSync(join(tmpDataDir, 'auroraagent.config.json'), JSON.stringify({ goal: { verification: 'evaluator', evaluatorModel: 'LongCat-2.0' } }));
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_GOAL_VERIFY_MET 盯着把 README 安装章节改写' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  const changed = all.find((e) => e.type === 'goal_status_changed' && e.goal.status === 'complete');
  assert(changed, '应有完成状态变更事件');
  eq(changed.statusReason, 'complete(verifier_met)');
  eq(changed.lastVerification.verdict, 'met');
  assert(all.some((e) => e.type === 'goal_wait_changed' && e.reason === 'verification'), '验证期间应标记等待中');
  assert(all.some((e) => e.type === 'goal_wait_changed' && e.reason === null), '验证结束应清除等待');
  const evaluatorReq = mock.state.requests.map((r) => { try { return JSON.parse(r.body); } catch { return null; } })
    .find((b) => b && JSON.stringify(b.messages?.[0]?.content || '').includes('你是目标验证器'));
  assert(evaluatorReq, '应发起一次 evaluator 验证请求');
  eq(evaluatorReq.model, 'LongCat-2.0', 'evaluator 应走配置的小快模型');
  eq(evaluatorReq.temperature, 0, 'evaluator 应低温');
  eq(evaluatorReq.max_tokens, 4096, 'evaluator maxTokens 封顶 4096');
  assert(!evaluatorReq.tools, 'evaluator 请求不应带工具');
  const goalFile = JSON.parse(readFileSync(join(tmpDataDir, 'goals', `${s.id}.json`), 'utf8'));
  eq(goalFile.status, 'complete');
  eq(goalFile.statusReason, 'complete(verifier_met)');
});

await test('Agent turn：USE_GOAL_VERIFY_RETRY evaluator 首轮无结论恰好重试一次后采信 met', async () => {
  // goal 验证档配置落临时数据目录（evaluator 同路由小快模型，maxRetries 默认 1）
  writeFileSync(join(tmpDataDir, 'auroraagent.config.json'), JSON.stringify({ goal: { verification: 'evaluator', evaluatorModel: 'LongCat-2.0' } }));
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_GOAL_VERIFY_RETRY 盯着把 README 安装章节改写' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  const changed = all.find((e) => e.type === 'goal_status_changed' && e.goal.status === 'complete');
  assert(changed, '重试后 met 应转 complete');
  eq(changed.statusReason, 'complete(verifier_met)');
  const evalCalls = mock.state.requests.filter((r) => r.body.includes('你是目标验证器') && r.body.includes('VERIFY_RETRY')).length;
  eq(evalCalls, 2, 'inconclusive（schema_error）应触发恰好一次重试后采纳结论');
  const goalFile = JSON.parse(readFileSync(join(tmpDataDir, 'goals', `${s.id}.json`), 'utf8'));
  eq(goalFile.status, 'complete');
});

await test('Agent turn：USE_GOAL_VERIFY_NOTMET 连续未达到阈值转 paused(no_progress)（对齐 MiniMax repeatedGap）', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_GOAL_VERIFY_NOTMET 盯着把 README 安装章节改写' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  const paused = all.find((e) => e.type === 'goal_status_changed' && e.goal.status === 'paused' && e.goal.statusReason === 'paused(no_progress)');
  assert(paused, '同一批缺口连续 not_met 到阈值应转 paused(no_progress)');
  assert(paused.lastVerification.notMetStreak >= 5, '未达成连胜应达到阈值 5');
  const feedbackCount = mock.state.requests.filter((r) => r.body.includes('【目标验证未通过')).length;
  assert(feedbackCount >= 4, '前几次未达成应带证据反馈续跑（第 5 次直接判停）');
  const goalFile = JSON.parse(readFileSync(join(tmpDataDir, 'goals', `${s.id}.json`), 'utf8'));
  eq(goalFile.status, 'paused');
  eq(goalFile.statusReason, 'paused(no_progress)');
  assert(goalFile.lastVerification.notMetStreak >= 5);
});

// ---------- 终端偏好：/api/settings/tui（设置页读写，终端启动时读取一次） ----------
await test('GET/POST /api/settings/tui：读生效配置、局部合并更新、坏值 400 / 405', async () => {
  const cfgPath = join(tmpDataDir, 'auroraagent.config.json');
  writeFileSync(cfgPath, JSON.stringify({
    tui: { terminalTitle: ['state', 'app'], notifications: { when: 'always', method: 'osc9', events: ['turn-complete'] } },
  }));
  const got = await (await fetch(`${BASE}/api/settings/tui`)).json();
  eq(got.ok, true, '应回 ok');
  eq(got.tui.terminalTitle.join(','), 'state,app', '应读到达项序');
  eq(got.tui.notifications.when, 'always', '应读到达通知时机');
  eq(got.tui.notifications.method, 'osc9');
  eq(got.tui.notifications.events.join(','), 'turn-complete');
  assert(got.options.terminalTitleItems.includes('session') && got.options.notificationEvents.includes('question-required'), '应回可选取值供设置页渲染');
  const p1 = await (await fetch(`${BASE}/api/settings/tui`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notifications: { when: 'never' } }),
  })).json();
  eq(p1.tui.notifications.when, 'never', '局部更新应生效');
  eq(p1.tui.terminalTitle.join(','), 'state,app', '未给字段应保持');
  eq(p1.tui.notifications.method, 'osc9', '同段未给字段应保持');
  const p2 = await (await fetch(`${BASE}/api/settings/tui`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ terminalTitle: [] }),
  })).json();
  eq(p2.tui.terminalTitle.length, 0, '空数组应关闭标题');
  eq((await fetch(`${BASE}/api/settings/tui`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ terminalTitle: ['nope'] }),
  })).status, 400, '未知标题项应 400');
  eq((await fetch(`${BASE}/api/settings/tui`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { when: 'sometimes' } }),
  })).status, 400, '未知通知时机应 400');
  eq((await fetch(`${BASE}/api/settings/tui`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ notifications: { events: ['nope'] } }),
  })).status, 400, '未知通知事件应 400');
  eq((await fetch(`${BASE}/api/settings/tui`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })).status, 400, '空体应 400');
  eq((await fetch(`${BASE}/api/settings/tui`, { method: 'DELETE' })).status, 405, '其他方法应 405');
  rmSync(cfgPath, { force: true });
});

// ---------- 生成参数与 API Key：/api/settings/generation、/api/settings/key ----------
await test('GET/POST /api/settings/generation：读缺省、局部更新、坏值 400 / 405', async () => {
  const cfgPath = join(tmpDataDir, 'auroraagent.config.json');
  writeFileSync(cfgPath, JSON.stringify({ temperature: 0.3, maxTokens: 2048 }));
  const got = await (await fetch(`${BASE}/api/settings/generation`)).json();
  eq(got.ok, true, '应回 ok');
  eq(got.temperature, 0.3, '应读到盘上温度');
  eq(got.maxTokens, 2048, '应读到盘上最大输出');
  const post = (body) => fetch(`${BASE}/api/settings/generation`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const p1 = await (await post({ temperature: 0.9 })).json();
  eq(p1.temperature, 0.9, '温度应更新');
  eq(p1.maxTokens, 2048, '未给字段应保持');
  const p2 = await (await post({ maxTokens: 4096 })).json();
  eq(p2.maxTokens, 4096, '最大输出应更新');
  eq(p2.temperature, 0.9, '上一次的更新应落盘并读回');
  eq((await post({ temperature: 1.5 })).status, 400, '温度越界应 400');
  eq((await post({ temperature: 'abc' })).status, 400, '非数字温度应 400');
  eq((await post({ maxTokens: 0 })).status, 400, '零上限应 400');
  eq((await post({ maxTokens: 1.5 })).status, 400, '非整数上限应 400');
  eq((await post({})).status, 400, '空体应 400');
  eq((await fetch(`${BASE}/api/settings/generation`, { method: 'PUT' })).status, 405, '其他方法应 405');
  rmSync(cfgPath, { force: true });
});

await test('GET/POST /api/settings/key：写入落盘、只回 hasKey 不回钥、坏值 400、环境变量优先时 409', async () => {
  const cfgPath = join(tmpDataDir, 'auroraagent.config.json');
  writeFileSync(cfgPath, JSON.stringify({ model: 'LongCat-2.5-Preview' }));
  const post = (body) => fetch(`${BASE}/api/settings/key`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  // 生效 Key 由环境变量 AURORAAGENT_API_KEY 提供，hasKey 恒为 true；响应里绝不出现 Key 本身
  const g0 = await (await fetch(`${BASE}/api/settings/key`)).json();
  eq(g0.ok, true, '应回 ok');
  eq(g0.hasKey, true, '当前由环境变量提供 Key，hasKey 应为 true');
  assert(!JSON.stringify(g0).includes('ak-'), 'GET 绝不回传 Key 本身');
  const p = await (await post({ apiKey: 'ak-new-key' })).json();
  eq(p.ok, true, '应回 ok');
  eq(p.hasKey, true, '写入后应报有 Key');
  const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'));
  eq(onDisk.apiKey, 'ak-new-key', 'Key 应落盘（saveConfig 仅在 keyIsOverride 为假时写钥）');
  eq(onDisk.model, 'LongCat-2.5-Preview', '其它配置字段不被冲掉');
  const again = await (await fetch(`${BASE}/api/settings/key`)).json();
  eq(again.hasKey, true, 'GET 应报有 Key');
  assert(!JSON.stringify(again).includes('ak-new-key'), 'GET 绝不回传 Key 本身');
  eq((await post({ apiKey: '' })).status, 400, '空 Key 应 400');
  eq((await post({ apiKey: 'ak\nx' })).status, 400, '含空白的 Key 应 400');
  eq((await post({ apiKey: 'x'.repeat(201) })).status, 400, '超长 Key 应 400');
  eq((await fetch(`${BASE}/api/settings/key`, { method: 'DELETE' })).status, 405, '其他方法应 405');
  // 环境变量 Key 是临时覆盖：此时写盘会被 loadConfig 忽略，必须 409 说清而非假成功
  const conflict = await post({ apiKey: 'ak-third' });
  eq(conflict.status, 409, '环境变量 Key 生效时应 409');
  assert((await conflict.json()).error.includes('AURORAAGENT_API_KEY'), '409 消息应指出环境变量');
  rmSync(cfgPath, { force: true });
});

// ---------- Agent 沙箱代理：/api/settings/proxy（web_fetch 等出站请求的出路） ----------
await test('GET/POST /api/settings/proxy：读生效值、归一化落盘、坏值 400 / 405', async () => {
  const cfgPath = join(tmpDataDir, 'auroraagent.config.json');
  writeFileSync(cfgPath, JSON.stringify({
    agentProxy: '127.0.0.1:7890',
    tui: { terminalTitle: ['state'], notifications: { when: 'always', method: 'osc9', events: ['turn-complete'] } },
  }));
  const got = await (await fetch(`${BASE}/api/settings/proxy`)).json();
  eq(got.ok, true, '应回 ok');
  eq(got.agentProxy, 'http://127.0.0.1:7890', '裸 host:port 应归一化为 http:// 形态');
  // 局部保存：其它配置段不被冲掉
  const p1 = await (await fetch(`${BASE}/api/settings/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentProxy: 'http://127.0.0.1:6152' }),
  })).json();
  eq(p1.agentProxy, 'http://127.0.0.1:6152', '保存后应回显新值');
  const back = await (await fetch(`${BASE}/api/settings/proxy`)).json();
  eq(back.agentProxy, 'http://127.0.0.1:6152', '落盘后应读回');
  const onDisk = JSON.parse(readFileSync(cfgPath, 'utf8'));
  eq(onDisk.agentProxy, 'http://127.0.0.1:6152', '配置文件应持久化归一化值');
  eq(onDisk.tui.notifications.when, 'always', '保存代理不应冲掉其它配置段');
  // 清空 = 直连
  const p2 = await (await fetch(`${BASE}/api/settings/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentProxy: '' }),
  })).json();
  eq(p2.agentProxy, '', '空值 = 直连');
  const cleared = await (await fetch(`${BASE}/api/settings/proxy`)).json();
  eq(cleared.agentProxy, '', '清空后应读回直连');
  // 坏值 400：socks5 / 缺端口 / 端口越界
  eq((await fetch(`${BASE}/api/settings/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentProxy: 'socks5://127.0.0.1:7890' }),
  })).status, 400, 'socks5 应 400');
  const noPort = await (await fetch(`${BASE}/api/settings/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentProxy: 'http://127.0.0.1' }),
  })).json();
  eq(noPort.ok, true, '缺省端口 80 是合法 URL 语义');
  eq(noPort.agentProxy, 'http://127.0.0.1:80', '缺省端口应补 80');
  eq((await fetch(`${BASE}/api/settings/proxy`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentProxy: 'http://127.0.0.1:99999' }),
  })).status, 400, '端口越界应 400');
  eq((await fetch(`${BASE}/api/settings/proxy`, { method: 'DELETE' })).status, 405, '其他方法应 405');
  rmSync(cfgPath, { force: true });
});

// ---------- Goal REST 面： /api/agent/goal*（用户操作优先级永远高于模型提案） ----------
await test('GET /api/files/search：会话工作目录内只读搜索，跳过依赖目录，会话不存在 404', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'files-api-'));
  mkdirSync(join(dir, 'sub'), { recursive: true });
  mkdirSync(join(dir, 'node_modules'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'x');
  writeFileSync(join(dir, 'sub', 'helper.mjs'), 'x');
  writeFileSync(join(dir, 'node_modules', 'dep.js'), 'x');
  const s = await createAgentSession({ workspace: dir });
  const hit = await (await fetch(`${BASE}/api/files/search?sessionId=${s.id}&q=helper`)).json();
  eq(hit.files.join(','), 'sub/helper.mjs', '应按关键字返回相对路径');
  const all = await (await fetch(`${BASE}/api/files/search?sessionId=${s.id}&q=`)).json();
  assert(all.files.includes('README.md') && all.files.includes('sub/helper.mjs'), '空关键字列工作目录文件');
  assert(!all.files.some((f) => f.includes('node_modules')), 'node_modules 不出列');
  const miss = await fetch(`${BASE}/api/files/search?sessionId=00000000-0000-0000-0000-000000000000&q=x`);
  eq(miss.status, 404, '会话不存在 404');
  rmSync(dir, { recursive: true, force: true });
});

await test('GET /api/workspace：Header 工作区卡片数据源，坏路径 400、方法 405', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-api-'));
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  const got = await (await fetch(`${BASE}/api/workspace?path=${encodeURIComponent(dir)}`)).json();
  eq(got.ok, true, '正常目录应 ok');
  eq(got.branch, 'master', '应带回 git 分支');
  assert(got.home.length > 1, '应带回主目录');
  const plain = await (await fetch(`${BASE}/api/workspace?path=${encodeURIComponent(tmpdir())}`)).json();
  eq(plain.isGit, false, '非 git 目录 isGit=false');
  const bad = await fetch(`${BASE}/api/workspace?path=relative/nope`);
  eq(bad.status, 400, '相对路径 400');
  const gone = await fetch(`${BASE}/api/workspace?path=${encodeURIComponent(join(dir, 'nope'))}`);
  eq(gone.status, 400, '不存在目录 400');
  const post = await fetch(`${BASE}/api/workspace?path=${encodeURIComponent(dir)}`, { method: 'POST' });
  eq(post.status, 405, '非 GET 405');
  rmSync(dir, { recursive: true, force: true });
});

await test('Goal REST：创建 / 查询 / 空白目标 400 / 会话不存在 404 / 未完成目标 409', async () => {
  const s = await createAgentSession();
  const miss = await (await fetch(`${AGENT}/goal/${s.id}`)).json();
  eq(miss.goal, null, '无目标应回 null');
  const empty = await fetch(`${AGENT}/goal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: '   ' }),
  });
  eq(empty.status, 400, '空白目标 400');
  const badSession = await fetch(`${AGENT}/goal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: '00000000-0000-0000-0000-000000000000', objective: 'x' }),
  });
  eq(badSession.status, 404, '会话不存在 404');
  const created = await (await fetch(`${AGENT}/goal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: '把 README 安装章节改写', tokenBudget: 5000 }),
  })).json();
  eq(created.goal.objective, '把 README 安装章节改写');
  eq(created.goal.status, 'active');
  eq(created.goal.tokenBudget, 5000);
  const again = await fetch(`${AGENT}/goal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: '第二个目标' }),
  });
  eq(again.status, 409, '未完成目标存在时再创建 409');
  eq((await again.json()).error.code, 'GOAL_STATUS_CONFLICT');
  const got = await (await fetch(`${AGENT}/goal/${s.id}`)).json();
  eq(got.goal.goalId, created.goal.goalId, '查询应命中同一目标');
});

await test('Goal REST：pause / resume / stop 语义与 409 边界', async () => {
  const s = await createAgentSession();
  const mk = async () => (await (await fetch(`${AGENT}/goal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: '目标甲' }),
  })).json()).goal;
  const g1 = await mk();
  const paused = await (await fetch(`${AGENT}/goal/pause`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id }),
  })).json();
  eq(paused.goal.status, 'paused');
  eq(paused.goal.statusReason, 'paused(user_requested)');
  const resumed = await (await fetch(`${AGENT}/goal/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id }),
  })).json();
  eq(resumed.goal.status, 'active');
  eq(resumed.goal.statusReason, null, '恢复后原因清零');
  const stopped = await (await fetch(`${AGENT}/goal/stop`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id }),
  })).json();
  eq(stopped.goal.status, 'complete');
  eq(stopped.goal.statusReason, 'complete(user_requested)');
  const stopAgain = await fetch(`${AGENT}/goal/stop`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id }),
  });
  eq(stopAgain.status, 409, '已完成目标再停止 409');
  const resumeDone = await fetch(`${AGENT}/goal/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id }),
  });
  eq(resumeDone.status, 409, 'complete 恢复 active 一律 409');
  const g2 = await mk();
  assert(g2.goalId !== g1.goalId, '完成后应允许创建新目标（替换语义）');
  const noGoal = await fetch(`${AGENT}/goal/pause`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: (await createAgentSession()).id }),
  });
  eq(noGoal.status, 404, '无目标时操作 404');
});

await test('Goal REST：edit 改写目标文本（空白 400 / 已完成 409），clear 幂等移除', async () => {
  const s = await createAgentSession();
  const created = (await (await fetch(`${AGENT}/goal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: '初版目标' }),
  })).json()).goal;
  const edited = await (await fetch(`${AGENT}/goal/edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: '  改写后的目标文本  ' }),
  })).json();
  eq(edited.goal.objective, '改写后的目标文本', 'edit 应 trim 后改写');
  eq(edited.goal.goalId, created.goalId, 'edit 应保留同一 goalId');
  const blank = await fetch(`${AGENT}/goal/edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: '   ' }),
  });
  eq(blank.status, 400, '空白目标文本 400');
  eq((await blank.json()).error.code, 'GOAL_BAD_OBJECTIVE');
  const noGoalEdit = await fetch(`${AGENT}/goal/edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: (await createAgentSession()).id, objective: 'x' }),
  });
  eq(noGoalEdit.status, 404, '无目标时 edit 404');
  // clear 幂等：没有目标也回 200 cleared=false，不抛错
  const emptyClear = await (await fetch(`${AGENT}/goal/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id }),
  })).json();
  eq(emptyClear.cleared, true, '有目标时 clear 应移除');
  const again = await (await fetch(`${AGENT}/goal/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id }),
  })).json();
  eq(again.cleared, false, '再次 clear 幂等');
  const miss = await (await fetch(`${AGENT}/goal/${s.id}`)).json();
  eq(miss.goal, null, '移除后查询为 null');
  // 已完成目标不能 edit（409），但可 clear 后重新创建
  const s2 = await createAgentSession();
  await fetch(`${AGENT}/goal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s2.id, objective: '会被完成' }),
  });
  await fetch(`${AGENT}/goal/stop`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s2.id }),
  });
  const editDone = await fetch(`${AGENT}/goal/edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s2.id, objective: '想改写' }),
  });
  eq(editDone.status, 409, '已完成目标 edit 409');
  const clearDone = await (await fetch(`${AGENT}/goal/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s2.id }),
  })).json();
  eq(clearDone.cleared, true, '已完成目标可 clear');
});

await test('Goal REST：edit 随文携带 tokenBudget（新鲜快照生效 / 纪元不符 409 GOAL_STALE）', async () => {
  const s = await createAgentSession();
  const created = (await (await fetch(`${AGENT}/goal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: '初版目标', tokenBudget: 1000 }),
  })).json()).goal;
  // 新鲜快照：文本与预算一并改写
  const edited = await (await fetch(`${AGENT}/goal/edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: s.id, objective: '二版目标', tokenBudget: 5000,
      expectedGoalId: created.goalId, expectedUpdatedAt: created.updatedAt,
    }),
  })).json();
  eq(edited.goal.objective, '二版目标');
  eq(edited.goal.tokenBudget, 5000, 'edit 应一并应用随文预算');
  // 陈旧纪元：409 GOAL_STALE
  const stale = await fetch(`${AGENT}/goal/edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: s.id, objective: '三版目标', tokenBudget: 9000,
      expectedGoalId: created.goalId, expectedUpdatedAt: created.updatedAt,
    }),
  });
  eq(stale.status, 409, 'edit 带预算纪元不符 409');
  eq((await stale.json()).error.code, 'GOAL_STALE');
  // 缺快照字段同样 409
  const noEpoch = await fetch(`${AGENT}/goal/edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: '三版目标', tokenBudget: 9000 }),
  });
  eq(noEpoch.status, 409, 'edit 带预算缺快照字段 409');
  // 不带 tokenBudget 的纯文本 edit 不受纪元门限制
  const textOnly = await (await fetch(`${AGENT}/goal/edit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: '纯文本改写' }),
  })).json();
  eq(textOnly.goal.objective, '纯文本改写');
  eq(textOnly.goal.tokenBudget, 5000, '纯文本 edit 不动预算');
});

await test('Goal REST：budget 纪元不符 409 GOAL_STALE，抬高预算重新武装 budget_limited(token)', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_GOAL_BUDGET 盯着把测试基线扩展到 300 个' }),
  });
  const all = await drainAgentStream(openAgentStream(resp));
  assert(all.find((e) => e.type === 'goal_status_changed' && e.goal.status === 'budget_limited'), '应先触顶');
  const cur = (await (await fetch(`${AGENT}/goal/${s.id}`)).json()).goal;
  eq(cur.status, 'budget_limited');
  eq(cur.statusReason, 'budget_limited(token)');
  const resumeLimited = await fetch(`${AGENT}/goal/resume`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id }),
  });
  eq(resumeLimited.status, 409, '预算耗尽不能直接恢复：须先抬高或清除预算');
  const stale = await fetch(`${AGENT}/goal/budget`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, tokenBudget: 100000, expectedGoalId: cur.goalId, expectedUpdatedAt: cur.updatedAt + 1 }),
  });
  eq(stale.status, 409, '纪元不符 409');
  eq((await stale.json()).error.code, 'GOAL_STALE');
  const badBudget = await fetch(`${AGENT}/goal/budget`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, tokenBudget: -3, expectedGoalId: cur.goalId, expectedUpdatedAt: cur.updatedAt }),
  });
  eq(badBudget.status, 400, '负预算 400');
  const raised = await (await fetch(`${AGENT}/goal/budget`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, tokenBudget: 100000, expectedGoalId: cur.goalId, expectedUpdatedAt: cur.updatedAt }),
  })).json();
  eq(raised.goal.status, 'active', '抬高到已用之上应重新武装');
  eq(raised.goal.statusReason, null, '重新武装后原因清零');
  eq(raised.goal.tokenBudget, 100000);
  const cleared = await (await fetch(`${AGENT}/goal/budget`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, tokenBudget: null, expectedGoalId: raised.goal.goalId, expectedUpdatedAt: raised.goal.updatedAt }),
  })).json();
  eq(cleared.goal.tokenBudget, null, '清零应移除上限');
  eq(cleared.goal.status, 'active');
});

await test('Goal 事件流：REST 改动目标扇出给同会话 SSE 订阅方（goal_cleared 跨客户端可见）', async () => {
  const s = await createAgentSession();
  const stream = openAgentStream(await fetch(`${AGENT}/events?sessionId=${s.id}`));
  // 订阅建立后再发起 REST 变更：发布发生在 POST 响应之前，帧必然先于下一步到达
  const created = await (await fetch(`${AGENT}/goal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: '跨客户端同步' }),
  })).json();
  const evCreated = await stream.next();
  eq(evCreated.type, 'goal_created', 'create 应扇出 goal_created');
  eq(evCreated.sessionId, s.id, '帧应带会话归属');
  eq(evCreated.goal.objective, '跨客户端同步');
  await fetch(`${AGENT}/goal/pause`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id }),
  });
  const evPaused = await stream.next();
  eq(evPaused.type, 'goal_status_changed', 'pause 应扇出 goal_status_changed');
  eq(evPaused.goal.status, 'paused');
  eq(evPaused.statusReason, 'paused(user_requested)', '载荷与 runtime.emitStatus 同形状');
  await fetch(`${AGENT}/goal/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id }),
  });
  const evCleared = await stream.next();
  eq(evCleared.type, 'goal_cleared', 'clear 应扇出 goal_cleared（另一客户端据此清横幅）');
  eq(evCleared.sessionId, s.id);
  // 幂等 clear（无目标）不发布事件：订阅方不应再收到帧
  await fetch(`${AGENT}/goal/clear`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id }),
  });
  const created2 = await (await fetch(`${AGENT}/goal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, objective: '再次创建' }),
  })).json();
  eq(created2.goal.objective, '再次创建');
  const evRecreated = await stream.next();
  eq(evRecreated.type, 'goal_created', '再次 create 仍应扇出（幂等 clear 未产生多余帧）');
  stream.cancel();
  const missing = await fetch(`${AGENT}/events?sessionId=不存在`);
  eq(missing.status, 404, '未知会话的事件流订阅应 404');
});

await test('Agent turn：计划模式驳回后不执行', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_PLAN 再规划一次', planMode: true }),
  });
  const stream = openAgentStream(resp);
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'plan_proposed' });
  await fetch(`${AGENT}/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, decision: 'reject' }),
  });
  const tail = await drainAgentStream(stream);
  const all = [...head, ...tail];
  assert(all.some((e) => e.type === 'plan_rejected'), '应有 plan_rejected 事件');
  const done = all.find((e) => e.type === 'turn_completed');
  eq(done && done.finishReason, 'plan_rejected', '驳回以 plan_rejected 收尾');
  const again = await fetch(`${AGENT}/plan`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, decision: 'approve' }),
  });
  eq((await again.json()).ok, false, '无等待中的计划请求应返回 ok:false');
});

await test('MCP：注册 mock 服务器并经 Agent turn 调用其工具（实验特性）', async () => {
  const created = await fetch(`${BASE}/api/mcp/servers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'mock', name: 'Mock MCP', transport: 'stdio', command: process.execPath, args: [join(__dirname, 'mock-mcp-server.mjs')] }),
  });
  eq(created.status, 200, '注册应成功');
  const list = await (await fetch(`${BASE}/api/mcp/servers`)).json();
  const row = list.servers.find((s) => s.id === 'mock');
  assert(row && row.connected && row.tools === 2, 'mock 服务器应连接并发现 2 个工具');
  const s0 = await createAgentSession();
  const resp0 = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s0.id, input: 'USE_MCP 调用 MCP 工具' }),
  });
  await drainAgentStream(openAgentStream(resp0), { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  const sentNames = (mock.state.lastChatBody?.tools || []).map((t) => t.function?.name || t.name);
  assert(sentNames.includes('mcp__mock__echo'), 'MCP 工具 schema 应进入请求顶层 tools[]');
  await fetch(`${AGENT}/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: s0.id }) });
  const bad = await fetch(`${BASE}/api/mcp/servers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: '坏 id', transport: 'stdio' }),
  });
  eq(bad.status, 400, '非法草稿应 400');
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_MCP 调用 MCP 工具' }),
  });
  const stream = openAgentStream(resp);
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  const askEv = head.find((e) => e.phase === 'confirmation_needed');
  assert(askEv && askEv.toolName === 'mcp__mock__echo', 'MCP 工具默认应询问授权');
  await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: askEv.requestId, decision: 'allow' }),
  });
  const tail = await drainAgentStream(stream);
  const all = [...head, ...tail];
  const done = all.find((e) => e.type === 'tool_event' && e.phase === 'completed' && e.toolName === 'mcp__mock__echo');
  assert(done && String(done.output).includes('MCP回声:来自模型的调用'), 'MCP 工具应执行并回传文本');
  assert(all.at(-1).type === 'turn_completed', '应以 turn_completed 收尾');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  const rec = detail.records.find((x) => x.t === 'tool_result' && x.name === 'mcp__mock__echo');
  assert(rec && rec.ok && String(rec.output).includes('MCP回声'), '转录应留 MCP 工具结果');
  const del = await fetch(`${BASE}/api/mcp/servers/mock`, { method: 'DELETE' });
  eq((await del.json()).removed, 1, '删除应生效');
  const after = await (await fetch(`${BASE}/api/mcp/servers`)).json();
  eq(after.servers.find((s2) => s2.id === 'mock'), undefined, '删除后不应再列出');
});

await test('MCP 显示开关：停用后工具不进请求，再开即恢复；非法载荷 400、未知服务器 404', async () => {
  const created = await fetch(`${BASE}/api/mcp/servers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 'mock', name: 'Mock MCP', transport: 'stdio', command: process.execPath, args: [join(__dirname, 'mock-mcp-server.mjs')] }),
  });
  eq(created.status, 200, '注册应成功');
  const off = await fetch(`${BASE}/api/mcp/servers/mock/enabled`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
  });
  eq(off.status, 200, '停用应成功');
  eq((await off.json()).servers.find((x) => x.id === 'mock').enabled, false, '快照应反映已停用');
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_MCP 调用 MCP 工具' }),
  });
  const stream = openAgentStream(resp);
  const evs = await drainAgentStream(stream);
  const sentNames = (mock.state.lastChatBody?.tools || []).map((t) => t.function?.name || t.name);
  assert(!sentNames.some((n) => String(n).startsWith('mcp__mock__')), '停用后 MCP 工具不应再进入请求顶层 tools[]');
  const rec = evs.find((e) => e.type === 'tool_event' && e.toolName === 'mcp__mock__echo' && String(e.output || '').includes('未知工具'));
  assert(rec && rec.phase === 'failed', '模型仍调用已停用服务器的工具时应得到未知工具回执');
  assert(evs.at(-1).type === 'turn_completed', '应以 turn_completed 收尾');
  const bad = await fetch(`${BASE}/api/mcp/servers/mock/enabled`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'no' }),
  });
  eq(bad.status, 400, 'enabled 非布尔应 400');
  const missing = await fetch(`${BASE}/api/mcp/servers/nope/enabled`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  eq(missing.status, 404, '未知服务器应 404');
  const on = await fetch(`${BASE}/api/mcp/servers/mock/enabled`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true }),
  });
  eq(on.status, 200, '再启用应成功');
  const s2 = await createAgentSession();
  const resp2 = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s2.id, input: 'USE_MCP 调用 MCP 工具' }),
  });
  const stream2 = openAgentStream(resp2);
  await drainAgentStream(stream2, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  const sent2 = (mock.state.lastChatBody?.tools || []).map((t) => t.function?.name || t.name);
  assert(sent2.includes('mcp__mock__echo'), '再启用后工具应回到请求顶层 tools[]');
  await fetch(`${AGENT}/abort`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: s2.id }) });
  await drainAgentStream(stream2);
  const del = await fetch(`${BASE}/api/mcp/servers/mock`, { method: 'DELETE' });
  eq((await del.json()).removed, 1, '删除应生效');
});

await test('Agent turn：空输入 400、未知会话 404', async () => {
  const s = await createAgentSession();
  const empty = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '  ' }),
  });
  eq(empty.status, 400);
  const noSess = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: '00000000-0000-0000-0000-000000000000', input: 'hi' }),
  });
  eq(noSess.status, 404);
});

await test('Agent turn：权限等待期间并发提交入队而非 409（#3212）', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_TOOL_WRITE 占位' }),
  });
  const stream = openAgentStream(resp);
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  assert(head.some((e) => e.phase === 'confirmation_needed'), '应进入权限等待');
  const second = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '第二个' }),
  });
  eq(second.status, 200, '活跃 turn 期间的新提交不再 409，改入队等待');
  const secondStream = openAgentStream(second);
  const ack = await drainAgentStream(secondStream, { until: (ev) => ev.type === 'turn_queued' });
  eq(ack.find((e) => e.type === 'turn_queued').position, 1, '回执应带队列位置');
  // 侧边对话仍与主对话互斥：409 语义不因队列松动
  const sideBusy = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '侧边插队', side: true }),
  });
  eq(sideBusy.status, 409, '主 turn 活跃时侧边提交仍应 409');
  // 收尾：拒绝权限让第一个 turn 跑完，泵接力第二条
  await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: head.find((e) => e.phase === 'confirmation_needed').requestId, decision: 'deny' }),
  });
  const tail = await drainAgentStream(stream);
  assert(tail.some((e) => e.type === 'turn_completed'), '拒绝后第一个 turn 应收尾');
  const relayed = await drainAgentStream(secondStream);
  assert(relayed.some((e) => e.type === 'turn_completed'), '队列里的第二条应由泵接力跑完');
  const empty = await (await fetch(`${AGENT}/queue/${s.id}`)).json();
  eq(empty.items.length, 0, '跑完后队列应清空');
});

// ---------- 侧边对话（/btw）：内存门面 turn、主 / 侧互斥、不派发子代理 ----------
await test('侧边对话 turn：继承主会话历史前缀、不污染主会话转录、可查可弃', async () => {
  const s = await createAgentSession();
  await drainAgentStream(openAgentStream(await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '主会话前缀标记 ALPHA' }),
  })));
  const before = (await (await fetch(`${AGENT}/sessions/${s.id}`)).json()).records;
  const side = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '侧边问题 BETA', side: true }),
  });
  const all = await drainAgentStream(openAgentStream(side));
  assert(all.some((e) => e.type === 'turn_completed'), '侧边 turn 应正常收尾');
  const after = (await (await fetch(`${AGENT}/sessions/${s.id}`)).json()).records;
  eq(after.length, before.length, '主会话转录不应被侧边对话写入');
  assert(!after.some((r) => r.t === 'user' && String(r.text).includes('BETA')), '侧边提问不应落进主会话');
  const got = await (await fetch(`${AGENT}/side/${s.id}`)).json();
  assert(got.records.some((r) => r.t === 'user' && String(r.text).includes('BETA')), '侧边转录应含侧边提问');
  // 侧边 turn 的请求应同时带上主会话前缀与新问题（SideSession 继承 completePrefix）
  const lastReq = mock.state.requests[mock.state.requests.length - 1].body;
  assert(lastReq.includes('ALPHA') && lastReq.includes('BETA'), '侧边 turn 请求应带上前缀与新问题');
  const sideTools = JSON.parse(lastReq).tools.map((t) => t.function.name);
  assert(!sideTools.includes('create_goal') && !sideTools.includes('update_goal'), '侧边对话不接管 goal，目标工具不应进请求 tools[]');
  const dropped = await (await fetch(`${AGENT}/side/discard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: s.id }),
  })).json();
  eq(dropped.ok, true, '应回 ok');
  eq(dropped.discarded, true, '应回报已丢弃');
  eq((await fetch(`${AGENT}/side/${s.id}`)).status, 404, '丢弃后查询应 404');
  eq((await (await fetch(`${AGENT}/side/discard`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: s.id }),
  })).json()).discarded, false, '重复丢弃应幂等');
});

await test('侧边对话不派发子代理：task 工具直接失败并说清原因', async () => {
  const s = await createAgentSession();
  const all = await drainAgentStream(openAgentStream(await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_SWARM 派个活下去', side: true }),
  })));
  const failed = all.find((e) => e.type === 'tool_event' && e.phase === 'failed');
  assert(failed, '侧边对话里派发子代理应失败');
  assert(String(failed.output).includes('侧边对话不派发子代理'), '失败原因应说清并给出下一步动作');
});

await test('侧边对话与主对话互斥：侧边 turn 活跃时主 turn 409', async () => {
  const s = await createAgentSession();
  const stream = openAgentStream(await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_TOOL_WRITE 占位', side: true }),
  }));
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  assert(head.some((e) => e.phase === 'confirmation_needed'), '侧边 turn 应进入权限等待');
  const main = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '主对话插队' }),
  });
  eq(main.status, 409, '侧边 turn 活跃时主 turn 应 409');
  await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: head.find((e) => e.phase === 'confirmation_needed').requestId, decision: 'deny' }),
  });
  const tail = await drainAgentStream(stream);
  assert(tail.some((e) => e.type === 'turn_completed'), '拒绝后侧边 turn 应收尾');
});

await test('删除会话同步作废其侧边对话', async () => {
  const s = await createAgentSession();
  await drainAgentStream(openAgentStream(await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '开一个侧边对话', side: true }),
  })));
  eq((await fetch(`${AGENT}/side/${s.id}`)).status, 200, '侧边对话应在场');
  await fetch(`${AGENT}/sessions/${s.id}`, { method: 'DELETE' });
  eq((await fetch(`${AGENT}/side/${s.id}`)).status, 404, '删除会话后侧边对话应随之失效');
});

await test('Agent turn：中断保留已生成内容且会话可继续', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'SLOW 慢慢说' }),
  });
  const stream = openAgentStream(resp);
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'text_chunk' });
  assert(head.some((e) => e.type === 'text_chunk'), '应已产生部分文本');
  const ab = await (await fetch(`${AGENT}/abort`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id }),
  })).json();
  eq(ab.aborted, true);
  const tail = await drainAgentStream(stream);
  assert(tail.some((e) => e.type === 'turn_cancelled'), '应发 turn_cancelled');
  const again = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '你好' }),
  });
  eq(again.status, 200, '中断后会话应可继续');
  await drainAgentStream(openAgentStream(again));
});

// ---------- 消息队列（本地化 #3212 / #3220）：入队 / 幂等 / 接力 / 取消 / 侧边不入队 ----------
await test('消息队列：重复 opId 只入队一次且不开第二条流', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_TOOL_WRITE 占位' }),
  });
  const stream = openAgentStream(resp);
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  assert(head.some((e) => e.phase === 'confirmation_needed'), '应进入权限等待');
  const post = (opId) => fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '排队甲', opId }),
  });
  const first = openAgentStream(await post('op-dup'));
  const ack1 = await drainAgentStream(first, { until: (ev) => ev.type === 'turn_queued' });
  eq(ack1.find((e) => e.type === 'turn_queued').duplicate, false, '首次入队不是重复');
  const second = await post('op-dup');
  eq(second.status, 200, '重复 opId 仍是 200（不开第二条流）');
  const ack2 = await drainAgentStream(openAgentStream(second), { until: (ev) => ev.type === 'turn_queued' });
  const dup = ack2.find((e) => e.type === 'turn_queued');
  eq(dup.duplicate, true, '重复 opId 回执应标记 duplicate');
  eq(dup.opId, 'op-dup', '重复 opId 回执应指回同一条');
  const list = await (await fetch(`${AGENT}/queue/${s.id}`)).json();
  eq(list.items.length, 1, '队列里只应有一条');
  // 收尾：放行权限让第一条跑完，队列里那一条被泵接力
  await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: head.find((e) => e.phase === 'confirmation_needed').requestId, decision: 'deny' }),
  });
  await drainAgentStream(stream);
  await drainAgentStream(first);
  const empty = await (await fetch(`${AGENT}/queue/${s.id}`)).json();
  eq(empty.items.length, 0, '接力跑完后队列清空');
});

await test('消息队列：取消等待中的消息后不被泵接力', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_TOOL_WRITE 占位' }),
  });
  const stream = openAgentStream(resp);
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  const queued = openAgentStream(await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '待取消', opId: 'op-cancel' }),
  }));
  await drainAgentStream(queued, { until: (ev) => ev.type === 'turn_queued' });
  const rm = await (await fetch(`${AGENT}/queue/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, opId: 'op-cancel' }),
  })).json();
  eq(rm.ok, true, '移除等待中的消息应成功');
  const gone = await (await fetch(`${AGENT}/queue/${s.id}`)).json();
  eq(gone.items.length, 0, '移除后队列为空');
  const cancelled = await drainAgentStream(queued);
  assert(cancelled.some((e) => e.type === 'turn_cancelled'), '被移除的流应收到 turn_cancelled');
  await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: head.find((e) => e.phase === 'confirmation_needed').requestId, decision: 'deny' }),
  });
  await drainAgentStream(stream);
  const after = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  assert(!after.records.some((r) => r.text === '待取消'), '取消掉的消息不应进转录');
});

await test('消息队列：promote 把选中项挪到队首', async () => {
  const s = await createAgentSession();
  const resp = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_TOOL_WRITE 占位' }),
  });
  const stream = openAgentStream(resp);
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  for (const [opId, text] of [['op-1', '先来'], ['op-2', '后到']]) {
    const st = openAgentStream(await fetch(`${AGENT}/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: s.id, input: text, opId }),
    }));
    await drainAgentStream(st, { until: (ev) => ev.type === 'turn_queued' });
  }
  const before = await (await fetch(`${AGENT}/queue/${s.id}`)).json();
  eq(before.items.map((i) => i.opId).join(','), 'op-1,op-2', '按入队序排列');
  const pr = await (await fetch(`${AGENT}/queue/promote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, opId: 'op-2' }),
  })).json();
  eq(pr.ok, true, 'promote 应成功');
  const after = await (await fetch(`${AGENT}/queue/${s.id}`)).json();
  eq(after.items.map((i) => i.opId).join(','), 'op-2,op-1', '选中项应被挪到队首');
  await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: head.find((e) => e.phase === 'confirmation_needed').requestId, decision: 'deny' }),
  });
  await drainAgentStream(stream);
  await new Promise((r) => setTimeout(r, 400));
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  const texts = detail.records.filter((r) => r.t === 'user').map((r) => r.text);
  eq(texts.indexOf('后到') < texts.indexOf('先来'), true, '被提升的那条应先跑');
});

await test('消息队列：侧边对话不入队也不接力', async () => {
  const s = await createAgentSession();
  const side = openAgentStream(await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_TOOL_WRITE 占位', side: true }),
  }));
  const head = await drainAgentStream(side, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  const main = await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: '主对话', opId: 'op-side' }),
  });
  eq(main.status, 409, '侧边 turn 活跃时主对话仍 409，不进队列');
  const list = await (await fetch(`${AGENT}/queue/${s.id}`)).json();
  eq(list.items.length, 0, '侧边活跃期间队列应为空');
  await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: head.find((e) => e.phase === 'confirmation_needed').requestId, decision: 'deny' }),
  });
  await drainAgentStream(side);
});

// ---------- 定时任务（本地化 #3149）：REST 面 / 变更信号 / cron 工具经 turn 落地 ----------
/** 清空数据目录里的定时任务：各用例自建自删，避免互相干扰（也避免遗留任务被调度器在后续测试里触发） */
async function clearJobs() {
  const rows = (await (await fetch(`${BASE}/api/jobs`)).json()).jobs || [];
  for (const j of rows) await fetch(`${BASE}/api/jobs/${j.id}`, { method: 'DELETE' });
}

await test('/api/jobs：REST 增删改查与坏值 400', async () => {
  await clearJobs();
  const s = await createAgentSession();
  const created = await (await fetch(`${BASE}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '早报', sessionId: s.id, prompt: '汇总今天', schedule: { kind: 'cron', expr: '0 9 * * *' } }),
  })).json();
  assert(created.job && created.job.id, '创建应回任务');
  assert(created.job.nextRunAt > Date.now(), 'nextRunAt 应在未来');
  const bad = await fetch(`${BASE}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '', sessionId: s.id, prompt: 'x', schedule: { kind: 'cron', expr: 'nope' } }),
  });
  eq(bad.status, 400, '非法草稿 400');
  assert((await bad.json()).error.message.includes('任务名称'), '400 应带中文字段原因');
  const badEvery = await fetch(`${BASE}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'x', sessionId: s.id, prompt: 'x', schedule: { kind: 'interval', everyMs: 500 } }),
  });
  eq(badEvery.status, 400, '间隔低于下限 400');
  const list = await (await fetch(`${BASE}/api/jobs?sessionId=${s.id}`)).json();
  eq(list.jobs.length, 1, '按会话过滤后应只有一条');
  const off = await (await fetch(`${BASE}/api/jobs/${created.job.id}/toggle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: false }),
  })).json();
  eq(off.job.enabled, false, '停用生效');
  eq(off.job.nextRunAt, null, '停用后清空下次运行');
  const badToggle = await fetch(`${BASE}/api/jobs/${created.job.id}/toggle`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: 'nope' }),
  });
  eq(badToggle.status, 400, 'enabled 非布尔 400');
  const runMissing = await fetch(`${BASE}/api/jobs/${created.job.id}/run`, { method: 'POST' });
  eq(runMissing.status, 200, '立即运行应放行（由 HTTP 面注入的执行器跑）');
  const del = await (await fetch(`${BASE}/api/jobs/${created.job.id}`, { method: 'DELETE' })).json();
  eq(del.removed, true, '删除成功');
  eq((await (await fetch(`${BASE}/api/jobs`)).json()).jobs.length, 0, '删后列表为空');
  eq((await fetch(`${BASE}/api/jobs/不存在`, { method: 'DELETE' })).status, 404, '未知 id 走 404');
});

await test('jobs_changed 变更信号到达 SSE 订阅方', async () => {
  await clearJobs();
  const s = await createAgentSession();
  const es = await fetch(`${BASE}/api/jobs/events`);
  eq(es.status, 200, '事件流应可订阅');
  eq(es.headers.get('content-type'), 'text/event-stream', '应为 SSE');
  const stream = openAgentStream(es);
  const created = await (await fetch(`${BASE}/api/jobs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '信号', sessionId: s.id, prompt: 'x', schedule: { kind: 'interval', everyMs: 60000 } }),
  })).json();
  const ev = await stream.next();
  eq(ev.type, 'jobs_changed', 'REST 创建后订阅方应收到 jobs_changed');
  assert(Array.isArray(ev.jobs) && ev.jobs.some((j) => j.id === created.job.id), '负载应带最新任务列表');
  // 删除同样要推一帧：设置面板靠这个信号重读，不靠轮询
  await fetch(`${BASE}/api/jobs/${created.job.id}`, { method: 'DELETE' });
  const ev2 = await stream.next();
  eq(ev2.type, 'jobs_changed', '删除也应推一帧');
  assert(!ev2.jobs.some((j) => j.id === created.job.id), '删除后的列表不应再含该任务');
  stream.cancel();
  eq((await (await fetch(`${BASE}/api/jobs`)).json()).jobs.length, 0, '收尾清理后列表为空');
});

await test('Agent turn：模型经 cron 工具自建定时任务（权限询问 → 落库 → jobs_changed）', async () => {
  await clearJobs();
  const s = await createAgentSession({ permissionMode: 'never_ask' });
  const stream = openAgentStream(await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_CRON 建一个定时任务' }),
  }));
  const events = await drainAgentStream(stream);
  const toolDone = events.find((e) => e.type === 'tool_event' && e.phase === 'completed');
  assert(toolDone && toolDone.output.includes('已创建'), `cron 工具应创建成功，实际：${toolDone && toolDone.output}`);
  const jobs = await (await fetch(`${BASE}/api/jobs?sessionId=${s.id}`)).json();
  eq(jobs.jobs.length, 1, '任务应落库');
  eq(jobs.jobs[0].name, 'mock 定时任务', '名称应来自模型参数');
  assert(events.some((e) => e.type === 'jobs_changed'), 'turn 内改了任务应推 jobs_changed');
  const detail = await (await fetch(`${AGENT}/sessions/${s.id}`)).json();
  assert(detail.records.some((r) => r.name === 'cron'), '转录应记下 cron 工具调用');
  // 收尾：删掉这条，别让后续测试被它干扰
  await fetch(`${BASE}/api/jobs/${jobs.jobs[0].id}`, { method: 'DELETE' });
});

await test('Agent turn：cron 默认要权限（ask_when_needed 下弹权限卡）', async () => {
  await clearJobs();
  const s = await createAgentSession();
  const stream = openAgentStream(await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_CRON 建一个定时任务' }),
  }));
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  const ask = head.find((e) => e.phase === 'confirmation_needed');
  assert(ask, 'cron 应触发权限询问');
  eq(ask.toolName, 'cron', '被询问的工具应是 cron');
  await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: ask.requestId, decision: 'deny' }),
  });
  await drainAgentStream(stream);
  eq((await (await fetch(`${BASE}/api/jobs?sessionId=${s.id}`)).json()).jobs.length, 0, '拒绝后不应落库');
});

// ---------- computer_use（#3191 macOS 零依赖子集） ----------
const fakePng = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
/** 假执行器：按命令名回固定结果，screencapture 落一张假 PNG（不打真屏幕） */
function fakeExec(overrides = {}) {
  const calls = [];
  const run = async (cmd, args = []) => {
    calls.push([cmd, ...args].join(' '));
    if (overrides[cmd]) return overrides[cmd](args);
    if (cmd === 'osascript') return { code: 0, stdout: '321', stderr: '' };
    if (cmd === 'screencapture') {
      const path = args[args.length - 1];
      writeFileSync(path, fakePng);
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'sips') return { code: 0, stdout: 'pixelWidth: 1440\npixelHeight: 900\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  run.calls = calls;
  return run;
}

await test('多模态 tool result：assembleMessages 把截图投影成 OpenAI image_url 片段', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-shot-'));
  const file = join(dir, 'shot.png');
  writeFileSync(file, fakePng);
  const harness = getHarness('standard');
  const msgs = assembleMessages({
    harness, workspace: dir,
    records: [
      { t: 'user', text: '看屏幕' },
      { t: 'tool_call', id: 'c1', name: 'computer_use', args: { actions: [{ type: 'observe' }] } },
      { t: 'tool_result', id: 'c1', name: 'computer_use', ok: true, output: '截图 1440x900', extra: { image: { path: file, mime: 'image/png', width: 1440, height: 900 } } },
      { t: 'assistant', text: '看到了' },
    ],
  });
  const tool = msgs.find((m) => m.role === 'tool');
  assert(Array.isArray(tool.content), '带截图的 tool 消息应是 content 数组');
  eq(tool.content[0].type, 'text', '文本片段在前');
  const img = tool.content.find((p) => p.type === 'image_url');
  assert(img && img.image_url.url.startsWith('data:image/png;base64,'), '截图应转成 data URL');
  // 无 extra.image 的历史形态不变：仍是纯字符串，别为所有工具改变协议形状
  const plain = assembleMessages({ harness, workspace: dir, records: [
    { t: 'user', text: '读文件' },
    { t: 'tool_call', id: 'c2', name: 'read_file', args: { path: 'a.txt' } },
    { t: 'tool_result', id: 'c2', name: 'read_file', ok: true, output: '内容' },
  ] });
  eq(typeof plain.find((m) => m.role === 'tool').content, 'string', '无截图时保持纯字符串');
  // 截图文件已不在时只回文本，不炸消息序列
  rmSync(file);
  const gone = assembleMessages({ harness, workspace: dir, records: [
    { t: 'user', text: '看屏幕' },
    { t: 'tool_call', id: 'c3', name: 'computer_use', args: {} },
    { t: 'tool_result', id: 'c3', name: 'computer_use', ok: true, output: '截图', extra: { image: { path: file, mime: 'image/png' } } },
  ] });
  eq(typeof gone.find((m) => m.role === 'tool').content, 'string', '截图丢失时回落纯文本');
  rmSync(dir, { recursive: true, force: true });
});

await test('多模态 tool result：Anthropic 协议的 tool_result 带 image block', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-shot-'));
  const file = join(dir, 'shot.png');
  writeFileSync(file, fakePng);
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '看屏幕' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'computer_use', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: [{ type: 'text', text: '截图 1440x900' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${fakePng.toString('base64')}` } }] },
  ];
  const built = buildChatRequest({ protocol: 'anthropic', baseUrl: 'http://127.0.0.1:1', apiKey: 'k' }, { model: 'm', messages });
  const turn = built.body.messages.find((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result'));
  const block = turn.content.find((b) => b.type === 'tool_result');
  eq(block.tool_use_id, 'c1', 'tool_use_id 对齐');
  const kinds = block.content.map((b) => b.type);
  assert(kinds.includes('image'), `tool_result 应带 image block，实际 ${JSON.stringify(kinds)}`);
  eq(block.content.find((b) => b.type === 'image').source.media_type, 'image/png', 'media_type 从 data URL 拆出');
  rmSync(dir, { recursive: true, force: true });
});

await test('computer_use：批量动作逐条回执，observe 产出截图与 extra.image', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-shot-'));
  const exec = fakeExec();
  const res = await runComputer({ exec, shotsDir: dir, urlBase: '/api/shots/sess' }, {
    app: 'Safari',
    actions: [{ type: 'observe' }, { type: 'click', x: 10, y: 20 }, { type: 'type', text: 'hi' }, { type: 'key', key: 'cmd+c' }, { type: 'nope' }],
  });
  assert(typeof res === 'object' && res.output, '成功截图应回 { output, extra }');
  eq(res.extra.image.url, `/api/shots/sess/${res.extra.image.path.split('/').pop()}`, '截图 URL 由 urlBase 派生');
  eq(res.extra.image.width, 1440, '像素宽度来自 sips');
  const receipts = res.extra.actions;
  eq(receipts.length, 5, '每个动作一条回执');
  eq(receipts[0].ok, true, 'observe 成功');
  eq(receipts[4].ok, false, '未知动作类型记失败');
  assert(res.output.includes('动作回执 4/5 成功'), `回执汇总应可读：${res.output.slice(0, 80)}`);
  assert(exec.calls.some((c) => c.includes('click at {10, 20}')), '点击应经 System Events 派发');
  assert(exec.calls.some((c) => c.includes('keystroke "hi"')), '输入应经 keystroke 派发');
  assert(exec.calls.some((c) => c.includes('keystroke "c" using {command down}')), '组合键应拆成 keystroke + 修饰键');
  assert(exec.calls.some((c) => c.includes('screencapture')), '应真的调 screencapture');
  rmSync(dir, { recursive: true, force: true });
});

await test('computer_use：用户中止后不再派发后续动作', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-shot-'));
  const controller = new AbortController();
  let release = null;
  const gate = new Promise((r) => { release = r; });
  // 只把「点击」这一步卡住：授权探测要先跑完，否则中止发生在探测期就验不到动作派发
  const exec = fakeExec({ osascript: async (args) => (String(args[1]).includes('click at') ? (await gate, { code: 0, stdout: '', stderr: '' }) : { code: 0, stdout: '321', stderr: '' }) });
  const running = runComputer({ exec, shotsDir: dir }, { actions: [{ type: 'wait', ms: 1 }, { type: 'click', x: 1, y: 2 }, { type: 'click', x: 3, y: 4 }] }, controller.signal);
  await new Promise((r) => setTimeout(r, 20));
  controller.abort();
  release();
  const res = await running;
  assert(String(res).includes('用户中止了本次操作'), `中止应给出中文原因：${res}`);
  assert(!exec.calls.some((c) => c.includes('click at {3, 4}')), '中止后不得再派发动作');
  rmSync(dir, { recursive: true, force: true });
});

await test('computer_use：未授权时返回中文系统设置指引而非静默失败', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lc-shot-'));
  const noA11y = await runComputer({ exec: fakeExec({ osascript: async () => ({ code: 1, stdout: '', stderr: 'not allowed assistive access' }) }), shotsDir: dir }, { actions: [{ type: 'observe' }] });
  assert(String(noA11y).includes('辅助功能') && String(noA11y).includes('系统设置'), `应给辅助功能指引：${noA11y}`);
  const noScreen = await runComputer({ exec: fakeExec({ screencapture: async () => ({ code: 1, stdout: '', stderr: 'denied' }) }), shotsDir: dir }, { actions: [{ type: 'observe' }] });
  assert(String(noScreen).includes('屏幕录制'), `应给屏幕录制指引：${noScreen}`);
  const empty = await runComputer({ exec: fakeExec(), shotsDir: dir }, { actions: [] });
  assert(String(empty).includes('actions 不能为空'), '空动作应说清原因');
  rmSync(dir, { recursive: true, force: true });
});

await test('Agent turn：computer_use 默认要权限（ask_when_needed 下弹权限卡）', async () => {
  const s = await createAgentSession({ harness: 'ultimate' });
  const stream = openAgentStream(await fetch(`${AGENT}/turn`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: s.id, input: 'USE_COMPUTER 看一眼屏幕' }),
  }));
  const head = await drainAgentStream(stream, { until: (ev) => ev.type === 'tool_event' && ev.phase === 'confirmation_needed' });
  const ask = head.find((e) => e.phase === 'confirmation_needed');
  assert(ask, 'computer_use 应触发权限询问');
  eq(ask.toolName, 'computer_use', '被询问的工具应是 computer_use');
  await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: ask.requestId, decision: 'deny' }),
  });
  const events = await drainAgentStream(stream);
  const done = events.find((e) => e.type === 'tool_event' && e.phase === 'failed');
  assert(done && done.output.includes('用户拒绝'), `拒绝后应回绝因：${done && done.output}`);
  assert(!existsSync(join(tmpDataDir, 'shots', s.id)), '拒绝后不应产生截图目录');
});

await test('/api/shots 路由服务会话截图并挡住目录穿越', async () => {
  const s = await createAgentSession({ harness: 'ultimate' });
  const dir = join(tmpDataDir, 'shots', s.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '1696000000000.png'), fakePng);
  const ok = await fetch(`${BASE}/api/shots/${s.id}/1696000000000.png`);
  eq(ok.status, 200, '白名单内的截图应可访问');
  eq(ok.headers.get('content-type'), 'image/png', 'Content-Type 按扩展名');
  const miss = await fetch(`${BASE}/api/shots/${s.id}/nope.png`);
  eq(miss.status, 404, '不存在的文件 404');
  const net = await import('node:net');
  const raw = await new Promise((done) => {
    const sock = net.connect(WEB_PORT, '127.0.0.1', () => {
      sock.write(`GET /api/shots/${s.id}/../auroraagent.config.json HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => done(buf));
    sock.on('error', () => done(''));
  });
  assert(raw.startsWith('HTTP/1.1 403') || raw.startsWith('HTTP/1.1 404'), `原始 socket 目录穿越必须挡住，实际: ${raw.slice(0, 40)}`);
  const encoded = await fetch(`${BASE}/api/shots/${s.id}/..%2fauroraagent.config.json`);
  assert(encoded.status === 403 || encoded.status === 404, `编码斜杠穿越必须挡住，实际 ${encoded.status}`);
  rmSync(dir, { recursive: true, force: true });
});

await test('harness / policy / transcript：computer_use 仅进 Ultimate 且默认要权限', async () => {
  eq(getHarness('ultimate').tools.includes('computer_use'), true, 'Ultimate 应收录 computer_use');
  eq(getHarness('standard').tools.includes('computer_use'), false, 'Standard 不收录');
  eq(getHarness('minimal').tools.includes('computer_use'), false, 'Minimal 不收录');
  eq(defaultRules().find((r) => r.action === 'computer_use').effect, 'ask', '默认要权限');
  const p = new PermissionPolicy(defaultRules(), []);
  eq(p.effective('computer_use', 'screen:Safari'), 'ask', '未授权规则前应询问');
  eq(toolLabel('computer_use'), '屏幕操作', '中文标签');
  eq(toolIconKey('computer_use'), 'screen', '图标键');
  eq(toolResourceOf('computer_use', { app: 'Safari' }), 'Safari', '资源摘要取目标应用');
  eq(toolResource('computer_use', { app: 'Safari' }), 'screen:Safari', '权限资源按应用区分');
  eq(toolSchemas(['computer_use']).length, 0, '内置工具集里没有它');
  eq(toolSchemas(['computer_use'], [createComputerRuntime({ exec: fakeExec(), shotsDir: join(tmpdir(), 'lc-shot-x') })]).length, 1, '经 extraTools 入列');
});

await test('Agent 权限：未知 requestId 返回 ok:false', async () => {
  const r = await (await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'nope', decision: 'allow' }),
  })).json();
  eq(r.ok, false);
});

await test('/app 服务 React 构建产物（HTML / 哈希资产 / SPA 回退）', async () => {
  const html = await (await fetch(`${BASE}/app/`)).text();
  assert(html.includes('id="root"'), '应返回应用挂载点');
  assert(html.includes('/app/assets/'), '应引用 /app 基准的资产路径');
  const noSlash = await fetch(`${BASE}/app`);
  eq(noSlash.status, 200);
  assert((await noSlash.text()).includes('id="root"'), '/app 无斜杠也应回退 index.html');
  const assetMatch = /\/app\/assets\/[A-Za-z0-9._-]+\.js/.exec(html);
  assert(assetMatch, 'HTML 应引用 JS 资产');
  const asset = await fetch(`${BASE}${assetMatch[0]}`);
  eq(asset.status, 200);
  assert((asset.headers.get('content-type') || '').includes('javascript'), 'JS 资产 MIME 正确');
  assert((asset.headers.get('cache-control') || '').includes('immutable'), '哈希资产应可长缓存');
  const spa = await fetch(`${BASE}/app/some/deep/route`);
  assert((await spa.text()).includes('id="root"'), '未知子路径应 SPA 回退');
  const missing = await fetch(`${BASE}/app/assets/nope-xyz.js`);
  eq(missing.status, 404, '不存在的资产应 404');
});

await test('静态资源 ETag 协商：If-None-Match 命中回 304 且校验器在场', async () => {
  const first = await fetch(`${BASE}/app/`);
  const etag = first.headers.get('etag');
  assert(etag, 'index.html 应带 ETag');
  assert((first.headers.get('cache-control') || '').includes('no-cache'), 'SPA 外壳应可重验证（no-cache）');
  const again = await fetch(`${BASE}/app/`, { headers: { 'If-None-Match': etag } });
  eq(again.status, 304, '命中 If-None-Match 应回 304');
  eq(again.headers.get('etag'), etag, '304 应带回同一 ETag');
  const stale = await fetch(`${BASE}/app/`, { headers: { 'If-None-Match': '"stale-value"' } });
  eq(stale.status, 200, 'ETag 不匹配应回 200 全量');
});

await test('SPA 入口缓存头回归：/ 与 /app 各形态都必须 no-cache（曾误给 immutable 导致发版后老页面死缓存）', async () => {
  for (const path of ['/', '/index.html', '/app', '/app/']) {
    const res = await fetch(`${BASE}${path}`);
    eq(res.status, 200, `${path} 应返回 200`);
    const cc = res.headers.get('cache-control') || '';
    assert(cc.includes('no-cache'), `${path} 的 index.html 必须 no-cache（实测 ${cc}）`);
    assert(!cc.includes('immutable'), `${path} 的 index.html 不允许 immutable（实测 ${cc}）`);
    assert((await res.text()).includes('id="root"'), `${path} 应回退应用外壳`);
  }
  const asset = await fetch(`${BASE}/app/assets/index-B8bdGgbp.js`).catch(() => null);
  if (asset && asset.status === 200) {
    assert((asset.headers.get('cache-control') || '').includes('immutable'), '真实哈希资产仍应 immutable');
  }
});

await test('/app 防目录穿越（原始 socket 不过滤 ..）', async () => {
  const net = await import('node:net');
  const raw = await new Promise((done) => {
    const sock = net.connect(WEB_PORT, '127.0.0.1', () => {
      sock.write('GET /app/../web.mjs HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
    });
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => done(buf));
    sock.on('error', () => done(''));
  });
  assert(raw.startsWith('HTTP/1.1 403'), '目录穿越必须 403，实际: ' + raw.slice(0, 40));
});

await test('本地请求守卫：伪造 Host / 异源 Origin / 跨站提交一律 403，豁免路径照常', async () => {
  const net = await import('node:net');
  const rawOnce = (path, headers) => new Promise((done) => {
    const sock = net.connect(WEB_PORT, '127.0.0.1', () => {
      sock.write(`GET ${path} HTTP/1.1\r\n${headers}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => { buf += d; });
    sock.on('end', () => done(buf));
    sock.on('error', () => done(''));
  });
  const evilHost = await rawOnce('/api/status', 'Host: evil.com');
  assert(evilHost.startsWith('HTTP/1.1 403'), '伪造 Host（DNS rebinding）应 403，实际: ' + evilHost.slice(0, 60));
  assert(evilHost.includes('forbidden_origin'), '拒绝话体应带 forbidden_origin');
  const crossOrigin = await rawOnce('/api/status', `Host: 127.0.0.1:${WEB_PORT}\r\nOrigin: https://evil.com`);
  assert(crossOrigin.startsWith('HTTP/1.1 403'), '异源 Origin 应 403');
  const crossSite = await rawOnce('/api/status', `Host: 127.0.0.1:${WEB_PORT}\r\nSec-Fetch-Site: cross-site`);
  assert(crossSite.startsWith('HTTP/1.1 403'), '无 Origin 的跨站提交应 403');
  const health = await rawOnce('/api/health', 'Host: evil.com');
  assert(health.startsWith('HTTP/1.1 200'), '豁免路径（健康检查）即使 Host 坏也放行');
  const sameOrigin = await rawOnce('/api/health', `Host: 127.0.0.1:${WEB_PORT}\r\nOrigin: http://127.0.0.1:${WEB_PORT}`);
  assert(sameOrigin.startsWith('HTTP/1.1 200'), '同源请求照常放行');
  const logs = await (await fetch(`${BASE}/api/logs/errors`)).json();
  assert(logs.entries.some((e) => e.kind === 'http_guard'), '守卫拒绝应留痕 http_guard 错误日志');
});

  await test('未知路径 404', async () => {
    const r = await fetch(`${BASE}/nope`);
    eq(r.status, 404);
  });
} finally {
  child.kill();
  mock.server.close();
  rmSync(tmpDataDir, { recursive: true, force: true });
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
