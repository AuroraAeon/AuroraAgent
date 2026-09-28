/**
 * 多提供方故障转移（对应上游「自动轮换账号」的本地化）：连接期（流尚未打开、未向客户端
 * 发出任何字节）遇到可重试错误时，自动切换到提供同一模型的其它提供方重试，用户无感知。
 * 已开始转发字节后的失败不透明切换（客户端已收到部分内容），按既有行为传播。
 *
 * 能力面（移植 CC Switch proxy 层）：
 *   - 可转移判定 + 健康度隔离：客户端请求自身有问题的状态码换路只会掩盖真实错误，
 *     既不转移也不计入提供方健康度（llm/circuit.mjs 的熔断器据此判断）
 *   - 2xx 语义失败：HTTP 200 也可能是错误 envelope（中转网关常见），判定在语义层
 *   - 队列优先：用户编排的 failoverQueue 决定先后，队列为空或成员均不可用时回退隐式顺序
 *
 * 本文件只放纯函数与配置解析；编排（何时切换、切换后如何 sticky 与记账）在
 * llm/provider.mjs（openChatStream）与调用方（loop.mjs / web.mjs），
 * 熔断器在 llm/circuit.mjs，运行时状态落盘在 llm/failover-state.mjs。
 * 不重试 400/401/402/403/404/422：那是配置 / 鉴权 / 计费问题，换路只会掩盖真实错误。
 */
import { normalizeCircuitConfig } from './circuit.mjs';

/** 默认参数：最多 3 次尝试（首次 + 2 次转移），切换前退避 300ms×attempt */
export const FAILOVER_DEFAULTS = { enabled: true, maxAttempts: 3, backoffMs: 300 };
/** 尝试次数钳制范围（1 = 实质关闭转移，等价只打首家） */
export const FAILOVER_ATTEMPT_LIMITS = { min: 1, max: 5 };

/** 超时缺省值（对齐 CC Switch AppProxyConfig 现值）；0 = 禁用对应超时 */
export const FAILOVER_TIMEOUT_DEFAULTS = Object.freeze({ firstByteMs: 60_000, idleMs: 120_000, nonStreamMs: 600_000 });
/** 超时钳制范围（0..1 小时，0 即禁用） */
export const FAILOVER_TIMEOUT_LIMITS = Object.freeze({ min: 0, max: 3_600_000 });
/** 热切换偏好有效期缺省（小时）：超时回退默认顺序，避免永久钉在一家 */
export const PREF_TTL_DEFAULTS = { hours: 24 };
const PREF_TTL_LIMITS = { min: 1, max: 24 * 30 };

const FALSE_WORDS = new Set(['false', '0', 'off', 'no', 'disabled']);
const TRUE_WORDS = new Set(['true', '1', 'on', 'yes', 'enabled']);

/** 宽松布尔：坏值返回 fallback（是否告警由调用方决定） */
function boolOf(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  const s = String(raw).trim().toLowerCase();
  if (FALSE_WORDS.has(s)) return false;
  if (TRUE_WORDS.has(s)) return true;
  return fallback;
}

/** 宽松整数 + 钳制：坏值返回 fallback */
function clampInt(raw, fallback, min, max) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * 可故障转移判定：429 限流 / 408 超时 / 5xx 服务端错误 / 网络层失败 / 2xx 语义失败。
 * 中止（AbortError）绝不转移——那是用户主动停止，不是上游故障。
 * 熔断开闸（circuit_open）也不转移：候选同样开闸，转过去只会空转。
 * @param err openChatStream 抛出的错误（带 kind / status）或 fetch 的 TypeError
 */
export function isFailoverable(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.kind === 'aborted' || err.kind === 'circuit_open') return false;
  if (err.kind === 'semantic' || err.kind === 'timeout') return true;
  const status = Number(err.status) || 0;
  if (status === 429 || status === 408) return true;
  if (status >= 500 && status <= 599) return true;
  if (err.kind === 'rate_limit' || err.kind === 'server' || err.kind === 'network') return true;
  return err.name === 'TypeError'; // fetch 网络层失败（未分类时）：换一家可能只是本地链路问题
}

/**
 * 不计健康度的状态码（对齐 CC Switch categorize_proxy_error 的 NonRetryable 桶）：
 * 请求体格式 / 方法 / Content-Type / 载荷超限 / 上游协议确实不支持——换任何一家都会被拒，
 * 继续轮询只会放大错误率、污染熔断器、浪费配额。
 */
const HEALTH_SAFE_STATUS = new Set([400, 405, 406, 413, 414, 415, 422, 501]);

/**
 * 一次尝试的结果分类：是否换路 + 是否计入提供方健康度。
 * 两者不必相同：400 不换路也不计健康度；429 / 5xx / 语义失败两者都为真。
 * @returns {{ failoverable: boolean, countsHealth: boolean }}
 */
export function classifyOutcome(err) {
  if (!err) return { failoverable: false, countsHealth: false };
  if (err.name === 'AbortError' || err.kind === 'aborted' || err.kind === 'circuit_open') {
    return { failoverable: false, countsHealth: false };
  }
  const status = Number(err.status) || 0;
  if (HEALTH_SAFE_STATUS.has(status)) return { failoverable: false, countsHealth: false };
  const failoverable = isFailoverable(err);
  return { failoverable, countsHealth: failoverable };
}

/** 切换原因词（事件与文案共用，前端有中文映射）：
 *  rate_limit / server / network / timeout / semantic / circuit_open / unknown */
export function failoverReason(err) {
  if (!err) return 'unknown';
  if (err.kind === 'rate_limit' || err.kind === 'server' || err.kind === 'network') return err.kind;
  if (err.kind === 'semantic') return 'semantic';
  if (err.kind === 'timeout') return 'timeout';
  if (err.kind === 'circuit_open') return 'circuit_open';
  const status = Number(err.status) || 0;
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  if (status >= 500 && status <= 599) return 'server';
  if (err.name === 'TypeError') return 'network';
  return 'unknown';
}

/** 从错误体里取一句人话（字符串 / { message } / 其它） */
function messageOf(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'object') {
    const text = String(value.message || value.error || value.detail || '').trim();
    return text || JSON.stringify(value).slice(0, 200);
  }
  return String(value).trim();
}

/**
 * 2xx 语义失败判定（对齐 CC Switch 的 failover-safe success）：HTTP 200 不等于成功，
 * 中转网关常把错误包成 200 的 error envelope。只在「还没产出任何内容」时判定，
 * 因此判失败仍可透明换路（对齐 CC Switch：响应转换器跑得太晚，来不及换路）。
 * @param frame 上游 SSE 帧解析后的原始 JSON（翻译前）；也可传非流式的完整响应体
 * @returns 中文错误消息；不是语义失败返回 null
 */
export function semanticFailure(frame) {
  if (!frame || typeof frame !== 'object') return null;
  if (frame.error) return messageOf(frame.error) || '上游返回错误';
  if (frame.type === 'error') return messageOf(frame.error) || '上游返回错误';
  if (frame.type === 'response.failed' || frame.type === 'response.error') {
    return messageOf(frame.response?.error || frame.error) || '上游返回错误';
  }
  return null;
}

/**
 * 候选提供方挑选：与目标提供方不同、没试过、配了 Key、模型目录含目标模型、熔断未开闸。
 *
 * 队列语义：failoverQueue 非空时只取队列成员并按队列序（用户编排的优先级 P1 → Pn）；
 * 队列为空、或队列成员这次都不可用（无 Key / 不含目标模型 / 已熔断）时，回退既有隐式
 * 顺序（内置在前）。队列是全局顺序而非按模型分队列，按模型的过滤仍发生在这里——
 * 否则给一个模型建队列会让其它模型彻底失去转移能力。
 *
 * @param all 提供方全量记录（含 apiKey 明文的内部形态）
 * @param opts { model, currentId, tried, queue, available(id) }
 */
export function pickFailoverCandidate(all, { model, currentId, tried = [], queue = [], available = null } = {}) {
  const exclude = new Set([String(currentId || ''), ...tried.map((t) => String(t || ''))]);
  const order = new Map();
  if (Array.isArray(queue)) {
    queue.forEach((id, i) => { const key = String(id || ''); if (key && !order.has(key)) order.set(key, i); });
  }
  const list = (Array.isArray(all) ? all : []).filter((p) => {
    if (!p || exclude.has(String(p.id || ''))) return false;
    if (!p.apiKey) return false; // 没有 Key 的提供方切换过去必然 401，跳过
    if (!Array.isArray(p.models) || !p.models.some((m) => m && m.id === model)) return false;
    if (typeof available === 'function' && !available(p.id)) return false; // 熔断开闸，跳过
    return true;
  });
  if (order.size) {
    const queued = list.filter((p) => order.has(String(p.id)));
    if (queued.length) {
      queued.sort((a, b) => order.get(String(a.id)) - order.get(String(b.id)));
      return queued[0];
    }
  }
  return list[0] || null;
}

/** 第 attempt 次切换前的退避（毫秒）：线性递增，给限流方恢复的时间窗 */
export function failoverBackoffMs(attempt, backoffMs = FAILOVER_DEFAULTS.backoffMs) {
  const base = Number.isFinite(Number(backoffMs)) && Number(backoffMs) >= 0 ? Number(backoffMs) : FAILOVER_DEFAULTS.backoffMs;
  return base * Math.max(1, Number(attempt) || 1);
}

/**
 * 生效的超时值：故障转移关闭时全部归零（对齐 CC Switch——不转移就不做超时判定，
 * 避免关闭转移后行为漂移）。开启时按配置，0 = 禁用对应超时。
 * @param cfg parseFailoverConfig 的返回值
 */
export function effectiveTimeouts(cfg = {}) {
  const zero = { firstByteMs: 0, idleMs: 0, nonStreamMs: 0 };
  if (!cfg || cfg.enabled === false) return zero;
  return {
    firstByteMs: normalizeTimeoutMs(cfg.firstByteMs, FAILOVER_TIMEOUT_DEFAULTS.firstByteMs),
    idleMs: normalizeTimeoutMs(cfg.idleMs, FAILOVER_TIMEOUT_DEFAULTS.idleMs),
    nonStreamMs: normalizeTimeoutMs(cfg.nonStreamMs, FAILOVER_TIMEOUT_DEFAULTS.nonStreamMs),
  };
}

function normalizeTimeoutMs(raw, fallback) {
  return clampInt(raw, fallback, FAILOVER_TIMEOUT_LIMITS.min, FAILOVER_TIMEOUT_LIMITS.max);
}

/**
 * 故障转移配置解析（单叶容错 + 钳制，与 goal / tui / proxy 段同纪律）：
 * providerFailover(boolean, 缺省开) + providerFailoverMaxAttempts(1..5, 缺省 3)
 * + failover 段（超时三件套 / 熔断五项 / 偏好有效期）。
 * env AURORAAGENT_FAILOVER / AURORAAGENT_FAILOVER_MAX_ATTEMPTS 优先于盘上配置。
 * @param saved 盘上配置原文
 * @param env   进程环境（保存配置时传 {} 以免把 env 覆盖值落盘）
 * @returns {{ enabled, maxAttempts, backoffMs, firstByteMs, idleMs, nonStreamMs, circuit, prefTtlHours }}
 */
export function parseFailoverConfig(saved = {}, env = process.env, { warn } = {}) {
  const src = saved && typeof saved === 'object' ? saved : {};
  let enabled = boolOf(src.providerFailover, FAILOVER_DEFAULTS.enabled);
  if (typeof src.providerFailover !== 'boolean' && src.providerFailover !== undefined
    && src.providerFailover !== null && src.providerFailover !== '') {
    const s = String(src.providerFailover).trim().toLowerCase();
    if (!TRUE_WORDS.has(s) && !FALSE_WORDS.has(s) && warn) {
      warn('providerFailover 不是布尔值，已按缺省（开启）处理', { value: src.providerFailover });
    }
  }
  let maxAttempts = clampInt(src.providerFailoverMaxAttempts, FAILOVER_DEFAULTS.maxAttempts, FAILOVER_ATTEMPT_LIMITS.min, FAILOVER_ATTEMPT_LIMITS.max);
  if (src.providerFailoverMaxAttempts !== undefined && src.providerFailoverMaxAttempts !== null
    && src.providerFailoverMaxAttempts !== '' && !Number.isFinite(Number(src.providerFailoverMaxAttempts)) && warn) {
    warn('providerFailoverMaxAttempts 不是数字，已回退缺省 3', { value: src.providerFailoverMaxAttempts });
  }
  const envEnabled = env?.AURORAAGENT_FAILOVER;
  if (envEnabled !== undefined && envEnabled !== '') {
    const v = String(envEnabled).trim().toLowerCase();
    if (FALSE_WORDS.has(v)) enabled = false;
    else if (TRUE_WORDS.has(v)) enabled = true;
    else if (warn) warn('AURORAAGENT_FAILOVER 不是布尔值，已忽略', { value: envEnabled });
  }
  const envMax = env?.AURORAAGENT_FAILOVER_MAX_ATTEMPTS;
  if (envMax !== undefined && envMax !== '') {
    const n = Number(envMax);
    if (Number.isFinite(n)) maxAttempts = Math.min(FAILOVER_ATTEMPT_LIMITS.max, Math.max(FAILOVER_ATTEMPT_LIMITS.min, Math.round(n)));
    else if (warn) warn('AURORAAGENT_FAILOVER_MAX_ATTEMPTS 不是数字，已忽略', { value: envMax });
  }

  const fo = src.failover && typeof src.failover === 'object' ? src.failover : {};
  const firstByteMs = normalizeTimeoutMs(fo.firstByteMs, FAILOVER_TIMEOUT_DEFAULTS.firstByteMs);
  const idleMs = normalizeTimeoutMs(fo.idleMs, FAILOVER_TIMEOUT_DEFAULTS.idleMs);
  const nonStreamMs = normalizeTimeoutMs(fo.nonStreamMs, FAILOVER_TIMEOUT_DEFAULTS.nonStreamMs);
  for (const [key, value] of [['firstByteMs', firstByteMs], ['idleMs', idleMs], ['nonStreamMs', nonStreamMs]]) {
    if (fo[key] !== undefined && fo[key] !== null && fo[key] !== ''
      && (!Number.isFinite(Number(fo[key])) || Number(fo[key]) < FAILOVER_TIMEOUT_LIMITS.min || Number(fo[key]) > FAILOVER_TIMEOUT_LIMITS.max) && warn) {
      warn(`failover.${key} 超出 0..${FAILOVER_TIMEOUT_LIMITS.max}，已钳制`, { value });
    }
  }
  const circuit = normalizeCircuitConfig(fo.circuit);
  const prefTtlHours = clampInt(fo.prefTtlHours, PREF_TTL_DEFAULTS.hours, PREF_TTL_LIMITS.min, PREF_TTL_LIMITS.max);

  return {
    enabled, maxAttempts, backoffMs: FAILOVER_DEFAULTS.backoffMs,
    firstByteMs, idleMs, nonStreamMs, circuit, prefTtlHours,
  };
}

/** 把 failover 段从盘上配置里摘出来（保存配置时只动这一段，别把 env 覆盖值写进去） */
export function pickFailoverSection(cfg) {
  const src = cfg && typeof cfg === 'object' ? cfg.failover : null;
  return src && typeof src === 'object' ? { ...src } : {};
}

/**
 * failover 段落盘规整（单叶容错 + 钳制，与 parseGoalConfig / parseTuiConfig 同纪律）：
 * saveConfig 的白名单只认这一关过完的形状，人手改坏的字段在这里被钳回合法区间。
 */
export function parseFailoverSection(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of ['firstByteMs', 'idleMs', 'nonStreamMs']) {
    const n = Number(src[key]);
    if (Number.isFinite(n)) out[key] = clampInt(src[key], FAILOVER_TIMEOUT_DEFAULTS[key], FAILOVER_TIMEOUT_LIMITS.min, FAILOVER_TIMEOUT_LIMITS.max);
  }
  const hours = Number(src.prefTtlHours);
  if (Number.isFinite(hours)) out.prefTtlHours = clampInt(src.prefTtlHours, PREF_TTL_DEFAULTS.hours, PREF_TTL_LIMITS.min, PREF_TTL_LIMITS.max);
  if (src.circuit && typeof src.circuit === 'object') out.circuit = normalizeCircuitConfig(src.circuit);
  return out;
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); } });
  });
}

/** failover 段写入前的校验：三项超时 0..上限整数，熔断五项走 normalizeCircuitConfig 的钳制 */
function validateFailoverSection(body) {
  const out = {};
  const section = body.failover && typeof body.failover === 'object' ? body.failover : null;
  if (!section) return { ok: true, value: out };
  for (const key of ['firstByteMs', 'idleMs', 'nonStreamMs']) {
    if (section[key] === undefined) continue;
    const n = Number(section[key]);
    if (!Number.isInteger(n) || n < FAILOVER_TIMEOUT_LIMITS.min || n > FAILOVER_TIMEOUT_LIMITS.max) {
      return { ok: false, error: `failover.${key} 应为 ${FAILOVER_TIMEOUT_LIMITS.min} 到 ${FAILOVER_TIMEOUT_LIMITS.max} 的整数（0 = 禁用）` };
    }
    out[key] = n;
  }
  if (section.prefTtlHours !== undefined) {
    const n = Number(section.prefTtlHours);
    if (!Number.isInteger(n) || n < PREF_TTL_LIMITS.min || n > PREF_TTL_LIMITS.max) {
      return { ok: false, error: `failover.prefTtlHours 应为 ${PREF_TTL_LIMITS.min} 到 ${PREF_TTL_LIMITS.max} 的整数` };
    }
    out.prefTtlHours = n;
  }
  if (section.circuit !== undefined) {
    if (!section.circuit || typeof section.circuit !== 'object') return { ok: false, error: 'failover.circuit 应为对象' };
    const c = section.circuit;
    for (const key of ['failureThreshold', 'successThreshold', 'timeoutSeconds', 'minRequests']) {
      if (c[key] === undefined) continue;
      const n = Number(c[key]);
      if (!Number.isInteger(n) || n < 1 || n > 100000) return { ok: false, error: `failover.circuit.${key} 应为正整数` };
      out.circuit = { ...(out.circuit || {}), [key]: n };
    }
    if (c.errorRateThreshold !== undefined) {
      const n = Number(c.errorRateThreshold);
      if (!Number.isFinite(n) || n < 0.1 || n > 1) return { ok: false, error: 'failover.circuit.errorRateThreshold 应为 0.1 到 1 的小数' };
      out.circuit = { ...(out.circuit || {}), errorRateThreshold: n };
    }
  }
  return { ok: true, value: out };
}

/**
 * GET / POST /api/settings/failover（设置页「故障转移」面板，web.mjs 一行委派）。
 * POST /api/settings/failover/reset（手动恢复熔断器与热切换偏好）。
 * 与 proxy / tui 面板同形态：读当前值 + 健康视图；写时校验后经 saveConfig 落盘，下一轮请求即生效。
 * @param ctx { loadConfig, saveConfig, log, state(FailoverState), queue({ get }), healthIds(() => id[]) }
 *          healthIds 缺省回退队列成员；传全部提供方 ID 才能让设置页看到每家健康态
 * @returns {Promise<boolean>} true = 已处理（含 405），false = 路径不归本模块
 */
export async function handleFailoverApi(req, res, url, ctx) {
  const { loadConfig, saveConfig, log = () => {}, state = null, queue = null, healthIds = null } = ctx;
  const healthOf = () => (state ? state.circuits.health(healthIds?.() || queue?.get() || []) : []);

  if (url === '/api/settings/failover/reset') {
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '仅支持 POST' }); return true; }
    const body = await readBody(req, 8 * 1024);
    if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return true; }
    const providerId = body.providerId ? String(body.providerId) : '';
    state?.reset(providerId);
    log('info', '已重置故障转移状态', { providerId: providerId || '(全部)' });
    json(res, 200, { ok: true, health: healthOf() });
    return true;
  }

  if (url !== '/api/settings/failover') return false;

  if (req.method === 'GET') {
    const cfg = loadConfig();
    const parsed = parseFailoverConfig(cfg, {});
    json(res, 200, {
      ok: true,
      providerFailover: parsed.enabled,
      providerFailoverMaxAttempts: parsed.maxAttempts,
      failover: {
        firstByteMs: parsed.firstByteMs, idleMs: parsed.idleMs, nonStreamMs: parsed.nonStreamMs,
        circuit: parsed.circuit, prefTtlHours: parsed.prefTtlHours,
      },
      queue: queue?.get() || [],
      health: healthOf(),
    });
    return true;
  }

  if (req.method === 'POST') {
    const body = await readBody(req, 8 * 1024);
    if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return true; }
    if (body.providerFailover !== undefined && typeof body.providerFailover !== 'boolean') {
      json(res, 400, { ok: false, error: 'providerFailover 应为布尔值（true 开启 / false 关闭）' });
      return true;
    }
    if (body.providerFailoverMaxAttempts !== undefined) {
      const n = Number(body.providerFailoverMaxAttempts);
      if (!Number.isInteger(n) || n < FAILOVER_ATTEMPT_LIMITS.min || n > FAILOVER_ATTEMPT_LIMITS.max) {
        json(res, 400, { ok: false, error: `providerFailoverMaxAttempts 应为 ${FAILOVER_ATTEMPT_LIMITS.min} 到 ${FAILOVER_ATTEMPT_LIMITS.max} 的整数` });
        return true;
      }
    }
    const section = validateFailoverSection(body);
    if (!section.ok) { json(res, 400, { ok: false, error: section.error }); return true; }
    const cfg = loadConfig();
    cfg.providerFailover = body.providerFailover !== undefined ? body.providerFailover : cfg.providerFailover;
    cfg.providerFailoverMaxAttempts = body.providerFailoverMaxAttempts !== undefined
      ? Number(body.providerFailoverMaxAttempts) : cfg.providerFailoverMaxAttempts;
    if (Object.keys(section.value).length) {
      const merged = { ...pickFailoverSection(cfg), ...section.value };
      if (section.value.circuit) merged.circuit = { ...(pickFailoverSection(cfg).circuit || {}), ...section.value.circuit };
      cfg.failover = merged;
    }
    saveConfig(cfg);
    // 熔断配置热更新：不重置已有状态，只让新阈值立即参与后续判定
    const saved = parseFailoverConfig(loadConfig(), {});
    state?.circuits.updateConfig(saved.circuit);
    log('info', '故障转移设置已更新', { providerFailover: saved.enabled, providerFailoverMaxAttempts: saved.maxAttempts });
    json(res, 200, {
      ok: true,
      providerFailover: saved.enabled,
      providerFailoverMaxAttempts: saved.maxAttempts,
      failover: {
        firstByteMs: saved.firstByteMs, idleMs: saved.idleMs, nonStreamMs: saved.nonStreamMs,
        circuit: saved.circuit, prefTtlHours: saved.prefTtlHours,
      },
      queue: queue?.get() || [],
      health: healthOf(),
    });
    return true;
  }

  json(res, 405, { ok: false, error: '仅支持 GET / POST' });
  return true;
}
