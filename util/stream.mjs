/**
 * 上游 SSE 透传 / 翻译。
 * abort 语义借鉴 dsh 的 cancellableStream：即使 read() 未立即拒绝，也能立刻跳出循环。
 * 故障转移相关（移植 CC Switch 的 failover-safe success）：primeUpstreamStream 在还没向
 * 客户端写出任何字节前把「200 的错误 envelope」与「首包超时」变成可转移错误；空闲超时
 * 让上游挂着不吐字时也能尽快收尾。三者共用 isProductiveFrame 判定「是否已有产出」。
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

/** 供 Promise.race 用的「已中止」拒绝：与 abortRaceFor 同一语义，但不依赖 controller */
function abortedError(signal) {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : Object.assign(new Error('已中止'), { name: 'AbortError' });
}

/** 一帧超时错误：kind=timeout 让 llm/failover.mjs 判为可转移（换一家可能只是这家挂着） */
function timeoutError(ms, what) {
  const span = ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`;
  const e = new Error(`${what}超过 ${span}`);
  e.kind = 'timeout';
  e.name = 'TimeoutError';
  return e;
}

/** 起一个赛跑用定时器，返回 { promise, clear }。
 *  刻意不 unref：调用方在 finally 里必定 clear，定时器要么触发要么被清掉，不会拖住进程退出；
 *  unref 过的那版在事件循环只剩它自己时会被直接放弃，超时语义凭空消失（踩过，别再改回去） */
function raceTimer(ms, make) {
  let timer = null;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(make()), ms);
  });
  promise.catch(() => {}); // 赛跑获胜方不是它时，不当成未处理的拒绝
  return { promise, clear: () => clearTimeout(timer) };
}

/**
 * 上游帧是否算「已有产出」：文本 / 思考 / 工具调用 / 用量 / 终止原因任一出现即算。
 * 同时认识 OpenAI 帧与 Anthropic 原始事件——预读发生在帧翻译之前，拿到的还是原形状。
 */
export function isProductiveFrame(frame) {
  if (!frame || typeof frame !== 'object') return false;
  const choice = frame.choices?.[0];
  const delta = choice?.delta;
  if (delta && (delta.content || delta.reasoning_content || (Array.isArray(delta.tool_calls) && delta.tool_calls.length))) return true;
  if (frame.usage || choice?.finish_reason) return true;
  switch (frame.type) {
    case 'message_start': return Boolean(frame.message?.usage);
    case 'content_block_start': return frame.content_block?.type === 'tool_use';
    case 'content_block_delta': return Boolean(frame.delta?.text || frame.delta?.thinking || frame.delta?.partial_json);
    case 'message_delta': return true;
    default: return false;
  }
}

/** 把已读过的 chunk 按原序接到原 reader 前面，消费侧无感（接口仍是 reader） */
function replayReader(reader, buffered) {
  let index = 0;
  const stream = new ReadableStream({
    async pull(controller) {
      if (index < buffered.length) { controller.enqueue(buffered[index]); index += 1; return; }
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      controller.enqueue(value);
    },
    cancel(reason) { return Promise.resolve(reader.cancel(reason)).catch(() => {}); },
  });
  return stream.getReader();
}

/**
 * 读一帧：与中止赛跑；idleMs > 0 时再与空闲超时赛跑。
 * 超时错误 kind=timeout：首包阶段可转移，流已开始后由调用方按既有路径收尾。
 */
async function readNext(reader, abortRace, idleMs) {
  const readP = reader.read();
  readP.catch(() => {}); // 超时放弃后晚到的拒绝不当成未处理异常
  if (!idleMs || idleMs <= 0) return Promise.race([readP, abortRace]);
  const timer = raceTimer(idleMs, () => timeoutError(idleMs, '上游响应空闲'));
  try {
    return await Promise.race([readP, timer.promise, abortRace]);
  } finally {
    timer.clear();
  }
}

/**
 * 上游流「预读」（对齐 CC Switch prepare_success_response_for_failover：成功不能只看响应头）。
 * 缓冲到首个产出帧或语义失败帧为止：
 *   - 语义失败（200 的错误 envelope）在还没写出任何字节前抛出，调用方因此还能透明换路；
 *     若等响应转换器跑完再发现，客户端已经收到半个回答了，只能原样吐出去
 *   - 首包超时同样在连接期抛出，可转移
 *   - 流自然结束仍无产出：不误判，把残尾交给下游
 * @param reader 上游响应体 reader
 * @param opts { firstByteMs, detectFailure(frame)=>string|null, signal }
 * @returns Promise<ReadableStreamDefaultReader> 可重放 reader（缓冲 chunk 按原序在前）
 */
export async function primeUpstreamStream(reader, { firstByteMs = 0, detectFailure = null, signal = null } = {}) {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const buffered = [];
  let text = '';
  /** 检查一批事件：有产出返回 true（放行），语义失败直接抛 */
  const inspect = (events) => {
    for (const ev of events) {
      let frame = null;
      try { frame = JSON.parse(ev.data); } catch { continue; }
      if (isProductiveFrame(frame)) return true;
      if (!detectFailure) continue;
      const why = detectFailure(frame);
      if (why) {
        const e = new Error(why);
        e.kind = 'semantic';
        e.status = 502;
        throw e;
      }
    }
    return false;
  };
  /** 非 SSE 的 200 JSON 错误体：解析器产不出事件，按完整 JSON 判一次 */
  const inspectWholeBody = () => {
    if (!detectFailure) return;
    const trimmed = text.trim();
    if (!trimmed.startsWith('{')) return;
    try {
      const why = detectFailure(JSON.parse(trimmed));
      if (why) {
        const e = new Error(why);
        e.kind = 'semantic';
        e.status = 502;
        throw e;
      }
    } catch (e) {
      if (e?.kind === 'semantic') throw e; // JSON.parse 失败原样吞掉，只放行语义失败
    }
  };
  const timer = firstByteMs > 0 ? raceTimer(firstByteMs, () => timeoutError(firstByteMs, '上游响应首包')) : null;
  try {
    for (;;) {
      if (signal?.aborted) throw abortedError(signal);
      const readP = reader.read();
      readP.catch(() => {});
      const { done, value } = await Promise.race([readP, timer?.promise].filter(Boolean));
      if (done) { inspect(parser.end()); break; }
      const raw = decoder.decode(value, { stream: true });
      text += raw;
      buffered.push(value);
      if (inspect(parser.feed(raw))) break;
      inspectWholeBody();
    }
  } finally {
    timer?.clear();
  }
  return replayReader(reader, buffered);
}

/** 客户端消费不动（写缓冲满）时暂停上游读取，等 drain 或中止；中止即让外层循环收尾 */
function pauseForDrain(res, controller) {
  return new Promise((resolve) => {
    if (res.writableEnded || res.destroyed) return resolve();
    const finish = () => {
      res.removeListener('drain', finish);
      controller?.signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => finish();
    res.once('drain', finish);
    if (controller?.signal.aborted) return finish();
    controller?.signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** 归一化缓存命中字段：Anthropic 的 cache_read_input_tokens / OpenAI 的 prompt_tokens_details.cached_tokens 统一成 cachedTokens（写缓存的另计 cacheWriteTokens）。无缓存时原样返回，透传给前端的 usage 帧字节不变。 */
function withCacheFields(usage) {
  if (!usage || typeof usage !== 'object') return usage;
  const read = Number(usage.cachedTokens ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? 0);
  const write = Number(usage.cacheWriteTokens ?? usage.cache_creation_input_tokens ?? 0);
  if (!(read > 0) && !(write > 0)) return usage;
  return { ...usage, ...(read > 0 ? { cachedTokens: read } : {}), ...(write > 0 ? { cacheWriteTokens: write } : {}) };
}

/** 从 SSE 事件里提取 usage 记账（OpenAI 兼容帧形状） */
function harvest(events, entry) {
  for (const ev of events) {
    if (ev.data === '[DONE]') continue;
    try { const j = JSON.parse(ev.data); if (j.usage) entry.usage = withCacheFields(j.usage); } catch {}
  }
}

/** OpenAI 兼容：逐帧原样透传，同时顺手提取 usage */
export async function pumpSse(reader, res, entry, { idleMs = 0 } = {}) {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const abortRace = abortRaceFor(entry.controller);
  for (;;) {
    const { done, value } = await readNext(reader, abortRace, idleMs);
    if (done) break;
    if (!res.write(Buffer.from(value))) await pauseForDrain(res, entry.controller);
    harvest(parser.feed(decoder.decode(value, { stream: true })), entry);
  }
  harvest(parser.end(), entry);
  res.end();
}

/**
 * 非 OpenAI 兼容（Anthropic Messages）：把上游事件逐帧翻译成 OpenAI 形状再写给客户端，
 * 前端因此只需要认识一种帧格式。translate(ev) 返回 { chunk?, usage? }。
 */
export async function pumpTranslated(reader, res, entry, translate, { idleMs = 0 } = {}) {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const abortRace = abortRaceFor(entry.controller);
  const writeFrame = async (frame) => {
    if (!res.write(frame)) await pauseForDrain(res, entry.controller);
  };
  const emit = async (events) => {
    for (const ev of events) {
      const out = translate(ev);
      if (!out) continue;
      if (out.usage) entry.usage = { ...entry.usage, ...withCacheFields(out.usage) };
      if (out.chunk) await writeFrame(`data: ${JSON.stringify(out.chunk)}\n\n`);
    }
  };
  for (;;) {
    const { done, value } = await readNext(reader, abortRace, idleMs);
    if (done) break;
    await emit(parser.feed(decoder.decode(value, { stream: true })));
  }
  await emit(parser.end());
  // Anthropic 把用量拆在 message_start / message_delta 里，汇总后补一帧给前端与账本
  if (entry.usage && (entry.usage.prompt_tokens || entry.usage.completion_tokens)) {
    await writeFrame(`data: ${JSON.stringify({ choices: [], usage: entry.usage })}\n\n`);
  }
  await writeFrame('data: [DONE]\n\n');
  res.end();
}

/**
 * Agent 消费式 SSE 读取：把上游帧解成「文本 / 思考 / 工具调用 / 用量」四类事实交给 handlers，
 * 不写回客户端——由 Agent Loop 决定去向。与 pumpSse 的区别仅此一点。
 * @param reader 上游响应体 reader
 * @param entry  活跃流条目（提供 controller 与 usage 累积位）
 * @param handlers { onText, onThinking, onToolCallDelta, onToolCalls, onUsage }
 * @param opts { translate, idleMs } translate 传 anthropicFrame 时按 Anthropic 线路翻译；
 *           idleMs > 0 时上游空闲超时（kind=timeout），超时错误交由 Loop 收尾
 * @returns {{ toolCalls: Array, finishReason: string|null, usage: object|null }}
 */
export async function consumeAgentStream(reader, entry, handlers = {}, { translate, idleMs = 0 } = {}) {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const abortRace = abortRaceFor(entry.controller);
  const calls = new Map(); // index -> { id, name, args }
  const handleFrame = (j) => {
    if (!j || typeof j !== 'object') return;
    if (j.usage) { entry.usage = { ...entry.usage, ...withCacheFields(j.usage) }; handlers.onUsage?.(j.usage); }
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
    if (translate) {
      const out = translate(ev);
      // 翻译帧里的 usage（Anthropic 的 message_start / message_delta）必须落到 entry：
      // 早先只挑 chunk，导致 Anthropic 线路的 Agent 轮次用量恒为 null、账本记 0 token
      if (out?.usage) { entry.usage = { ...entry.usage, ...withCacheFields(out.usage) }; handlers.onUsage?.(out.usage); }
      if (out?.chunk) handleFrame(out.chunk);
      return;
    }
    try { handleFrame(JSON.parse(ev.data)); } catch {}
  };
  for (;;) {
    const { done, value } = await readNext(reader, abortRace, idleMs);
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
