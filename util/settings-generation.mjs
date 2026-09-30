/**
 * 生成参数与 API Key 的 HTTP 面：GET/POST /api/settings/generation、GET/POST /api/settings/key。
 * 与 util/tui/settings-api.mjs、util/proxy.mjs 同形态——web.mjs 只留一行委派，本模块 ≤120 行。
 * 生成参数（temperature / maxTokens）是全局配置：改后下一轮模型请求即时生效（loop 每轮读
 * loadConfig()，不缓存）。网页斜杠命令 /temp /max /key 与设置页「通用」面板共用这两个路由。
 */
const TEMPERATURE_LIMITS = { min: 0, max: 1 };
const MAX_TOKENS_LIMITS = { min: 1, max: 1000000 };
const KEY_MAX_LENGTH = 200;
/** 提示缓存档位：auto（缺省）提供方声明支持即启用；off 一律不启用 */
const PROMPT_CACHE_MODES = ['auto', 'off'];

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

/** 温度归一：接受数字或数字字符串，越界 / 非有限值抛 Error（消息带可用区间） */
export function parseTemperature(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n) || n < TEMPERATURE_LIMITS.min || n > TEMPERATURE_LIMITS.max) {
    throw new Error(`temperature 应为 ${TEMPERATURE_LIMITS.min} 到 ${TEMPERATURE_LIMITS.max} 之间的数（当前 ${value}）`);
  }
  return n;
}

/** 单次最大输出归一：正整数，钳 1..1000000；越界 / 非整数抛 Error */
export function parseMaxTokens(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(n) || n < MAX_TOKENS_LIMITS.min || n > MAX_TOKENS_LIMITS.max) {
    throw new Error(`maxTokens 应为 ${MAX_TOKENS_LIMITS.min} 到 ${MAX_TOKENS_LIMITS.max} 的整数（当前 ${value}）`);
  }
  return n;
}

/** 提示缓存档位归一：auto / off，坏值抛 Error */
export function parsePromptCacheMode(value) {
  const mode = String(value ?? '').trim();
  if (!PROMPT_CACHE_MODES.includes(mode)) throw new Error(`promptCache 应为 auto 或 off（当前 ${value}）`);
  return mode;
}

/** API Key 归一：去空白后非空、无内部空白、不超长；否则抛 Error */
export function parseApiKey(value) {
  const key = String(value ?? '').trim();
  if (!key) throw new Error('apiKey 不能为空');
  if (key.length > KEY_MAX_LENGTH) throw new Error(`apiKey 过长（最多 ${KEY_MAX_LENGTH} 字符）`);
  if (/\s/.test(key)) throw new Error('apiKey 含空白字符：请确认没有换行或空格');
  return key;
}

/** @returns {Promise<boolean>} true = 已处理（含 405），false = 路径不归本模块 */
export async function handleGenerationApi(req, res, url, ctx) {
  const { loadConfig, saveConfig, log = () => {} } = ctx;

  if (url === '/api/settings/generation') {
    if (req.method === 'GET') {
      const cfg = loadConfig();
      json(res, 200, { ok: true, temperature: cfg.temperature, maxTokens: cfg.maxTokens, promptCache: cfg.promptCache });
      return true;
    }
    if (req.method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return true; }
      let temperature;
      let maxTokens;
      let promptCache;
      try {
        if (body.temperature !== undefined) temperature = parseTemperature(body.temperature);
        if (body.maxTokens !== undefined) maxTokens = parseMaxTokens(body.maxTokens);
        if (body.promptCache !== undefined) promptCache = parsePromptCacheMode(body.promptCache);
      } catch (e) { json(res, 400, { ok: false, error: e.message }); return true; }
      if (temperature === undefined && maxTokens === undefined && promptCache === undefined) {
        json(res, 400, { ok: false, error: '没有可更新的字段（temperature / maxTokens / promptCache）' });
        return true;
      }
      const cfg = loadConfig();
      if (temperature !== undefined) cfg.temperature = temperature;
      if (maxTokens !== undefined) cfg.maxTokens = maxTokens;
      if (promptCache !== undefined) cfg.promptCache = promptCache;
      saveConfig(cfg);
      log('info', '生成参数已更新', { temperature: cfg.temperature, maxTokens: cfg.maxTokens, promptCache: cfg.promptCache });
      json(res, 200, { ok: true, temperature: cfg.temperature, maxTokens: cfg.maxTokens, promptCache: cfg.promptCache });
      return true;
    }
    json(res, 405, { ok: false, error: '仅支持 GET / POST' });
    return true;
  }

  if (url === '/api/settings/key') {
    // GET 只回答「有没有 Key」，永不回传 Key 本身（设置页据此显示已保存 / 未设置）
    if (req.method === 'GET') {
      json(res, 200, { ok: true, hasKey: Boolean(loadConfig().apiKey) });
      return true;
    }
    if (req.method === 'POST') {
      const body = await readBody(req, 8 * 1024);
      if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return true; }
      let key;
      try { key = parseApiKey(body.apiKey); } catch (e) { json(res, 400, { ok: false, error: e.message }); return true; }
      const cfg = loadConfig();
      // 环境变量 Key 是临时覆盖：写盘会被 loadConfig 忽略，必须说清而不是假成功
      if (cfg.keyIsOverride) {
        json(res, 409, { ok: false, error: '当前 Key 由环境变量 AURORAAGENT_API_KEY 提供，写盘不生效；请改用环境变量或先取消该环境变量' });
        return true;
      }
      cfg.apiKey = key;
      cfg.keyIsOverride = false;
      saveConfig(cfg);
      log('info', 'API Key 已更新');
      json(res, 200, { ok: true, hasKey: true });
      return true;
    }
    json(res, 405, { ok: false, error: '仅支持 GET / POST' });
    return true;
  }

  return false;
}
