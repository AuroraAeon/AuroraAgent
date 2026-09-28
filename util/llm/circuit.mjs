/**
 * 熔断器（移植 CC Switch proxy/circuit_breaker.rs 的三态状态机，语义逐条对齐）：
 * 每个提供方一份、跨请求记忆健康度。没有它，一家持续 429 的提供方会在每个 turn 都
 * 被先撞一次才换路——既拖慢首字，又把配额摊给已知不健康的一家。
 *
 * 状态机：
 *   closed    正常放行；连续失败达 failure_threshold，或请求数达 min_requests 且
 *             错误率达 error_rate_threshold 时开闸
 *   open      拒绝一切请求；距开闸 timeout_seconds 后由 isAvailable / allowRequest
 *             翻到 half_open 并放行一次探测
 *   half_open 只放行一次探测（permit 机制防并发打挂）：成功累计 success_threshold
 *             次闭合，任一次失败立即重开
 *
 * 纪律：本文件只放纯状态机——无 fs、无日志、无进程态，时间源 now 可注入以便测试。
 * 落盘与 HTTP 面在 llm/failover-state.mjs，候选挑选与配置解析在 llm/failover.mjs。
 * 故障转移关闭时调用方根本不应查询熔断器（与 CC Switch 一致：不转移就不做健康判断）。
 */

/** 熔断缺省参数（对齐 CC Switch CircuitBreakerConfig::default） */
export const CIRCUIT_DEFAULTS = Object.freeze({
  failureThreshold: 4,
  successThreshold: 2,
  timeoutSeconds: 60,
  errorRateThreshold: 0.6,
  minRequests: 10,
});

/** 钳制范围：单叶容错，坏值回退缺省而不是抛错（配置是人手改的 JSON） */
export const CIRCUIT_LIMITS = Object.freeze({
  failureThreshold: { min: 1, max: 100 },
  successThreshold: { min: 1, max: 100 },
  timeoutSeconds: { min: 1, max: 86400 },
  minRequests: { min: 1, max: 100000 },
});
const ERROR_RATE_RANGE = { min: 0.1, max: 1 };

/** 半开状态最多放行的探测请求数（CC Switch 固定 1） */
const HALF_OPEN_PROBES = 1;

function clampInt(raw, fallback, min, max) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function clampFloat(raw, fallback, min, max) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 熔断配置解析：五项单叶容错 + 钳制，与 goal / tui / proxy 段同纪律 */
export function normalizeCircuitConfig(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    failureThreshold: clampInt(src.failureThreshold, CIRCUIT_DEFAULTS.failureThreshold, CIRCUIT_LIMITS.failureThreshold.min, CIRCUIT_LIMITS.failureThreshold.max),
    successThreshold: clampInt(src.successThreshold, CIRCUIT_DEFAULTS.successThreshold, CIRCUIT_LIMITS.successThreshold.min, CIRCUIT_LIMITS.successThreshold.max),
    timeoutSeconds: clampInt(src.timeoutSeconds, CIRCUIT_DEFAULTS.timeoutSeconds, CIRCUIT_LIMITS.timeoutSeconds.min, CIRCUIT_LIMITS.timeoutSeconds.max),
    errorRateThreshold: clampFloat(src.errorRateThreshold, CIRCUIT_DEFAULTS.errorRateThreshold, ERROR_RATE_RANGE.min, ERROR_RATE_RANGE.max),
    minRequests: clampInt(src.minRequests, CIRCUIT_DEFAULTS.minRequests, CIRCUIT_LIMITS.minRequests.min, CIRCUIT_LIMITS.minRequests.max),
  };
}

/** 单个提供方的熔断器。Node 单线程事件循环，计数器无需原子操作 */
export class CircuitBreaker {
  constructor(config = {}, now = () => Date.now()) {
    this.config = normalizeCircuitConfig(config);
    this.now = now;
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.totalRequests = 0;
    this.failedRequests = 0;
    this.openedAt = 0;
    this.halfOpenRequests = 0;
    this.lastError = '';
  }

  /** 路由阶段可用性判断：不占探测名额。open 且超时到达时顺带翻到 half_open */
  isAvailable() {
    if (this.state === 'open') this.#toHalfOpenIfTimedOut();
    return this.state !== 'open';
  }

  /**
   * 请求前取放行许可。调用方必须在结束后把 usedHalfOpenPermit 传回
   * recordSuccess / recordFailure / releasePermit，否则半开名额卡死。
   */
  allowRequest() {
    if (this.state === 'open') {
      this.#toHalfOpenIfTimedOut();
      if (this.state === 'open') return { allowed: false, usedHalfOpenPermit: false };
    }
    if (this.state !== 'half_open') return { allowed: true, usedHalfOpenPermit: false };
    if (this.halfOpenRequests >= HALF_OPEN_PROBES) return { allowed: false, usedHalfOpenPermit: false };
    this.halfOpenRequests += 1;
    return { allowed: true, usedHalfOpenPermit: true };
  }

  recordSuccess(usedHalfOpenPermit = false) {
    if (usedHalfOpenPermit) this.releasePermit();
    this.consecutiveFailures = 0;
    this.totalRequests += 1;
    if (this.state !== 'half_open') return;
    this.consecutiveSuccesses += 1;
    if (this.consecutiveSuccesses >= this.config.successThreshold) this.#toClosed();
  }

  recordFailure(usedHalfOpenPermit = false, message = '') {
    if (usedHalfOpenPermit) this.releasePermit();
    const was = this.state;
    this.consecutiveFailures += 1;
    this.totalRequests += 1;
    this.failedRequests += 1;
    this.consecutiveSuccesses = 0;
    if (message) this.lastError = String(message).slice(0, 200);
    if (was === 'half_open') { this.#toOpen(); return; }
    if (was !== 'closed') return;
    if (this.consecutiveFailures >= this.config.failureThreshold) { this.#toOpen(); return; }
    if (this.totalRequests >= this.config.minRequests
      && this.failedRequests / this.totalRequests >= this.config.errorRateThreshold) this.#toOpen();
  }

  /** 只释放半开名额，不动健康统计（结果不该算进这家健康度时用） */
  releasePermit() {
    if (this.halfOpenRequests > 0) this.halfOpenRequests -= 1;
  }

  /** 手动恢复（设置页「重置」入口） */
  reset() {
    this.#toClosed();
    this.lastError = '';
  }

  stats() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalRequests: this.totalRequests,
      failedRequests: this.failedRequests,
      errorRate: this.totalRequests ? this.failedRequests / this.totalRequests : 0,
      openedAt: this.openedAt,
      lastError: this.lastError,
      config: { ...this.config },
    };
  }

  /** 落盘快照（不含 config：配置以盘上配置为准，重启后热更新） */
  snapshot() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalRequests: this.totalRequests,
      failedRequests: this.failedRequests,
      openedAt: this.openedAt,
      halfOpenRequests: this.halfOpenRequests,
      lastError: this.lastError,
    };
  }

  /** 从快照恢复；坏形状静默忽略（保持 closed 空态） */
  restore(snap) {
    if (!snap || typeof snap !== 'object') return;
    const states = ['closed', 'open', 'half_open'];
    if (states.includes(snap.state)) this.state = snap.state;
    for (const key of ['consecutiveFailures', 'consecutiveSuccesses', 'totalRequests', 'failedRequests', 'halfOpenRequests']) {
      const n = Number(snap[key]);
      if (Number.isFinite(n) && n >= 0) this[key] = Math.round(n);
    }
    const openedAt = Number(snap.openedAt);
    if (Number.isFinite(openedAt) && openedAt >= 0) this.openedAt = openedAt;
    if (typeof snap.lastError === 'string') this.lastError = snap.lastError.slice(0, 200);
  }

  #toHalfOpenIfTimedOut() {
    if (this.state !== 'open') return;
    if (this.now() - this.openedAt < this.config.timeoutSeconds * 1000) return;
    this.state = 'half_open';
    this.consecutiveSuccesses = 0;
    this.halfOpenRequests = 0;
  }

  #toOpen() {
    this.state = 'open';
    this.openedAt = this.now();
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
  }

  #toClosed() {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.totalRequests = 0;
    this.failedRequests = 0;
    this.openedAt = 0;
    this.halfOpenRequests = 0;
  }
}

/**
 * 熔断器注册表：按 provider id 托管，跨请求 / 跨 turn 共享（进程内单例）。
 * 配置可热更新（updateConfig 不重置状态）；persist 回调在每次状态迁移后触发，
 * 由 FailoverState 做节流落盘，本模块不碰文件系统。
 */
export class CircuitRegistry {
  constructor({ config = {}, now = () => Date.now(), persist = null } = {}) {
    this.config = normalizeCircuitConfig(config);
    this.now = now;
    this.persist = persist;
    this.breakers = new Map();
  }

  get(providerId) {
    const key = String(providerId || '');
    let breaker = this.breakers.get(key);
    if (!breaker) {
      breaker = new CircuitBreaker(this.config, this.now);
      this.breakers.set(key, breaker);
    }
    return breaker;
  }

  isAvailable(providerId) { return this.get(providerId).isAvailable(); }

  allowRequest(providerId) { return this.get(providerId).allowRequest(); }

  recordSuccess(providerId, usedHalfOpenPermit = false) {
    this.get(providerId).recordSuccess(usedHalfOpenPermit);
    this.#changed();
  }

  recordFailure(providerId, usedHalfOpenPermit = false, message = '') {
    this.get(providerId).recordFailure(usedHalfOpenPermit, message);
    this.#changed();
  }

  /** 中性释放：结果不计健康度（不可转移错误 / 客户端中止），但名额要还回去 */
  releasePermit(providerId, usedHalfOpenPermit = false) {
    if (!usedHalfOpenPermit) return;
    this.get(providerId).releasePermit();
  }

  reset(providerId) {
    this.get(providerId).reset();
    this.#changed();
  }

  resetAll() {
    for (const breaker of this.breakers.values()) breaker.reset();
    this.#changed();
  }

  /** 设置页健康视图：按给定 id 顺序出列，不创建新熔断器（读路径无副作用） */
  health(providerIds = []) {
    return providerIds.map((id) => {
      const key = String(id || '');
      const breaker = this.breakers.get(key);
      return { providerId: key, ...(breaker ? breaker.stats() : new CircuitBreaker(this.config, this.now).stats()) };
    });
  }

  updateConfig(patch = {}) {
    this.config = normalizeCircuitConfig({ ...this.config, ...patch });
    for (const breaker of this.breakers.values()) breaker.config = { ...this.config };
  }

  snapshot() {
    const out = {};
    for (const [key, breaker] of this.breakers) out[key] = breaker.snapshot();
    return out;
  }

  restore(snap) {
    if (snap && typeof snap === 'object') {
      for (const [key, value] of Object.entries(snap)) {
        if (!value || typeof value !== 'object') continue;
        this.get(key).restore(value);
      }
    }
    return this;
  }

  #changed() {
    try { this.persist?.(); } catch { /* 落盘失败不影响换路决策 */ }
  }
}
