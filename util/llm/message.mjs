/**
 * LLM 消息抽象（provider 无关）：OpenAI 形状消息 ↔ Anthropic turns 的转换纯函数。
 * wire.mjs 与 Agent Loop 共用；Loop 内部只操作 OpenAI 形状（含 tool_calls），
 * 非兼容协议的差异全部收敛到本模块，上游行为不变。
 */
/** OpenAI 的 content 既可能是字符串，也可能是多模态片段数组 */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c && c.type === 'text' ? c.text : '')).filter(Boolean).join('\n');
}

/** 系统消息合并为 Anthropic 的 system 字符串（多段以空行相接） */
export function systemTextOf(messages) {
  return systemBlocksOf(messages).join('\n\n');
}

/**
 * 系统消息按顺序拆成块（wire.mjs 打提示缓存断点用）。
 * context.mjs 的约定：稳定段（harness 提示 / 工作目录 / 规则 / 技能清单）在前，
 * 易变尾（当前时间 / 本轮追加指令）在后——末块每轮都变，对它打断点会让整段缓存失效。
 */
export function systemBlocksOf(messages) {
  return (messages || []).filter((m) => m.role === 'system').map((m) => textOf(m.content)).filter(Boolean);
}

/** 稳定段文本（去掉末块易变尾）：派生确定性缓存键时用，同一会话各轮保持一致 */
export function stableSystemTextOf(messages) {
  const blocks = systemBlocksOf(messages);
  if (blocks.length < 2) return blocks[0] || '';
  return blocks.slice(0, -1).join('\n\n');
}

/** OpenAI 视觉片段 → Anthropic image block（data URL 拆成 media_type + base64） */
export function toAnthropicContent(content) {
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
export function toAnthropicTurns(messages) {
  const turns = [];
  let toolBatch = [];
  const flushTools = () => {
    if (toolBatch.length) { turns.push({ role: 'user', content: toolBatch }); toolBatch = []; }
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      // 连续的 tool 结果合并进同一条 user 消息（Anthropic 要求并行 tool_use 的 result 同消息）
      // content 可能是多模态片段（文本 + image_url data URL）：走 toAnthropicContent 翻成
      // tool_result 的 content 块数组，截图才能进 Anthropic 协议的上下文（textOf 会丢图片）
      toolBatch.push({ type: 'tool_result', tool_use_id: m.tool_call_id, content: toAnthropicContent(m.content) });
      continue;
    }
    flushTools();
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const blocks = [];
      const text = textOf(m.content);
      if (text) blocks.push({ type: 'text', text });
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
