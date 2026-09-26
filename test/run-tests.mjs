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
import { getTool, toolSchemas, anthropicToolSchemas, toolResource, resolveInside } from '../util/agent/tools.mjs';
import { PermissionPolicy, defaultRules, mostRestrictive } from '../util/agent/policy.mjs';
import { assembleMessages, needsCompaction, planCompaction, compactionMessages, contextWindowOf, estimateMessagesTokens } from '../util/agent/context.mjs';
import { runAgentTurn } from '../util/agent/loop.mjs';
import { UsageLedger } from '../util/usage.mjs';
import { runTuiToolkitTests } from './tui-toolkit.mjs';
import { runGuardTests } from './guards.mjs';
import { runLlmTests } from './llm.mjs';
import { runConfigTests } from './config.mjs';
import { runTuiComponentTests } from './tui-components.mjs';
import { runPickTests } from './pick.mjs';
import { runSkillsTests } from './skills.mjs';

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
await runConfigTests(test, assert, eq);
await runTuiComponentTests(test, assert, eq);
  await runPickTests(test, assert, eq);
  await runSkillsTests(test, assert, eq);
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
async function runLoopOnce({ framesByCall, harness = getHarness('standard'), permission = 'allow', seedRecords = [], providerExtra = {}, input = '开始' }) {
  const dir = mkdtempSync(join(tmpdir(), 'mt-loop-'));
  const ws = join(dir, 'workspace');
  mkdirSync(ws, { recursive: true });
  const store = new SessionStore(dir);
  const usage = new UsageLedger(dir);
  const session = store.create({ model: 'm1', harness: harness.id, workspace: ws });
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
    log: () => {},
  }).finally(() => { globalThis.fetch = realFetch; });
  return { dir, ws, store, usage, session, events, requests, result, permCalls };
}

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
  env: { ...process.env, AURORAAGENT_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, PORT: String(WEB_PORT), NO_OPEN: '1', AURORAAGENT_API_KEY: 'ak-test-key', LOG_LEVEL: 'error', AURORAAGENT_DATA_DIR: tmpDataDir },
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
