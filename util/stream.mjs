/**
 * 上游 SSE 透传 / 翻译。
 * abort 语义借鉴 dsh 的 cancellableStream：即使 read() 未立即拒绝，也能立刻跳出循环。
 */
import { SseParser } from './sse.mjs';
import { randomUUID } from 'node:crypto';

/** 建立「abort 即让 read() 赛跑失败」的Promise；返回 { race, dispose } */
function abortRaceFor(controller) {
  let rejectOnAbort;
  const race = new Promise((_, reject) => { rejectOnAbort = reject; });
  race.catch(() => {}); // 防止循环正常结束后才 abort 导致未处理的拒绝
  const onAbort = () => {
    const reason = controller.signal.reason;
    rejectOnAbort(reason instanceof Error ? reason : new Error('已中止'));
  };
  // 信号已中止时 addEventListener 不会再触发，必须立即拒绝，否则读取挂死
  if (controller.signal.aborted) onAbort();
  else controller.signal.addEventListener('abort', onAbort, { once: true });
  return race;
}

/** 从 SSE 事件里提取 usage 记账（OpenAI 兼容帧形状） */
function harvest(events, entry) {
  for (const ev of events) {
    if (ev.data === '[DONE]') continue;
    try { const j = JSON.parse(ev.data); if (j.usage) entry.usage = j.usage; } catch {}
  }
}

/** OpenAI 兼容：逐帧原样透传，同时顺手提取 usage */
export async function pumpSse(reader, res, entry) {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const abortRace = abortRaceFor(entry.controller);
  for (;;) {
    const { done, value } = await Promise.race([reader.read(), abortRace]);
    if (done) break;
    res.write(Buffer.from(value));
    harvest(parser.feed(decoder.decode(value, { stream: true })), entry);
  }
  harvest(parser.end(), entry);
  res.end();
}

/**
 * 非 OpenAI 兼容（Anthropic Messages）：把上游事件逐帧翻译成 OpenAI 形状再写给客户端，
 * 前端因此只需要认识一种帧格式。translate(ev) 返回 { chunk?, usage? }。
 */
export async function pumpTranslated(reader, res, entry, translate) {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const abortRace = abortRaceFor(entry.controller);
  const emit = (events) => {
    for (const ev of events) {
      const out = translate(ev);
      if (!out) continue;
      if (out.usage) entry.usage = { ...entry.usage, ...out.usage };
      if (out.chunk) res.write(`data: ${JSON.stringify(out.chunk)}\n\n`);
    }
  };
  for (;;) {
    const { done, value } = await Promise.race([reader.read(), abortRace]);
    if (done) break;
    emit(parser.feed(decoder.decode(value, { stream: true })));
  }
  emit(parser.end());
  // Anthropic 把用量拆在 message_start / message_delta 里，汇总后补一帧给前端与账本
  if (entry.usage && (entry.usage.prompt_tokens || entry.usage.completion_tokens)) {
    res.write(`data: ${JSON.stringify({ choices: [], usage: entry.usage })}\n\n`);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

/**
 * Agent 消费式 SSE 读取：把上游帧解成「文本 / 思考 / 工具调用 / 用量」四类事实交给 handlers，
 * 不写回客户端——由 Agent Loop 决定去向。与 pumpSse 的区别仅此一点。
 * @param reader 上游响应体 reader
 * @param entry  活跃流条目（提供 controller 与 usage 累积位）
 * @param handlers { onText, onThinking, onToolCallDelta, onToolCalls, onUsage }
 * @param opts { translate } 传 anthropicFrame 时按 Anthropic 线路翻译
 * @returns {{ toolCalls: Array, finishReason: string|null, usage: object|null }}
 */
export async function consumeAgentStream(reader, entry, handlers = {}, { translate } = {}) {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const abortRace = abortRaceFor(entry.controller);
  const calls = new Map(); // index -> { id, name, args }
  const handleFrame = (j) => {
    if (!j || typeof j !== 'object') return;
    if (j.usage) { entry.usage = { ...entry.usage, ...j.usage }; handlers.onUsage?.(j.usage); }
    const choice = j.choices?.[0];
    if (!choice) return;
    const d = choice.delta;
    if (!d) { if (choice.finish_reason) finishReason = choice.finish_reason; return; }
    if (d.reasoning_content) handlers.onThinking?.(d.reasoning_content);
    if (d.content) handlers.onText?.(d.content);
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const i = tc.index ?? 0;
        const cur = calls.get(i) || { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) { cur.args += tc.function.arguments; handlers.onToolCallDelta?.(i, cur); }
        calls.set(i, cur);
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  };
  let finishReason = null;
  const handleEvent = (ev) => {
    if (translate) { const out = translate(ev); if (out?.chunk) handleFrame(out.chunk); return; }
    try { handleFrame(JSON.parse(ev.data)); } catch {}
  };
  for (;;) {
    const { done, value } = await Promise.race([reader.read(), abortRace]);
    if (done) break;
    for (const ev of parser.feed(decoder.decode(value, { stream: true }))) handleEvent(ev);
  }
  for (const ev of parser.end()) handleEvent(ev);
  const toolCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => ({
    id: v.id || `call_${randomUUID().slice(0, 8)}`,
    name: v.name,
    arguments: v.args,
  }));
  handlers.onToolCalls?.(toolCalls, finishReason);
  return { toolCalls, finishReason, usage: entry.usage || null };
}
