/**
 * 提示缓存续命（cache-warmer）：迁移 pi packages/coding-agent/src/core/cache-warmer.ts 的经济学判定。
 *
 * 背景：提示缓存有 TTL（Anthropic 以 5 分钟为主）。turn 结束后用户立刻发下一条，缓存还热，
 * 全价输入变命中价；闲置超过 TTL 后，下一轮要么重新付 cacheWrite（常比全价输入还贵）、
 * 要么全价。在上一个真实请求的缓存条目过期前，用「同前缀 + max_tokens:1」的廉价请求把它
 * 续上——只要省下的期望值大于续命成本就做（pi 同款判据）：
 *   warmCost = promptTokens × cacheRead 价 + 1 × output 价
 *   missCost = max(0, promptTokens × (cacheWrite 价 > 0 ? cacheWrite 价 : input 价) − promptTokens × cacheRead 价)
 *   expectedSavings = continuationProbability × missCost − warmCost ≥ 门槛才续
 * streaming 期 continuationProbability = 1（同一会话的下一轮大概率紧跟），闲置期打折
 * （IDLE_CONTINUATION_PROBABILITY，pi 实测口径）。
 *
 * 本地化差异：providers.json 单价只有 { input, output }，缓存价按 Anthropic 口径推导
 * （读 0.1×、写 1.25×）；提供方显式声明 price.cacheRead / price.cacheWrite 时从其说。
 */

/** 闲置期续命概率（turn 已结束，下一条真实请求不一定还来） */
export const IDLE_CONTINUATION_PROBABILITY = 0.15;
/** 默认缓存 TTL：Anthropic 5 分钟（OpenAI prompt_cache_key 一般更长，取保守值） */
export const DEFAULT_PROMPT_CACHE_TTL_MS = 5 * 60_000;

/** 90% TTL 处刷新，且至少留 10 秒余量；TTL 太短（≤10s）不续 */
export function getCacheWarmingDelayMs(ttlMs) {
  const ttl = Number(ttlMs);
  if (!Number.isFinite(ttl) || ttl <= 10_000) return undefined;
  return Math.max(1, Math.floor(Math.min(ttl * 0.9, ttl - 10_000)));
}

/**
 * 一次「续不续」的判定。prices 是每 1M token 单价 { input, output, cacheRead, cacheWrite }；
 * economicsAvailable=false（无 promptTokens 或无单价）时恒 stop——宁可不续，不要瞎花钱。
 */
export function evaluateWarmEconomics({ promptTokens = 0, prices, phase = 'idle', minExpectedSavings = 0.001 } = {}) {
  const p = {
    input: Number(prices?.input) || 0,
    output: Number(prices?.output) || 0,
    cacheRead: Number(prices?.cacheRead) || 0,
    cacheWrite: Number(prices?.cacheWrite) || 0,
  };
  const tokens = Math.max(0, Number(promptTokens) || 0);
  const cacheHitCost = (tokens * p.cacheRead) / 1_000_000;
  const missCost = Math.max(0, ((tokens * (p.cacheWrite > 0 ? p.cacheWrite : p.input)) / 1_000_000) - cacheHitCost);
  const warmCost = cacheHitCost + p.output / 1_000_000;
  const continuationProbability = phase === 'streaming' ? 1 : IDLE_CONTINUATION_PROBABILITY;
  const expectedSavings = continuationProbability * missCost - warmCost;
  const economicsAvailable = tokens > 0 && (p.cacheRead > 0 || p.input > 0 || p.output > 0);
  return {
    phase,
    warmCost,
    missCost,
    continuationProbability,
    expectedSavings,
    economicsAvailable,
    action: economicsAvailable && expectedSavings >= minExpectedSavings ? 'warm' : 'stop',
  };
}

/** 配置段解析（缺省关）：{ enabled, minExpectedSavings, ttlMs }，单叶容错 + 钳制 */
export const PROMPT_CACHE_WARM_DEFAULTS = { enabled: false, minExpectedSavings: 0.001, ttlMs: DEFAULT_PROMPT_CACHE_TTL_MS };
export function parsePromptCacheWarmConfig(v) {
  const o = (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  const min = Number(o.minExpectedSavings);
  const ttl = Number(o.ttlMs);
  return {
    enabled: o.enabled === true,
    minExpectedSavings: Number.isFinite(min) ? Math.min(Math.max(min, 0), 10) : PROMPT_CACHE_WARM_DEFAULTS.minExpectedSavings,
    ttlMs: Number.isFinite(ttl) ? Math.min(Math.max(Math.trunc(ttl), 15_000), 3_600_000) : PROMPT_CACHE_WARM_DEFAULTS.ttlMs,
  };
}
