/**
 * 上游 SSE 透传 / 翻译。
 * abort 语义借鉴 dsh 的 cancellableStream：即使 read() 未立即拒绝，也能立刻跳出循环。
 */
import { SseParser } from './sse.mjs';

/** 建立「abort 即让 read() 赛跑失败」的Promise；返回 { race, dispose } */
function abortRaceFor(controller) {
  let rejectOnAbort;
  const race = new Promise((_, reject) => { rejectOnAbort = reject; });
  race.catch(() => {}); // 防止循环正常结束后才 abort 导致未处理的拒绝
  controller.signal.addEventListener('abort', () => {
    const reason = controller.signal.reason;
    rejectOnAbort(reason instanceof Error ? reason : new Error('已中止'));
  }, { once: true });
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
