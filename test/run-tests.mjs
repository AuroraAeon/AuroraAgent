/**
 * 测试套件（e2e 模式：真实 socket + mock 上游）。
 * 运行: npm test
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SseParser, estimateTokens } from '../util/sse.mjs';
import { startMock } from './mock-longcat.mjs';

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
