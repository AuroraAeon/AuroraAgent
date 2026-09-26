/**
 * 上游 SSE 透传：把上游响应体逐帧写给客户端，同时用 SseParser 顺手提取 usage 记账。
 * abort 语义借鉴 dsh 的 cancellableStream：即使 read() 未立即拒绝，也能立刻跳出循环。
 */
import { SseParser } from './sse.mjs';

/**
 * @param {ReadableStreamDefaultReader} reader 上游响应体 reader
 * @param {import('node:http').ServerResponse} res 客户端响应
 * @param {{ controller: AbortController, usage: object|null }} entry 活跃流登记项
 */
export async function pumpSse(reader, res, entry) {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let rejectOnAbort;
  const abortRace = new Promise((_, reject) => { rejectOnAbort = reject; });
  abortRace.catch(() => {}); // 防止循环正常结束后才 abort 导致未处理的拒绝
  entry.controller.signal.addEventListener('abort', () => {
    const reason = entry.controller.signal.reason;
    rejectOnAbort(reason instanceof Error ? reason : new Error('已中止'));
  }, { once: true });
  const harvest = (events) => {
    for (const ev of events) {
      if (ev.data === '[DONE]') continue;
      try { const j = JSON.parse(ev.data); if (j.usage) entry.usage = j.usage; } catch {}
    }
  };
  for (;;) {
    const { done, value } = await Promise.race([reader.read(), abortRace]);
    if (done) break;
    res.write(Buffer.from(value));
    harvest(parser.feed(decoder.decode(value, { stream: true })));
  }
  harvest(parser.end());
  res.end();
}
