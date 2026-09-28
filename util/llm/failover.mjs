/**
 * 多提供方故障转移（对应上游「自动轮换账号」的本地化）：连接期（流尚未打开、未向客户端
 * 发出任何字节）遇到可重试错误时，自动切换到提供同一模型的其它提供方重试，用户无感知。
 * 已开始转发字节后的失败不透明切换（客户端已收到部分内容），按既有行为传播。
 *
 * 本文件只放纯函数与配置解析；编排（何时切换、切换后如何 sticky 与记账）在
 * llm/provider.mjs（openChatStream）与调用方（loop.mjs / web.mjs）。
 * 不重试 400/401/402/403/404/422：那是配置 / 鉴权 / 计费问题，换路只会掩盖真实错误。
 */

/** 默认参数：最多 3 次尝试（首次 + 2 次转移），切换前退避 300ms×attempt */
export const FAILOVER_DEFAULTS = { enabled: true, maxAttempts: 3, backoffMs: 300 };
/** 尝试次数钳制范围（1 = 实质关闭转移，等价只打首家） */
export const FAILOVER_ATTEMPT_LIMITS = { min: 1, max: 5 };

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
 * 可故障转移判定：429 限流 / 408 超时 / 5xx 服务端错误 / 网络层失败。
 * 中止（AbortError）绝不转移——那是用户主动停止，不是上游故障。
 * @param err openChatStream 抛出的错误（带 kind / status）或 fetch 的 TypeError
 */
export function isFailoverable(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.kind === 'aborted') return false;
  const status = Number(err.status) || 0;
  if (status === 429 || status === 408) return true;
  if (status >= 500 && status <= 599) return true;
  if (err.kind === 'rate_limit' || err.kind === 'server' || err.kind === 'network') return true;
  return err.name === 'TypeError'; // fetch 网络层失败（未分类时）：换一家可能只是本地链路问题
}

/** 切换原因词（事件与文案共用，前端有中文映射）：rate_limit / server / network / timeout / unknown */
export function failoverReason(err) {
  if (!err) return 'unknown';
  if (err.kind === 'rate_limit' || err.kind === 'server' || err.kind === 'network') return err.kind;
  const status = Number(err.status) || 0;
  if (status === 429) return 'rate_limit';
  if (status === 408) return 'timeout';
  if (status >= 500 && status <= 599) return 'server';
  if (err.name === 'TypeError') return 'network';
  return 'unknown';
}

/**
 * 候选提供方挑选：与目标提供方不同、没试过、配了 Key、模型目录含目标模型。
 * 候选顺序即提供方顺序（内置在前）；tried 由调用方在同一次请求链内累积，保证不重复踩同一家。
 * @param all 提供方全量记录（含 apiKey 明文的内部形态）
 */
export function pickFailoverCandidate(all, { model, currentId, tried = [] }) {
  const exclude = new Set([String(currentId || ''), ...tried.map((t) => String(t || ''))]);
  const list = (Array.isArray(all) ? all : []).filter((p) => {
    if (!p || exclude.has(String(p.id || ''))) return false;
    if (!p.apiKey) return false; // 没有 Key 的提供方切换过去必然 401，跳过
    return Array.isArray(p.models) && p.models.some((m) => m && m.id === model);
  });
  return list[0] || null;
}

/** 第 attempt 次切换前的退避（毫秒）：线性递增，给限流方恢复的时间窗 */
export function failoverBackoffMs(attempt, backoffMs = FAILOVER_DEFAULTS.backoffMs) {
  const base = Number.isFinite(Number(backoffMs)) && Number(backoffMs) >= 0 ? Number(backoffMs) : FAILOVER_DEFAULTS.backoffMs;
  return base * Math.max(1, Number(attempt) || 1);
}

/**
 * 故障转移配置解析（单叶容错 + 钳制，与 goal / tui / proxy 段同纪律）：
 * providerFailover(boolean, 缺省开) + providerFailoverMaxAttempts(1..5, 缺省 3)。
 * env AURORAAGENT_FAILOVER / AURORAAGENT_FAILOVER_MAX_ATTEMPTS 优先于盘上配置。
 * @param saved 盘上配置原文（{ providerFailover, providerFailoverMaxAttempts }）
 * @param env   进程环境（保存配置时传 {} 以免把 env 覆盖值落盘）
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
  return { enabled, maxAttempts, backoffMs: FAILOVER_DEFAULTS.backoffMs };
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

/**
 * GET / POST /api/settings/failover（设置页「故障转移」面板，web.mjs 一行委派）。
 * 与 proxy / tui 面板同形态：读当前值；写时校验后经 saveConfig 落盘，下一轮请求即生效。
 * @returns {Promise<boolean>} true = 已处理（含 405），false = 路径不归本模块
 */
export async function handleFailoverApi(req, res, url, ctx) {
  const { loadConfig, saveConfig, log = () => {} } = ctx;
  if (url !== '/api/settings/failover') return false;

  if (req.method === 'GET') {
    const cfg = loadConfig();
    json(res, 200, { ok: true, providerFailover: cfg.providerFailover, providerFailoverMaxAttempts: cfg.providerFailoverMaxAttempts });
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
    const cfg = loadConfig();
    cfg.providerFailover = body.providerFailover !== undefined ? body.providerFailover : cfg.providerFailover;
    cfg.providerFailoverMaxAttempts = body.providerFailoverMaxAttempts !== undefined
      ? Number(body.providerFailoverMaxAttempts) : cfg.providerFailoverMaxAttempts;
    saveConfig(cfg);
    const saved = loadConfig();
    log('info', '故障转移设置已更新', { providerFailover: saved.providerFailover, providerFailoverMaxAttempts: saved.providerFailoverMaxAttempts });
    json(res, 200, { ok: true, providerFailover: saved.providerFailover, providerFailoverMaxAttempts: saved.providerFailoverMaxAttempts });
    return true;
  }

  json(res, 405, { ok: false, error: '仅支持 GET / POST' });
  return true;
}
