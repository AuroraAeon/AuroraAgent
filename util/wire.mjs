/**
 * 上游请求构造 + Anthropic Messages → OpenAI 帧翻译。
 * 前端只认识 OpenAI 兼容的 SSE 帧，所以非兼容协议在此归一化，客户端零改动。
 */
import { chatUrl, messagesUrl } from './providers.mjs';

/** OpenAI 的 content 既可能是字符串，也可能是多模态片段数组 */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && c.type === 'text' ? c.text : '')).filter(Boolean).join('\n');
}

/** OpenAI 视觉片段 → Anthropic image block（data URL 拆成 media_type + base64） */
function toAnthropicContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const blocks = [];
  for (const part of content) {
    if (!part) continue;
    if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url' && part.image_url?.url) {
      const m = /^data:([^;]+);base64,(.*)$/s.exec(part.image_url.url);
      if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
      else blocks.push({ type: 'image', source: { type: 'url', url: part.image_url.url } });
    }
  }
  return blocks.length ? blocks : '';
}

/**
 * 构造上游对话请求。
 * @param provider 提供方记录（含 protocol / baseUrl / apiKey）
 * @param opts { model, messages, sendThinking, thinkingOn, maxTokens, temperature }
 */
export function buildChatRequest(provider, opts) {
  if (provider.protocol === 'anthropic') {
    const system = opts.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).filter(Boolean).join('\n\n');
    const turns = opts.messages.filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: toAnthropicContent(m.content) }));
    const body = { model: opts.model, messages: turns, stream: true, max_tokens: opts.maxTokens || 4096 };
    if (system) body.system = system;
    if (opts.temperature !== undefined && opts.temperature !== null) body.temperature = opts.temperature;
    const headers = { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
    return { url: messagesUrl(provider), headers, body };
  }
  const body = { model: opts.model, messages: opts.messages, stream: true };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;
  if (opts.temperature !== undefined && opts.temperature !== null) body.temperature = opts.temperature;
  if (opts.sendThinking) body.thinking = { type: opts.thinkingOn ? 'enabled' : 'disabled' };
  const headers = { 'Content-Type': 'application/json' };
  if (provider.apiKey) headers['Authorization'] = `Bearer ${provider.apiKey}`;
  return { url: chatUrl(provider), headers, body };
}

/**
 * Anthropic Messages 事件 → OpenAI 帧。
 * @returns {{ chunk?: object, usage?: object }|null}
 */
export function anthropicFrame(ev) {
  let j;
  try { j = JSON.parse(ev.data); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  switch (j.type) {
    case 'message_start':
      return j.message?.usage ? { usage: { prompt_tokens: j.message.usage.input_tokens || 0, completion_tokens: j.message.usage.output_tokens || 0 } } : null;
    case 'content_block_delta': {
      if (j.delta?.type === 'text_delta' && j.delta.text) return { chunk: { choices: [{ index: 0, delta: { content: j.delta.text } }] } };
      if (j.delta?.type === 'thinking_delta' && j.delta.thinking) return { chunk: { choices: [{ index: 0, delta: { reasoning_content: j.delta.thinking } }] } };
      return null;
    }
    case 'message_delta': {
      const out = j.usage?.output_tokens !== undefined ? { usage: { completion_tokens: j.usage.output_tokens } } : null;
      if (j.delta?.stop_reason) return { ...(out || {}), chunk: { choices: [{ index: 0, delta: {}, finish_reason: j.delta.stop_reason }] } };
      return out;
    }
    case 'error':
      // 上游错误在流中返回：转成一条可见的回答，用户不会面对空窗口
      return { chunk: { choices: [{ index: 0, delta: { content: `上游返回错误：${j.error?.message || JSON.stringify(j.error) || '未知错误'}` } }] } };
    default:
      return null;
  }
}
