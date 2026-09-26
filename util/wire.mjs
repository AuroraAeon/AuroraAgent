/**
 * 上游请求构造 + Anthropic Messages → OpenAI 帧翻译。
 * 前端与 Agent Loop 只认识 OpenAI 兼容形状（含 tool_calls），非兼容协议在此归一化。
 */
import { chatUrl, messagesUrl } from './providers.mjs';
import { toolSchemas, anthropicToolSchemas } from './agent/tools.mjs';

/** 上游错误里的额度类措辞（用于 402 之外的启发式判断） */
export const QUOTA_WORDING = /\binsufficient[\s_-]+(?:quota|balance|credits?)\b|\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b|\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b|\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i;

/**
 * 上游错误的中文提示：内置提供方保留美团专属指引，自定义提供方指向设置页。
 * /api/chat 与 Agent Loop 共用，保证两条路径的错误话术一致。
 */
export function upstreamHint(provider, status, errText) {
  const builtin = Boolean(provider.builtin);
  const keyHint = builtin
    ? '请检查 modeltester.config.json 里的 apiKey，或访问 https://longcat.chat/platform/api_keys 重新获取'
    : `请到「设置 → 提供方」检查「${provider.name}」的 API 密钥，或到该厂商控制台重新获取`;
  const quotaHint = builtin
    ? '请到 https://longcat.chat/platform/ 充值，或抢购 Token 资源包（每日 10:00/16:00/21:00/23:00），或完成邀请任务领取奖励'
    : `请到「${provider.name}」对应的厂商控制台充值后重试`;
  if (status === 401) return `API Key 无效：${keyHint}`;
  if (status === 402) return `账号额度已用尽：${quotaHint}`;
  if (status === 429) return '请求过于频繁，请稍等几秒再发';
  if (QUOTA_WORDING.test(errText)) return `账号额度可能已用尽：${quotaHint}`;
  try { return JSON.parse(errText).error?.message || JSON.parse(errText).message || errText; } catch { return errText; }
}

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

/** 把 OpenAI 形状的消息序列翻成 Anthropic turns：assistant.tool_calls → tool_use 块，tool → tool_result 块 */
function toAnthropicTurns(messages) {
  const turns = [];
  let toolBatch = [];
  const flushTools = () => {
    if (toolBatch.length) { turns.push({ role: 'user', content: toolBatch }); toolBatch = []; }
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      // 连续的 tool 结果合并进同一条 user 消息（Anthropic 要求并行 tool_use 的 result 同消息）
      toolBatch.push({ type: 'tool_result', tool_use_id: m.tool_call_id, content: textOf(m.content) });
      continue;
    }
    flushTools();
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = [];
      if (textOf(m.content)) blocks.push({ type: 'text', text: textOf(m.content) });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      turns.push({ role: 'assistant', content: blocks });
      continue;
    }
    turns.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: toAnthropicContent(m.content) });
  }
  flushTools();
  return turns;
}

/**
 * 构造上游对话请求。
 * @param provider 提供方记录（含 protocol / baseUrl / apiKey）
 * @param opts { model, messages, sendThinking, thinkingOn, maxTokens, temperature, toolNames, toolChoice }
 */
export function buildChatRequest(provider, opts) {
  if (provider.protocol === 'anthropic') {
    const system = opts.messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).filter(Boolean).join('\n\n');
    const body = { model: opts.model, messages: toAnthropicTurns(opts.messages), stream: true, max_tokens: opts.maxTokens || 4096 };
    if (system) body.system = system;
    if (opts.temperature !== undefined && opts.temperature !== null) body.temperature = opts.temperature;
    if (Array.isArray(opts.toolNames) && opts.toolNames.length) {
      body.tools = anthropicToolSchemas(opts.toolNames);
      if (opts.toolChoice) body.tool_choice = opts.toolChoice;
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
    body.tools = toolSchemas(opts.toolNames);
    body.tool_choice = opts.toolChoice || 'auto';
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
