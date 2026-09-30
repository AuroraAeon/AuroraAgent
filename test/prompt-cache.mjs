/**
 * 提示缓存单测（util/wire.mjs 的断点插桩 + util/stream.mjs 的用量归一）。
 * 三条不变式：
 *   1. 未声明支持 / 档位 off 时，请求字节与接入前逐字节一致（不支持的线路多发字段就是 400）；
 *   2. 声明支持时断点落在稳定段收尾、工具定义末项、会话尾部两处（合计不超上游 4 个上限）；
 *   3. OpenAI 的缓存键确定且跨轮稳定——时间戳在易变尾里，不进键。
 * 另覆盖 Anthropic cache_* 用量 → cachedTokens 的归一，以及 providers / catalog 的能力声明通路。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildChatRequest, promptCacheEnabled, promptCacheKey, anthropicFrame,
} from '../util/wire.mjs';
import { consumeAgentStream } from '../util/stream.mjs';
import { ProviderStore } from '../util/providers.mjs';
import { catalogPresetDraft } from '../util/provider-catalog.mjs';
import { loadConfig, saveConfig, parsePromptCache } from '../util/config.mjs';

const CACHE_PROVIDER = {
  id: 'p1', name: '支持缓存的提供方', protocol: 'anthropic',
  baseUrl: 'https://a.com/v1', apiKey: 'sk-ant',
  capacity: { supportsPromptCache: true },
};
const PLAIN_PROVIDER = {
  id: 'p2', name: '普通提供方', protocol: 'anthropic',
  baseUrl: 'https://a.com/v1', apiKey: 'sk-ant',
};

/** 造一段「稳定系统段 + 易变尾」的消息序列（context.mjs 的两条系统消息约定） */
function agentMessages(now = '2026-09-30T00:00:00.000Z') {
  return [
    { role: 'system', content: '你是助手\n\n工作目录：/tmp/ws\n文件工具只能访问工作目录内的路径。' },
    { role: 'system', content: `当前时间：${now}\n【本轮追加指令】先读 README` },
    { role: 'user', content: '读文件' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: '1  内容' },
    { role: 'user', content: '然后呢' },
  ];
}

function countBreakpoints(body) {
  let n = 0;
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v.cache_control) n++;
    Object.values(v).forEach(walk);
  };
  walk(body.system);
  walk(body.tools);
  walk(body.messages);
  return n;
}

export async function runPromptCacheTests(test, assert, eq) {
  console.log('\n提示缓存单测');

  await test('cache: 开关只认「提供方声明支持 + 档位非 off」', () => {
    eq(promptCacheEnabled(CACHE_PROVIDER, 'auto'), true, '声明支持且 auto 才启用');
    eq(promptCacheEnabled(CACHE_PROVIDER, 'off'), false, 'off 一律不启用');
    eq(promptCacheEnabled(PLAIN_PROVIDER, 'auto'), false, '未声明支持不启用');
    eq(promptCacheEnabled(PLAIN_PROVIDER, 'off'), false, '两个条件都不满足也不启用');
    eq(promptCacheEnabled({}, undefined), false, '空提供方不启用');
    eq(parsePromptCache(undefined), 'auto', '缺省 auto');
    eq(parsePromptCache('off'), 'off', 'off 保留');
    eq(parsePromptCache(' nonsense '), 'auto', '坏值回退缺省');
    eq(parsePromptCache(null), 'auto', 'null 回退缺省');
  });

  await test('cache: 未启用时 Anthropic 请求字节与接入前一致', () => {
    const plain = buildChatRequest(PLAIN_PROVIDER, { model: 'm', messages: agentMessages(), toolNames: ['read_file'] });
    eq(typeof plain.body.system, 'string', 'system 仍是字符串（历史形态）');
    eq(plain.body.system, '你是助手\n\n工作目录：/tmp/ws\n文件工具只能访问工作目录内的路径。\n\n当前时间：2026-09-30T00:00:00.000Z\n【本轮追加指令】先读 README');
    assert(!('prompt_cache_key' in plain.body), 'OpenAI 键不出现');
    eq(countBreakpoints(plain.body), 0, '一个断点都不插');
    const off = buildChatRequest(CACHE_PROVIDER, { model: 'm', messages: agentMessages(), promptCache: 'off' });
    eq(typeof off.body.system, 'string', 'off 时同样保持字符串');
    eq(countBreakpoints(off.body), 0, 'off 时不插断点');
  });

  await test('cache: Anthropic 断点落在稳定段收尾 / 工具末项 / 会话尾部两处', () => {
    const req = buildChatRequest(CACHE_PROVIDER, { model: 'm', messages: agentMessages(), toolNames: ['read_file', 'shell'] });
    const sys = req.body.system;
    assert(Array.isArray(sys), 'system 变成块数组');
    eq(sys.length, 2, '两块：稳定段 + 易变尾');
    assert(sys[0].cache_control, '稳定段收尾打断点');
    assert(!sys[1].cache_control, '易变尾不打断点（每轮都变，打断点等于每轮失效）');
    eq(sys[1].text.includes('当前时间'), true, '时间戳留在易变尾');
    assert(req.body.tools[req.body.tools.length - 1].cache_control, '末个工具打断点');
    assert(!req.body.tools[0].cache_control, '非末个工具不打断点');
    const turns = req.body.messages;
    const tagged = turns.map((t, i) => [i, t.role, Array.isArray(t.content) && t.content.some((b) => b.cache_control)]);
    eq(countBreakpoints(req.body), 4, '系统 1 + 工具 1 + 会话尾部 2 = 4（上游上限）');
    const lastTagged = turns[turns.length - 1];
    assert(Array.isArray(lastTagged.content) && lastTagged.content.some((b) => b.cache_control), '最后一条 turn 打断点');
    const asst = turns.filter((t) => t.role === 'assistant');
    assert(asst.length && asst[asst.length - 1].content.some((b) => b.cache_control), '最近一条 assistant turn 打断点');
    assert(tagged.length >= 4, '轮次足够多');
  });

  await test('cache: 单条系统消息时整块即稳定前缀', () => {
    const req = buildChatRequest(CACHE_PROVIDER, { model: 'm', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] });
    eq(req.body.system.length, 1, '一块');
    assert(req.body.system[0].cache_control, '唯一一块也打断点');
    eq(countBreakpoints(req.body), 2, '系统 1 + 会话尾部 1（无 assistant 轮可打）');
  });

  await test('cache: OpenAI 缓存键确定且跨轮稳定（时间戳不进键）', () => {
    const provider = { ...CACHE_PROVIDER, protocol: 'openai' };
    const a = buildChatRequest(provider, { model: 'm', messages: agentMessages('2026-09-30T00:00:00.000Z') });
    const b = buildChatRequest(provider, { model: 'm', messages: agentMessages('2026-09-30T00:00:07.000Z') });
    eq(typeof a.body.prompt_cache_key, 'string', '启用了才带缓存键');
    eq(a.body.prompt_cache_key, b.body.prompt_cache_key, '同会话不同轮次的键一致');
    eq(promptCacheKey(provider, { model: 'm', messages: agentMessages('x') }), promptCacheKey(provider, { model: 'm', messages: agentMessages('y') }), '纯函数：只认稳定段');
    const other = buildChatRequest({ ...provider, id: 'p9' }, { model: 'm', messages: agentMessages() });
    assert(other.body.prompt_cache_key !== a.body.prompt_cache_key, '换提供方键随之变化');
    const changed = buildChatRequest(provider, { model: 'm', messages: [{ role: 'system', content: '别的系统提示' }, { role: 'user', content: 'hi' }] });
    assert(changed.body.prompt_cache_key !== a.body.prompt_cache_key, '稳定段变了键也变');
    const plain = buildChatRequest({ ...provider, capacity: undefined }, { model: 'm', messages: agentMessages() });
    assert(!('prompt_cache_key' in plain.body), '未声明支持时不带键');
  });

  await test('cache: Anthropic cache 用量透出并经 consumeAgentStream 归一', async () => {
    const start = anthropicFrame({ data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 1200, cache_creation_input_tokens: 40 } } }) });
    eq(start.usage.prompt_tokens, 3, '输入 token 口径不变');
    eq(start.usage.cache_read_input_tokens, 1200, '缓存读穿出来');
    eq(start.usage.cache_creation_input_tokens, 40, '缓存写穿出来');
    const noCache = anthropicFrame({ data: JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0 } } }) });
    assert(!('cache_read_input_tokens' in noCache.usage), '无缓存时不出现额外字段（字节稳定）');

    const frames = [
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 900 } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 12 } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const entry = { controller: new AbortController(), usage: null };
    const out = await consumeAgentStream(new ReadableStream({
      start(c) { for (const f of frames) c.enqueue(new TextEncoder().encode(f)); c.close(); },
    }).getReader(), entry, {}, { translate: anthropicFrame });
    eq(out.usage.cachedTokens, 900, 'Anthropic cache_read 归一成 cachedTokens');
    eq(out.usage.completion_tokens, 12, '输出 token 仍在');

    const oaFrames = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 7 } } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const entry2 = { controller: new AbortController(), usage: null };
    const out2 = await consumeAgentStream(new ReadableStream({
      start(c) { for (const f of oaFrames) c.enqueue(new TextEncoder().encode(f)); c.close(); },
    }).getReader(), entry2, {});
    eq(out2.usage.cachedTokens, 7, 'OpenAI prompt_tokens_details 归一成 cachedTokens');

    const bare = { controller: new AbortController(), usage: null };
    const out3 = await consumeAgentStream(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\n`)); c.close(); },
    }).getReader(), bare, {});
    assert(!('cachedTokens' in out3.usage), '无缓存时 usage 不多出字段');
  });

  await test('cache: 能力声明经 providers 存储与目录预设落地', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-pc-'));
    try {
      const store = new ProviderStore(dir, {});
      const created = store.create({
        id: 'anthropic-like', name: '类 Anthropic', protocol: 'anthropic',
        baseUrl: 'https://x.com/v1', apiKey: 'sk-1', models: [{ id: 'm1' }],
        capacity: { supportsPromptCache: true },
      });
      eq(created.capacity?.supportsPromptCache, true, '创建时能力声明落库');
      const reloaded = new ProviderStore(dir, {});
      eq(reloaded.get('anthropic-like').capacity?.supportsPromptCache, true, '重载后仍在');
      eq(reloaded.list().find((p) => p.id === 'anthropic-like').capacity.supportsPromptCache, true, 'list 透出能力声明');
      // 更新时未带 capacity：保留原值（不被整体覆写抹掉）
      const updated = reloaded.update('anthropic-like', { name: '改了名' });
      eq(updated.capacity?.supportsPromptCache, true, '局部更新不抹掉能力声明');
      const cleared = reloaded.update('anthropic-like', { capacity: { supportsPromptCache: false } });
      eq(cleared.capacity?.supportsPromptCache, false, '显式传 false 可关掉');
      // 不传 capacity 的普通提供方：不带这个键
      reloaded.create({ id: 'plain-one', name: '普通', protocol: 'openai', baseUrl: 'https://y.com', apiKey: 'sk-2', models: [{ id: 'm1' }] });
      eq(reloaded.get('plain-one').capacity, undefined, '未声明即 undefined');

      const preset = catalogPresetDraft('deepseek', 'anthropic');
      assert(preset, 'Anthropic 端点能出预设');
      eq(preset.capacity?.supportsPromptCache, true, '目录里标了缓存的端点，预设带上能力声明');
      const oaPreset = catalogPresetDraft('deepseek', 'default');
      assert(oaPreset, 'OpenAI 端点能出预设');
      assert(!oaPreset.capacity, 'OpenAI 端点不带能力声明（保守：不认 prompt_cache_key 的线路会 400）');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('cache: 配置段经 loadConfig / saveConfig 往返', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-pc-cfg-'));
    const prev = process.env.AURORAAGENT_DATA_DIR;
    try {
      process.env.AURORAAGENT_DATA_DIR = dir;
      eq(loadConfig().promptCache, 'auto', '缺省 auto');
      const cfg = loadConfig();
      cfg.promptCache = 'off';
      saveConfig(cfg);
      eq(loadConfig().promptCache, 'off', 'off 落盘后读回');
      cfg.promptCache = 'bogus';
      saveConfig(cfg);
      eq(loadConfig().promptCache, 'auto', '坏值落盘时被归一成 auto');
      // 未感知该字段的调用方保存其它设置：promptCache 保留
      const other = loadConfig();
      other.promptCache = 'off';
      saveConfig(other);
      const again = loadConfig();
      again.temperature = 0.3;
      delete again.promptCache;
      saveConfig(again);
      eq(loadConfig().promptCache, 'off', '调用方未感知时保留盘上原值');
    } finally {
      if (prev === undefined) delete process.env.AURORAAGENT_DATA_DIR;
      else process.env.AURORAAGENT_DATA_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
