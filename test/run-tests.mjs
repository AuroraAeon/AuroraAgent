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
import { startMock } from './mock-longcat.mjs';
import { ProviderStore, ProviderError, parseCapacity, formatCapacity, normalizeEndpoint, validateProviderDraft, chatUrl, modelsUrl, messagesUrl } from '../util/providers.mjs';
import { buildChatRequest, anthropicFrame } from '../util/wire.mjs';
import { agentEvent, sseFrame } from '../util/agent/events.mjs';
import { HARNESSES, getHarness, harnessSummaries, DEFAULT_HARNESS } from '../util/agent/harness.mjs';
import { SessionStore } from '../util/agent/session.mjs';
import { getTool, toolSchemas, anthropicToolSchemas, toolResource, resolveInside } from '../util/agent/tools.mjs';
import { PermissionPolicy, defaultRules, mostRestrictive } from '../util/agent/policy.mjs';

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
  eq(stop.chunk.choices[0].finish_reason, 'end_turn');
  const err = f({ type: 'error', error: { message: '过载' } });
  assert(err.chunk.choices[0].delta.content.includes('过载'), '错误事件应转成可见内容');
  eq(f({ type: 'ping' }), null);
  eq(f({ type: 'message_stop' }), null);
  eq(anthropicFrame({ data: 'not-json' }), null);
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

// ---------- e2e ----------
console.log('\n端到端测试（mock 上游 + 真实 socket）');
const mock = await startMock(MOCK_PORT);
const tmpPng = join(mkdtempSync(join(tmpdir(), 'lc-test-')), 'dot.png');
// 测试数据目录隔离：账本/配置只落临时目录，绝不写真实数据目录
const tmpDataDir = mkdtempSync(join(tmpdir(), 'lc-test-data-'));
writeFileSync(tmpPng, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAACCRR8pAAAAC0lEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'));

const child = spawn(process.execPath, ['web.mjs'], {
  cwd: join(__dirname, '..'),
  env: { ...process.env, MODELTESTER_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`, PORT: String(WEB_PORT), NO_OPEN: '1', MODELTESTER_API_KEY: 'ak-test-key', LOG_LEVEL: 'error', MODELTESTER_DATA_DIR: tmpDataDir },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1200));

try {
  await test('GET / 返回聊天页面', async () => {
    const r = await fetch(`${BASE}/`);
    eq(r.status, 200);
    const html = await r.text();
    assert(html.includes('ModelTester') && html.includes('id="send"'), '页面缺少关键元素');
    assert(html.includes('id="stopBtn"') && html.includes('id="stopBtnTop"'), '页面缺少停止按钮');
    assert(html.includes('class="cbar"') && html.includes('id="input"'), '页面缺少新版输入区（工具栏 + 输入框）');
    assert(html.includes('id="thinkToggle"') && html.includes('id="modelTrigger"'), '页面缺少思考开关或模型选择器');
    assert(html.includes('id="providersSec"') && html.includes('id="pvRows"'), '页面缺少提供方设置区');
    assert(html.includes('id="pvPickDlg"') && html.includes('id="pvDelDlg"'), '页面缺少提供方弹层');
    assert(html.includes('href="/providers.css"'), '页面未引用提供方样式');
    // 回归防护：模型菜单一旦回到 footer 内，footer 的 backdrop-filter 会变成 position:fixed 的包含块，把菜单拽出视口
    const fStart = html.indexOf('<footer>'), fEnd = html.indexOf('</footer>');
    assert(fStart > -1 && fEnd > fStart, '页面缺少 footer');
    assert(!html.slice(fStart, fEnd).includes('id="modelMenu"'), '模型菜单仍位于 footer 内（backdrop-filter 包含块会使其脱离视口）');
    assert(html.slice(fEnd).includes('id="modelMenu"'), '模型菜单未移到 footer 之后成为 body 直接子元素');
  });
  await test('提供方界面包含 dsh 对齐后的关键结构（容量折叠/aria 同步/弹层说明）', async () => {
    const js = await (await fetch(`${BASE}/providers.mjs`)).text();
    assert(js.includes('pv-mfold'), '模型行缺少「容量」disclosure');
    assert(js.includes('syncAria'), '缺少 :user-invalid 的 aria-invalid 同步');
    assert(js.includes('data-err'), '缺少字段错误标记（提交错误不应被 aria 同步清掉）');
    assert(js.includes('fetchBtn.disabled = urlInput'), '「获取可用模型」缺少无地址禁用逻辑');
    const html = await (await fetch(`${BASE}/`)).text();
    assert(html.includes('pv-pick-intro'), '挑选弹层缺少说明文案');
    assert(html.includes('id="pvDelTitle"'), '删除弹层缺少动态标题节点');
  });
  await test('GET /providers.css 与 /providers.mjs 提供静态资源', async () => {
    const css = await fetch(`${BASE}/providers.css`);
    eq(css.status, 200);
    eq(css.headers.get('content-type'), 'text/css');
    assert((await css.text()).includes('.pv-row'), '样式缺少提供方行');
    const js = await fetch(`${BASE}/providers.mjs`);
    eq(js.status, 200);
    const jsText = await js.text();
    assert(jsText.includes('mountProviders'), '模块缺少挂载入口');
    assert(jsText.includes('pvPriceIn') && jsText.includes('nwPriceOut'), '模块缺少计费单价字段');
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
