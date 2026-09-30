/**
 * 上游请求构造 + Anthropic Messages → OpenAI 帧翻译（协议适配薄封装）。
 * 消息序列转换在 llm/message.mjs，错误话术在 llm/errors.mjs；前端与 Agent Loop
 * 只认识 OpenAI 兼容形状（含 tool_calls），非兼容协议在此归一化。
 */
import { createHash } from 'node:crypto';
import { chatUrl, messagesUrl } from './providers.mjs';
import { toolSchemas, anthropicToolSchemas } from './agent/tools.mjs';
import { systemBlocksOf, stableSystemTextOf, toAnthropicTurns } from './llm/message.mjs';
import { toAnthropicTool } from './llm/tool.mjs';

/** 提示缓存开关：提供方声明支持（capacity.supportsPromptCache）且配置档位不是 off。两条都不满足时请求字节与接入前逐字节一致——不支持的线路多发一个字段就是 400，因此「未声明」一律按不支持处理，要开由用户在提供方编辑器里显式勾选。 */
export function promptCacheEnabled(provider, mode) {
  if (mode === 'off') return false;
  return provider?.capacity?.supportsPromptCache === true;
}

/** Anthropic 系统提示块：只在稳定段收尾打一个断点（上游上限 4 个，系统 / 工具 / 会话尾部各占一格） */
function cachedSystemBlocks(blocks) {
  const cut = blocks.length - 2;
  return blocks.map((text, i) => {
    const stable = blocks.length === 1 || i === cut;
    return stable
      ? { type: 'text', text, cache_control: { type: 'ephemeral' } }
      : { type: 'text', text };
  });
}

/** 给一条 turn 的最后一个内容块打缓存断点（字符串 content 先转成块数组） */
function tagTurn(turn) {
  if (!turn || typeof turn !== 'object') return;
  if (typeof turn.content === 'string') {
    if (!turn.content) return;
    turn.content = [{ type: 'text', text: turn.content }];
  }
  if (!Array.isArray(turn.content) || !turn.content.length) return;
  const last = turn.content[turn.content.length - 1];
  if (last && typeof last === 'object' && !last.cache_control) last.cache_control = { type: 'ephemeral' };
}

/** 会话尾部的两个断点：最后一条 turn + 它前面最近的 assistant turn（历史前缀的复用点） */
function tagConversationTail(turns) {
  if (!Array.isArray(turns) || !turns.length) return;
  tagTurn(turns[turns.length - 1]);
  for (let i = turns.length - 2; i >= 0; i--) {
    if (turns[i]?.role === 'assistant') { tagTurn(turns[i]); break; }
  }
}

/** OpenAI 兼容的提示缓存键：由「提供方 + 模型 + 稳定系统段」确定性派生——同输入同字节，同一会话各轮保持一致（时间戳在易变尾里，不进键），上游据此把同键请求路由到同一缓存分区。 */
export function promptCacheKey(provider, opts = {}) {
  const seed = `${provider?.id || provider?.name || ''}\n${opts.model || ''}\n${stableSystemTextOf(opts.messages)}`;
  return createHash('sha1').update(seed).digest('hex').slice(0, 32);
}

/**
 * 连接期退避重试：仅网络层失败（fetch 抛 TypeError）且信号未中止时重试。
 * 与 /api/chat 历史语义一致：最多 attempts 次，间隔 500ms 递增。
 */
export async function fetchUpstream(wire, { signal, attempts = 3, onRetry, timeoutMs = 0 } = {}) {
  // 连接期总时限（对应 CC Switch 的 non_streaming_timeout）：Node 内置 fetch 没有超时，
  // 上游挂着不返响应头时会一直挂住，用户面对一个永不结束的转圈。用派生 AbortController
  // 把时限叠到调用方 signal 上（不用 AbortSignal.any，保持 Node 18 可用）。
  const deadline = Number(timeoutMs) > 0 ? new AbortController() : null;
  const forward = () => deadline.abort(signal?.reason);
  let timer = null;
  if (deadline) {
    timer = setTimeout(() => {
      const e = new Error(`上游连接超过 ${Math.round(Number(timeoutMs) / 1000)}s 未返回`);
      e.kind = 'timeout';
      e.name = 'TimeoutError';
      deadline.abort(e);
    }, Number(timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();
    if (signal) {
      if (signal.aborted) forward();
      else signal.addEventListener('abort', forward, { once: true });
    }
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fetch(wire.url, { method: 'POST', headers: wire.headers, body: JSON.stringify(wire.body), signal: deadline ? deadline.signal : signal });
      } catch (e) {
        if (attempt >= attempts - 1 || signal?.aborted || e.name !== 'TypeError') throw e;
        onRetry?.(attempt + 1, e);
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
      }
    }
  } finally {
    if (timer) clearTimeout(timer);
    if (deadline && signal) signal.removeEventListener('abort', forward);
  }
}

/**
 * 构造上游对话请求。
 * @param provider 提供方记录（含 protocol / baseUrl / apiKey）
 * @param opts { model, messages, sendThinking, thinkingOn, maxTokens, temperature, toolNames, toolChoice, extraTools }
 * 注：extraTools 里 deferred 标记的工具不进请求顶层 tools[]（字节稳定以命中提示缓存），
 * 但 Loop 侧仍可解析执行（模型凭记忆或缓存发起调用时不会 400）。
 */
export function buildChatRequest(provider, opts) {
  // 提示缓存断点（provider.capacity.supportsPromptCache + 配置档位 auto）：未声明支持的线路
  // 完全不走这条路，请求字节与接入前逐字节一致
  const cache = promptCacheEnabled(provider, opts.promptCache);
  if (provider.protocol === 'anthropic') {
    const body = { model: opts.model, messages: toAnthropicTurns(opts.messages), stream: true, max_tokens: opts.maxTokens || 4096 };
    const blocks = systemBlocksOf(opts.messages);
    if (blocks.length) body.system = cache ? cachedSystemBlocks(blocks) : blocks.join('\n\n');
    if (opts.temperature !== undefined && opts.temperature !== null) body.temperature = opts.temperature;
    if (Array.isArray(opts.toolNames) && opts.toolNames.length) {
      const tools = anthropicToolSchemas(opts.toolNames, opts.extraTools || []);
      if (tools.length) {
        body.tools = tools;
        if (opts.toolChoice) body.tool_choice = opts.toolChoice;
        // 工具定义是每条请求都带的固定大头：末个工具打一个断点（与系统 / 会话尾部合计不超 4 个）
        if (cache) tools[tools.length - 1].cache_control = { type: 'ephemeral' };
      }
    }
    if (cache) tagConversationTail(body.messages);
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
    return { url: messagesUrl(provider), headers, body };
  }
  const body = { model: opts.model, messages: opts.messages, stream: true };
  // 上游声明支持时才带缓存键；不带的线路少一个字段就少一个 400 风险
  if (cache) body.prompt_cache_key = promptCacheKey(provider, opts);
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.temperature !== undefined && opts.temperature !== null) body.temperature = opts.temperature;
  if (opts.sendThinking) body.thinking = { type: opts.thinkingOn ? 'enabled' : 'disabled' };
  if (Array.isArray(opts.toolNames) && opts.toolNames.length) {
    const tools = toolSchemas(opts.toolNames, opts.extraTools || []);
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = opts.toolChoice || 'auto';
    }
  }
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  return { url: chatUrl(provider), headers, body };
}

/** Anthropic stop_reason → OpenAI finish_reason 词表 */
const FINISH_MAP = { tool_use: 'tool_calls', end_turn: 'stop', max_tokens: 'length', stop_sequence: 'stop' };

/**
 * Anthropic Messages 事件 → OpenAI 帧（含 tool_use / input_json_delta 的 tool_calls 翻译）。
 * @returns {{ chunk?: object, usage?: object }|null}
 */
export function anthropicFrame(ev) {
  let j;
  try { j = JSON.parse(ev.data); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  switch (j.type) {
    case 'message_start': {
      const u = j.message?.usage;
      if (!u) return null;
      const usage = { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0 };
      // 缓存用量只在真有命中 / 真有写入时透出：无缓存时字节与接入前一致（stream.mjs 再归一成 cachedTokens）
      if (u.cache_read_input_tokens) usage.cache_read_input_tokens = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens) usage.cache_creation_input_tokens = u.cache_creation_input_tokens;
      return { usage };
    }
    case 'content_block_start':
      if (j.content_block?.type === 'tool_use') {
        return { chunk: { choices: [{ index: 0, delta: { tool_calls: [{ index: j.index ?? 0, id: j.content_block.id, type: 'function', function: { name: j.content_block.name, arguments: '' } }] } }] } };
      }
      return null;
    case 'content_block_delta': {
      if (j.delta?.type === 'text_delta' && j.delta.text) return { chunk: { choices: [{ index: 0, delta: { content: j.delta.text } }] } };
      if (j.delta?.type === 'thinking_delta' && j.delta.thinking) return { chunk: { choices: [{ index: 0, delta: { reasoning_content: j.delta.thinking } }] } };
      if (j.delta?.type === 'input_json_delta' && j.delta.partial_json) {
        return { chunk: { choices: [{ index: 0, delta: { tool_calls: [{ index: j.index ?? 0, function: { arguments: j.delta.partial_json } }] } }] } };
      }
      return null;
    }
    case 'message_delta': {
      const out = j.usage?.output_tokens !== undefined ? { usage: { completion_tokens: j.usage.output_tokens } } : null;
      if (j.delta?.stop_reason) {
        const reason = FINISH_MAP[j.delta.stop_reason] || j.delta.stop_reason;
        return { ...(out || {}), chunk: { choices: [{ index: 0, delta: {}, finish_reason: reason }] } };
      }
      return out;
    }
    case 'error':
      // 上游错误在流中返回：转成一条可见的回答，用户不会面对空窗口
      return { chunk: { choices: [{ index: 0, delta: { content: `上游返回错误：${j.error?.message || JSON.stringify(j.error) || '未知错误'}` } }] } };
    default:
      return null;
  }
}
