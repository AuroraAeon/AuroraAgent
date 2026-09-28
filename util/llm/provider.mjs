/**
 * LLM 抽象层：provider 无关的请求 + 流编排。/api/chat 与 Agent Loop 共用同一入口，
 * 两条路径的「构造请求 → 连接期重试 → 错误话术 → 帧翻译选择」行为因此一致。
 * 协议差异（URL / 请求形状 / 帧翻译）由 wire.mjs 承担，错误分类在 llm/errors.mjs，
 * 多提供方故障转移的判定与配置在 llm/failover.mjs。
 */
import { buildChatRequest, anthropicFrame, fetchUpstream } from '../wire.mjs';
import { classifyStatus, upstreamHint } from './errors.mjs';
import { isFailoverable, failoverReason, pickFailoverCandidate, failoverBackoffMs, FAILOVER_DEFAULTS, FAILOVER_ATTEMPT_LIMITS } from './failover.mjs';

/** 连接期重试的默认参数（与历史语义一致：仅网络层失败重试，500ms 递增） */
const RETRY_OPTS = { attempts: 3 };

/** 单次尝试：构造请求 → 连接期重试 → 非 2xx 抛带 kind / status 的 Error */
async function openOnce(provider, opts, io = {}) {
  const wire = buildChatRequest(provider, opts);
  const resp = await fetchUpstream(wire, {
    ...RETRY_OPTS, ...(io.retryAttempts !== undefined ? { attempts: io.retryAttempts } : {}),
    signal: io.signal, onRetry: io.onRetry,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const err = new Error(upstreamHint(provider, resp.status, errText));
    err.kind = classifyStatus(resp.status, errText);
    err.status = resp.status;
    throw err;
  }
  return {
    reader: resp.body.getReader(),
    translate: provider.protocol === 'anthropic' ? anthropicFrame : undefined,
  };
}

/**
 * 打开一条上游对话流（可带多提供方故障转移）。
 * @param provider 提供方记录（含 protocol / baseUrl / apiKey / builtin）
 * @param opts     buildChatRequest 的 opts（model / messages / toolNames / extraTools / gen 参数）
 * @param io       { signal, onRetry, retryAttempts,
 *                   failover: { enabled, maxAttempts, backoffMs, candidates(current) => Provider[], onSwitch({ from, to, reason, attempt }) } }
 * @returns {{ reader: ReadableStreamDefaultReader, translate: function|undefined }}
 *          上游非 2xx 时抛出带 kind / status 的 Error（message 即中文提示）；
 *          网络层失败原样抛出（kind=network），调用方按需兜底。
 *          故障转移只在「流尚未打开」时发生：已向客户端发出字节后失败不透明换路。
 */
export async function openChatStream(provider, opts, io = {}) {
  const fo = io.failover || {};
  const enabled = fo.enabled === true && typeof fo.candidates === 'function';
  const maxAttempts = Math.min(
    FAILOVER_ATTEMPT_LIMITS.max,
    Math.max(FAILOVER_ATTEMPT_LIMITS.min, Number(fo.maxAttempts) || FAILOVER_DEFAULTS.maxAttempts),
  );
  const tried = [];
  let current = provider;
  for (let attempt = 1; ; attempt++) {
    try {
      return await openOnce(current, opts, io);
    } catch (e) {
      // 未开启 / 次数用尽 / 不可转移 / 已中止：原样抛出，行为与本模块接入前一致
      if (!enabled || attempt >= maxAttempts || io.signal?.aborted || !isFailoverable(e)) throw e;
      const next = pickFailoverCandidate(fo.candidates(current), { model: opts.model, currentId: current.id, tried });
      if (!next) throw e; // 没有别的提供方能接这个模型：把最后一次真实错误抛给调用方
      const failed = current;
      tried.push(failed.id);
      current = next; // 先落切换再通知：观察者（记账 / 事件）看到的状态即后续请求生效的状态
      try { fo.onSwitch?.({ from: failed, to: current, reason: failoverReason(e), attempt, error: e }); } catch { /* 观察者异常不阻断换路 */ }
      const wait = failoverBackoffMs(attempt, fo.backoffMs);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
  }
}
