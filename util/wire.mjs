/**
 * 上游请求构造 + Anthropic Messages → OpenAI 帧翻译（协议适配薄封装）。
 * 消息序列转换在 llm/message.mjs，错误话术在 llm/errors.mjs；前端与 Agent Loop
 * 只认识 OpenAI 兼容形状（含 tool_calls），非兼容协议在此归一化。
 */
import { chatUrl, messagesUrl } from './providers.mjs';
import { toolSchemas, anthropicToolSchemas } from './agent/tools.mjs';
import { systemTextOf, toAnthropicTurns } from './llm/message.mjs';
import { toAnthropicTool } from './llm/tool.mjs';

/**
 * 连接期退避重试：仅网络层失败（fetch 抛 TypeError）且信号未中止时重试。
 * 与 /api/chat 历史语义一致：最多 attempts 次，间隔 500ms 递增。
 */
export async function fetchUpstream(wire, { signal, attempts = 3, onRetry } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(wire.url, { method: 'POST', headers: wire.headers, body: JSON.stringify(wire.body), signal });
    } catch (e) {
      if (attempt >= attempts - 1 || signal?.aborted || e.name !== 'TypeError') throw e;
      onRetry?.(attempt + 1, e);
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
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
  if (provider.protocol === 'anthropic') {
    const body = { model: opts.model, messages: toAnthropicTurns(opts.messages), stream: true, max_tokens: opts.maxTokens || 4096 };
    const system = systemTextOf(opts.messages);
    if (system) body.system = system;
    if (opts.temperature !== undefined && opts.temperature !== null) body.temperature = opts.temperature;
    if (Array.isArray(opts.toolNames) && opts.toolNames.length) {
      const tools = anthropicToolSchemas(opts.toolNames, opts.extraTools || []);
      if (tools.length) {
        body.tools = tools;
        if (opts.toolChoice) body.tool_choice = opts.toolChoice;
      }
    }
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
    return { url: messagesUrl(provider), headers, body };
  }
  const body = { model: opts.model, messages: opts.messages, stream: true };
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
    case 'message_start':
      return j.message?.usage ? { usage: { prompt_tokens: j.message.usage.input_tokens || 0, completion_tokens: j.message.usage.output_tokens || 0 } } : null;
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
