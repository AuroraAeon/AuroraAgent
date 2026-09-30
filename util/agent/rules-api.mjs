/**
 * 规则（用户指令层）的 HTTP 面：GET / POST /api/settings/rules。
 * 读 = 当前发现到的规则清单（来源 / 条件形态 / 是否激活 / 告警）+ toggle 表现值；
 * 写 = 整表替换 toggle（saveConfig 原子写）。与 util/tui/settings-api.mjs 同形态——
 * web.mjs 只保留一行委派。规则文件本身的编辑在文件系统里做，这里只管「开 / 关」。
 */
import { discoverRules, ruleActive, collectCandidatePaths } from './rules.mjs';

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

/** @returns {Promise<boolean>} true = 已处理（含 405），false = 路径不归本模块 */
export async function handleRulesApi(req, res, url, ctx) {
  const { loadConfig, saveConfig, workspace = '', dataDir = '', log = () => {} } = ctx;
  if (url !== '/api/settings/rules') return false;

  const shape = (cfg) => {
    const { rules, warnings } = discoverRules({ workspace, dataDir });
    const toggles = cfg.rules?.toggles || {};
    return {
      ok: true,
      toggles,
      warnings,
      rules: rules.map((r) => {
        const verdict = ruleActive(r, { paths: collectCandidatePaths({ input: '' }) });
        const off = Object.prototype.hasOwnProperty.call(toggles, r.name) && toggles[r.name] === false;
        return {
          name: r.name,
          description: r.description,
          source: r.source,
          path: r.path,
          pathsKind: r.pathsKind,
          paths: r.paths,
          always: r.always,
          lines: r.body.split('\n').length,
          conditional: verdict.active,
          reason: verdict.reason,
          enabled: !off,
        };
      }),
    };
  };

  if (req.method === 'GET') { json(res, 200, shape(loadConfig())); return true; }

  if (req.method === 'POST') {
    const body = await readBody(req, 64 * 1024);
    if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return true; }
    const raw = body.toggles;
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
      json(res, 400, { ok: false, error: 'toggles 应为 { 规则名: true|false } 形态的对象' }); return true;
    }
    const toggles = {};
    if (raw) for (const [k, v] of Object.entries(raw)) { if (typeof v === 'boolean') toggles[k] = v; }
    const cfg = loadConfig();
    cfg.rules = { toggles };
    saveConfig(cfg);
    log('info', '规则开关已更新', { count: Object.keys(toggles).length });
    json(res, 200, shape(cfg));
    return true;
  }

  json(res, 405, { ok: false, error: '仅支持 GET / POST' });
  return true;
}
