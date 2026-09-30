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

/** 同提供方内重试的默认参数（连接期零产出时的韧性，对齐 Cline 的 retry 配置）：
 *  默认 3 次尝试（首次 + 2 次原地重试），退避 500ms 起指数增长、封顶 8s。
 *  仅「流尚未打开、未向调用方发出任何字节」且错误分类为限流 / 5xx / 网络层时重试——
 *  400 / 鉴权 / 计费类是请求自身的问题，重试只会放大错误（与 failover.mjs 的不转移判定同语义）。
 *  故障转移开启且仍能换路时不原地重试：换一家往往比在同一家退避等待更快（保持
 *  「每个 Provider 只尝试一次」的既有语义）；没有别家可接时才回落到原地重试。 */
export const RETRY_DEFAULTS = { attempts: 3, backoffMs: 500, maxBackoffMs: 8000 };
/** 原地重试次数钳制范围（1 = 关闭原地重试） */
export const RETRY_ATTEMPT_LIMITS = { min: 1, max: 5 };

/** 可原地重试判定：连接期零产出 + 限流 / 服务端 5xx / 网络层失败。
 *  中止（用户主动停止）与熔断开闸绝不重试；200 错误 envelope（semantic）留给换路判定。 */
export function retryableSameProvider(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.kind === 'aborted' || err.kind === 'circuit_open' || err.kind === 'semantic') return false;
  if (err.kind === 'rate_limit' || err.kind === 'server' || err.kind === 'network') return true;
  return err.name === 'TypeError'; // fetch 网络层失败（尚未分类时）
}

/** 第 n 次原地重试前的退避（n 从 1 起）：500ms → 1s → 2s → 4s → 封顶 8s */
function retryBackoffMs(n) {
  return Math.min(RETRY_DEFAULTS.backoffMs * 2 ** Math.max(0, n - 1), RETRY_DEFAULTS.maxBackoffMs);
}

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
    attempts: 1,
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
 * @param io       { signal, onRetry, retryAttempts（同提供方内重试次数，默认 3）, nonStreamMs,
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
  // 同提供方内重试预算：io.retryAttempts 可覆盖（goal evaluator 等场景传更小值）
  const retryAttempts = Math.min(
    RETRY_ATTEMPT_LIMITS.max,
    Math.max(RETRY_ATTEMPT_LIMITS.min, Number(io.retryAttempts) || RETRY_DEFAULTS.attempts),
  );
  const usedRetries = new Map(); // providerId -> 已用原地重试次数（换路后新提供方重新计数）
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
      const opened = await openOnce(current, opts, { ...io, attempts: 1 });
      circuit?.recordSuccess(current.id, permit.usedHalfOpenPermit);
      return opened;
    } catch (e) {
      settleCircuit(circuit, current.id, permit.usedHalfOpenPermit, e);
      const switchable = enabled && attempt < maxAttempts && !io.signal?.aborted && isFailoverable(e);
      const next = switchable ? pickFailoverCandidate(fo.candidates(current), {
        model: opts.model, currentId: current.id, tried, queue: fo.queue,
        available: (id) => circuit ? circuit.isAvailable(id) : null,
      }) : null;
      // 换不到别家（或未开启转移）且错误可原地重试：退避后重试同一家。
      // attempt 不递增——原地重试不消耗换路预算，两家机制互不挤占
      const spare = retryAttempts - 1 - (usedRetries.get(current.id) || 0);
      if (!next && spare > 0 && !io.signal?.aborted && retryableSameProvider(e)) {
        const n = (usedRetries.get(current.id) || 0) + 1;
        usedRetries.set(current.id, n);
        io.onRetry?.(n, e);
        const wait = retryBackoffMs(n);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      // 未开启 / 次数用尽 / 不可转移 / 已中止：原样抛出，行为与本模块接入前一致
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
