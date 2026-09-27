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
import { splitMathSegments, takeDisplayMath, isDisplayMathStart, mathDisplay, MATH_ENVIRONMENTS } from '../web-ui/src/math-split.mjs';
import { startMock } from './mock-longcat.mjs';
import { ProviderStore, ProviderError, parseCapacity, formatCapacity, normalizeEndpoint, validateProviderDraft, chatUrl, modelsUrl, messagesUrl } from '../util/providers.mjs';
import { buildChatRequest, anthropicFrame } from '../util/wire.mjs';
import { consumeAgentStream } from '../util/stream.mjs';
import { agentEvent, sseFrame } from '../util/agent/events.mjs';
import { HARNESSES, getHarness, harnessSummaries, DEFAULT_HARNESS } from '../util/agent/harness.mjs';
import { SessionStore } from '../util/agent/session.mjs';
import { getTool, toolSchemas, anthropicToolSchemas, toolResource, resolveInside, lineDiff, diffToText, renderTodoList } from '../util/agent/tools.mjs';
import { toolLabel, toolIconKey, toolResourceOf, fmtCost, projectTurns } from '../util/agent/transcript.mjs';
import { PermissionPolicy, defaultRules, mostRestrictive } from '../util/agent/policy.mjs';
import { assembleMessages, needsCompaction, planCompaction, compactionMessages, contextWindowOf, estimateMessagesTokens } from '../util/agent/context.mjs';
import { runAgentTurn } from '../util/agent/loop.mjs';
import { connectMcp, callResultText, McpError } from '../util/mcp/client.mjs';
import { McpRegistry, validateServerDraft, loadMcpServers, mcpToolName } from '../util/mcp/registry.mjs';
import { UsageLedger } from '../util/usage.mjs';
import { runTuiToolkitTests } from './tui-toolkit.mjs';
import { runGuardTests } from './guards.mjs';
import { runLlmTests } from './llm.mjs';
import { runHighlightTests } from './highlight.mjs';
import { runConfigTests } from './config.mjs';
import { runTuiComponentTests } from './tui-components.mjs';
import { runPickTests } from './pick.mjs';
import { runSkillsTests } from './skills.mjs';
import { runTitleTests } from './title.mjs';

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
await runConfigTests(test, assert, eq);
await runTuiComponentTests(test, assert, eq);
  await runPickTests(test, assert, eq);
  await runSkillsTests(test, assert, eq);
await runTitleTests(test, assert, eq);
await runGuardTests(test, assert);

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
  assert(out.includes('[技能：demo]') && out.includes('B'), 'run 返回技能正文');
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
  eq(msgs[0].role, 'system');
  assert(msgs[0].content.includes('/tmp/ws'), '系统提示应带工作目录');
  eq(msgs[1].content, '你好');
  eq(msgs[2].content, '你好！');
  eq(msgs[3].content, '读文件');
  eq(msgs[4].role, 'assistant');
  eq(msgs[4].tool_calls[0].function.name, 'read_file');
  eq(msgs[5].role, 'tool');
  eq(msgs[5].tool_call_id, 'tc1');
  eq(msgs.length, 6, 'thinking 与 usage 不应进上下文');
  const withSummary = assembleMessages({ harness: getHarness('minimal'), workspace: '/tmp/ws', records: [{ t: 'summary', text: '摘要内容' }, { t: 'user', text: '继续' }] });
  assert(withSummary[1].content.includes('摘要内容'), 'summary 应投影为系统消息');
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
  eq(contextWindowOf({}), 128000, '未声明窗口回退 128k');
  eq(contextWindowOf({ capacity: { contextWindow: 262144 } }), 262144, '应读取提供方声明窗口');
});

// ---------- 单元测试: Agent Loop ----------
console.log('\nMCP 客户端单元测试（mock stdio 服务器）');

await test('MCP 注册表：草稿校验与配置落盘', () => {
  const bad = validateServerDraft({ id: '坏 id', transport: 'stdio' });
  eq(bad.ok, false, '非法 ID 应拒绝');
  assert(bad.errors.id && bad.errors.command, '应定位到 id 与 command 字段');
  const badUrl = validateServerDraft({ id: 'web', transport: 'http', url: 'ftp://x' });
  eq(badUrl.ok, false, 'HTTP 传输应拒绝非 http(s) 端点');
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
async function runLoopOnce({ framesByCall, harness = getHarness('standard'), permission = 'allow', seedRecords = [], providerExtra = {}, input = '开始', planMode = false, planDecision = 'approve', sessionName = '' }) {
  const dir = mkdtempSync(join(tmpdir(), 'mt-loop-'));
  const ws = join(dir, 'workspace');
  mkdirSync(ws, { recursive: true });
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
    if (opts.signal?.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const scripted = typeof framesByCall === 'function' ? framesByCall(call, requests.at(-1)) : framesByCall[Math.min(call, framesByCall.length - 1)];
    call++;
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
    requestPlanDecision: async () => planDecision,
    log: () => {},
  }).finally(() => { globalThis.fetch = realFetch; });
  return { dir, ws, store, usage, session, events, requests, result, permCalls };
}

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
await test('transcript: projectTurns 按模型轮分组并回填工具结果', () => {
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
  eq(turns.length, 5);
  eq(turns[0].kind, 'user');
  eq(turns[1].kind, 'round');
  eq(turns[1].text, '好的');
  eq(turns[1].thinking, '想想');
  eq(turns[1].tools.length, 1);
  eq(turns[1].tools[0].ok, true);
  eq(turns[1].tools[0].output, '内容');
  eq(turns[1].usage.cost, 0.001);
  eq(turns[2].text, '第二轮答复');
  eq(turns[2].tools.length, 0);
  eq(turns[3].kind, 'user');
  eq(turns[3].text, '问题二');
  eq(turns[4].kind, 'system');
});
await test('transcript: projectTurns 工具后新文本开新轮（与 Web 契约一致）', () => {
  const { turns } = projectTurns([
    { t: 'assistant', text: '第一轮' },
    { t: 'tool_call', id: 'c1', name: 'shell', args: { command: 'ls' } },
    { t: 'tool_result', id: 'c1', name: 'shell', ok: false, output: '失败' },
    { t: 'assistant', text: '工具之后' },
  ]);
  eq(turns.length, 2);
  eq(turns[0].text, '第一轮');
  eq(turns[0].tools[0].ok, false);
  eq(turns[1].text, '工具之后');
  eq(turns[1].tools.length, 0);
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
    const composer = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Composer.tsx'), 'utf8');
    assert(composer.includes('PERM_LABEL') && composer.includes('always_ask') && composer.includes('never_ask'), '输入区应有权限三档选择器');
    assert(composer.includes('onPlanMode'), '输入区应有计划模式开关');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    assert(app.includes('respondPlan') && app.includes('plan_proposed') && app.includes('plan_approved'), 'App 应接线计划决策回传与计划事件');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'tokens.css'), 'utf8');
    assert(css.includes('--diff-add:') && css.includes('--diff-del:'), 'tokens.css 应有 diff 语义令牌');
  });
  await test('会话标题自动总结源码契约：事件登记、前端实时刷新与产物同步', async () => {
    const events = readFileSync(join(__dirname, '..', 'util', 'agent', 'events.mjs'), 'utf8');
    assert(events.includes("'session_renamed'"), '事件协议应登记 session_renamed');
    const types = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'types.ts'), 'utf8');
    assert(types.includes("type: 'session_renamed'"), '前端事件类型应声明 session_renamed');
    const app = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'App.tsx'), 'utf8');
    assert(app.includes("ev.type === 'session_renamed'"), 'App 应处理 session_renamed 并实时刷新会话标题');
    const turn = readFileSync(join(__dirname, '..', 'util', 'agent', 'terminal-turn.mjs'), 'utf8');
    assert(turn.includes("case 'session_renamed':"), '终端渲染器应呈现标题更新提示');
    const html = await (await fetch(`${BASE}/`)).text();
    const js = await (await fetch(`${BASE}${/\/app\/assets\/[A-Za-z0-9._-]+\.js/.exec(html)[0]}`)).text();
    assert(js.includes('session_renamed'), '构建产物应含标题刷新逻辑（改了 web-ui 忘了 build:web 会红）');
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
  await test('代码高亮源码契约：Markdown 代码块接入零依赖高亮器', () => {
    const md = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'markdown.tsx'), 'utf8');
    assert(md.includes("from './highlight'") && md.includes('highlightCode(buf.join'), '代码块应走高亮器');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.md pre .c-key') && css.includes('.md pre .c-str') && css.includes('.md pre .c-com'), '高亮 token 应有语义样式');
  });
  await test('技能界面源码契约：斜杠调色板与设置技能目录在场', () => {
    const pal = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'SkillPalette.tsx'), 'utf8');
    assert(pal.includes('技能命令') && pal.includes('navigate'), '调色板应有标题与键位提示');
    assert(pal.includes('❯'), '调色板应使用统一选中指针');
    const sp = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'SkillsPanel.tsx'), 'utf8');
    assert(sp.includes('listSkills') && sp.includes('/<技能名>'), '技能目录应列出并说明调用方式');
    const com = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'components', 'Composer.tsx'), 'utf8');
    assert(com.includes('SkillPalette') && com.includes('slashOpen'), '输入区应接入斜杠调色板');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.skillpal-item') && css.includes('.skillpal-hint'), 'app.css 应有调色板样式');
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
    assert(settings.includes('<McpPanel />'), '设置弹层应嵌入 MCP 面板');
    const api = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'api.ts'), 'utf8');
    assert(api.includes('listMcpServers') && api.includes('createMcpServer') && api.includes('deleteMcpServer') && api.includes('probeMcpServer'), 'api 客户端应覆盖 MCP 四个调用');
    const css = readFileSync(join(__dirname, '..', 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.mcp-form') && css.includes('.mcp-form-row'), 'app.css 应有 MCP 表单样式');
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
  await test('网络层失败时连接期自动重试并成功', async () => {
    const before = mock.state.requests.length;
    const s = await readStream(await chat({ messages: [{ role: 'user', content: 'FLAKY 网络抖动一下' }] }));
    assert(s.raw.includes('LongCat-2.5-Preview'), '重试后仍未拿到回答');
    assert(mock.state.requests.length >= before + 2, '没有发生连接期重试');
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
  assert(userRec && String(userRec.text).includes('[技能：code-review]'), '斜杠命令应展开为技能注入文本');
  assert(String(userRec.text).includes('看看这段代码'), '技能参数应拼在注入文本');
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
  assert(result.output.includes('[技能：code-review]') && result.output.includes('代码审查技能') && result.output.includes('按严重级分级'), '结果应含技能正文');
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

await test('Agent turn：权限等待期间并发发起返回 409', async () => {
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
  eq(second.status, 409, '已有活跃 turn 时应 409');
  // 收尾：拒绝权限让第一个 turn 跑完，再正常结束流
  await fetch(`${AGENT}/permission`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: head.find((e) => e.phase === 'confirmation_needed').requestId, decision: 'deny' }),
  });
  const tail = await drainAgentStream(stream);
  assert(tail.some((e) => e.type === 'turn_completed'), '拒绝后第一个 turn 应收尾');
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
