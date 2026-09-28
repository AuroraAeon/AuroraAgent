/**
 * LLM 抽象层：provider 无关的请求 + 流编排。/api/chat 与 Agent Loop 共用同一入口，
 * 两条路径的「构造请求 → 连接期重试 → 错误话术 → 帧翻译选择」行为因此一致。
 * 协议差异（URL / 请求形状 / 帧翻译）由 wire.mjs 承担，错误分类在 llm/errors.mjs，
 * 多提供方故障转移的判定与配置在 llm/failover.mjs，熔断器在 llm/circuit.mjs。
 */
import { buildChatRequest, anthropicFrame, fetchUpstream } from '../wire.mjs';
import { classifyStatus, upstreamHint } from './errors.mjs';
import {
  isFailoverable, failoverReason, pickFailoverCandidate, failoverBackoffMs, classifyOutcome,
  FAILOVER_DEFAULTS, FAILOVER_ATTEMPT_LIMITS,
} from './failover.mjs';

/** 连接期重试的默认参数（与历史语义一致：仅网络层失败重试，500ms 递增）。
 *  故障转移开启时改为每提供方只试一次——同提供方重试 3 次再换路会把最坏耗时叠成 ~9s，
 *  而网络层抖动换一家往往更快（对齐 CC Switch：每个 Provider 只尝试一次） */
const RETRY_OPTS = { attempts: 3 };

/** 全部候选提供方都已熔断：不转移、不计健康度，直接告知用户 */
function circuitOpenError(provider) {
  const e = new Error(`提供方「${provider?.name || '当前'}」暂不可用（已熔断），请稍后重试，或在「设置 → 故障转移」里手动重置`);
  e.kind = 'circuit_open';
  e.status = 503;
  return e;
}

/** 按结果分类记熔断账：可转移错误记失败；不可转移错误只还探测名额，不污染健康度 */
function settleCircuit(circuit, providerId, permit, err) {
  if (!circuit) return;
  if (classifyOutcome(err).countsHealth) circuit.recordFailure(providerId, permit, err?.message || '');
  else circuit.releasePermit(providerId, permit);
}

/** 单次尝试：构造请求 → 连接期重试 → 非 2xx 抛带 kind / status 的 Error → 预读 */
async function openOnce(provider, opts, io = {}) {
  const wire = buildChatRequest(provider, opts);
  const resp = await fetchUpstream(wire, {
    attempts: io.attempts,
    signal: io.signal,
    timeoutMs: io.nonStreamMs,
    onRetry: io.onRetry,
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const err = new Error(upstreamHint(provider, resp.status, errText));
    err.kind = classifyStatus(resp.status, errText);
    err.status = resp.status;
    throw err;
  }
  const out = {
    reader: resp.body.getReader(),
    translate: provider.protocol === 'anthropic' ? anthropicFrame : undefined,
  };
  // 预读把「200 的错误 envelope」与「首包超时」变成连接期错误，从而仍可透明换路
  if (io.prime) out.reader = await io.prime(out.reader, out.translate, io.signal);
  return out;
}

/**
 * 打开一条上游对话流（可带多提供方故障转移）。
 * @param provider 提供方记录（含 protocol / baseUrl / apiKey / builtin）
 * @param opts     buildChatRequest 的 opts（model / messages / toolNames / extraTools / gen 参数）
 * @param io       { signal, onRetry, retryAttempts, nonStreamMs,
 *                   prime(reader, translate, signal) => reader,
 *                   circuit(CircuitRegistry),
 *                   failover: { enabled, maxAttempts, backoffMs, queue,
 *                               candidates(current) => Provider[], onSwitch({ from, to, reason, attempt, error }) } }
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
  // 关闭转移时不查熔断器：不转移就不做健康判断，行为与接入前完全一致
  const circuit = enabled ? (io.circuit || null) : null;
  const tried = [];
  let current = provider;
  for (let attempt = 1; ; attempt++) {
    const permit = circuit ? circuit.allowRequest(current.id) : { allowed: true, usedHalfOpenPermit: false };
    if (!permit.allowed) {
      // 这家已熔断：根本不发起请求（不是新失败，不计健康度），直接看下一家
      const next = pickFailoverCandidate(fo.candidates(current), {
        model: opts.model, currentId: current.id, tried, queue: fo.queue,
        available: (id) => circuit.isAvailable(id),
      });
      if (!next) throw circuitOpenError(current);
      const failed = current;
      tried.push(failed.id);
      current = next; // 先落切换再通知：观察者（记账 / 事件）看到的状态即后续请求生效的状态
      try {
        fo.onSwitch?.({ from: failed, to: current, reason: 'circuit_open', attempt, error: circuitOpenError(failed) });
      } catch { /* 观察者异常不阻断换路 */ }
      continue;
    }
    try {
      const opened = await openOnce(current, opts, {
        ...io,
        attempts: enabled ? 1 : (io.retryAttempts !== undefined ? io.retryAttempts : RETRY_OPTS.attempts),
      });
      circuit?.recordSuccess(current.id, permit.usedHalfOpenPermit);
      return opened;
    } catch (e) {
      settleCircuit(circuit, current.id, permit.usedHalfOpenPermit, e);
      // 未开启 / 次数用尽 / 不可转移 / 已中止：原样抛出，行为与本模块接入前一致
      if (!enabled || attempt >= maxAttempts || io.signal?.aborted || !isFailoverable(e)) throw e;
      const next = pickFailoverCandidate(fo.candidates(current), {
        model: opts.model, currentId: current.id, tried, queue: fo.queue,
        available: (id) => circuit ? circuit.isAvailable(id) : null,
      });
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
