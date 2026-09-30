#!/usr/bin/env node
/**
 * AuroraAgent 网页服务（零依赖）· 当前接入：美团 LongCat-2.5-Preview
 * 用法: node web.mjs   →  http://localhost:8787
 * 特性: 断流即中止上游、用量账本、请求日志、健康检查
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, openSync, statSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { exec, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { UsageLedger } from './util/usage.mjs';
import { ErrorLog, createDeduper } from './util/errorlog.mjs';
import { checkUpdate } from './util/update.mjs';
import { SERVICE_LOG, servicePid, isManaged, autostartInstalled } from './util/service.mjs';
import { ProviderStore, ProviderError, handleProviderApi } from './util/providers.mjs';
import { pumpSse, pumpTranslated, primeUpstreamStream } from './util/stream.mjs';
import { openChatStream } from './util/llm/provider.mjs';
import { handleFailoverApi, parseFailoverConfig, effectiveTimeouts, semanticFailure } from './util/llm/failover.mjs';
import { FailoverState } from './util/llm/failover-state.mjs';
import { handleGenerationApi } from './util/settings-generation.mjs';
import { createAgentApi } from './util/agent/http.mjs';
import { handleTuiSettingsApi } from './util/tui/settings-api.mjs';
import { handleAgentProxyApi } from './util/proxy.mjs';
import { handleWorkspaceApi } from './util/workspace.mjs';
import { guardRequest } from './util/http-guard.mjs';
import { resolveDataDir, loadConfig, saveConfig, PRICE } from './util/config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 数据目录与配置统一走 util/config.mjs（env → 源码态 → App 态三级回退，含旧命名一次性迁移）
const DATA_DIR = resolveDataDir();
const usage = new UsageLedger(DATA_DIR, { warn: (m, e) => log('warn', m, e) });
const BASE = process.env.AURORAAGENT_BASE_URL || 'https://api.longcat.chat';
const PORT = Number(process.env.PORT || 8787);
const VERSION = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version; // 版本唯一来源
// 错误日志（<数据目录>/logs/errors.log，JSON Lines 环形保留）：前端崩溃与后端错误共用一份
const errorLog = new ErrorLog(DATA_DIR, { version: VERSION, warn: (m, e) => log('warn', m, e) });
// 上报去重：同 kind+message 30 秒内只记一条，崩溃循环不刷屏
const errorDeduper = createDeduper(30_000, 50);
// 故障转移运行时状态（<数据目录>/failover-state.json）：熔断快照 + 热切换偏好。
// 网页与终端各有一份进程内注册表，但读写同一份文件，两侧的健康记忆互为补充
const bootFo = parseFailoverConfig(loadConfig(), {});
const failoverState = new FailoverState(DATA_DIR, {
  warn: (m, e) => log('warn', m, e),
  config: { circuit: bootFo.circuit },
  prefTtlMs: bootFo.prefTtlHours * 3600_000,
}).load();
// 自定义 Provider 仓库：内置提供方（美团 LongCat）由 env/配置合成，自定义提供方落 providers.json
const providers = new ProviderStore(DATA_DIR, {
  name: '美团 LongCat',
  baseUrl: BASE,
  pathPrefix: '/openai/v1',
  apiKey: () => loadConfig().apiKey,
  model: () => loadConfig().model,
}, () => modelCatalog.models, {
  prefFor: (m) => failoverState.prefFor(m),
  failoverEnabled: () => loadConfig().providerFailover !== false,
});

// Agent 运行时 HTTP 面（/api/agent/* 与 /api/mcp/*）：实现拆在 util/agent/http.mjs，此处只按前缀委派
const agentApi = createAgentApi({
  dataDir: DATA_DIR,
  usage,
  resolveChatProvider,
  providerStore: providers,
  failoverState,
  loadConfig,
  pickModel: (raw, fallback) => (MODEL_RE.test(String(raw || '')) ? String(raw) : fallback),
  log: (level, msg, extra) => log(level, msg, extra),
  builtinPrice: PRICE,
});

/** 脱敏后的单个提供方（供保存后回显，形状与 /api/providers 列表一致） */
function redactProvider(p) {
  const row = providers.list().find((x) => x.id === p.id);
  if (row) return row;
  return { id: p.id, name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, builtin: Boolean(p.builtin), hasKey: Boolean(p.apiKey), model: p.model || '', models: p.models || [] };
}

/** 对话目标提供方：显式指定 > 按模型 ID 反查 > 内置（未知模型仍走内置，保持既有默认行为） */
function resolveChatProvider(wantId, model) {
  if (wantId) {
    const found = providers.get(String(wantId));
    if (found) return found;
  }
  return providers.providerForModel(model);
}

// ---------- 日志（LOG_LEVEL 模式） ----------
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = () => LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
function log(level, msg, extra) {
  if (LEVELS[level] < threshold()) return;
  const suffix = extra && Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}${suffix}`;
  if (level === 'error') console.error(line); else console.log(line);
}

// ---------- 模型目录（GET /api/models；结构借鉴 dsh ModelCatalog：共享目录 + 生命周期状态 + 单飞加载） ----------
const MODEL_TAGS = new Set(['preview', 'flash', 'lite', 'pro', 'thinking', 'chat', 'latest', 'exp']);
const MODEL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const MODEL_CACHE_MS = 60 * 1000;
const modelCatalog = { status: 'idle', models: [], error: null, at: 0 };
let modelCatalogInflight = null;

/** 把 API 模型 id 拆成可读名称 + 标签：LongCat-2.5-Preview -> "LongCat 2.5" + "Preview" */
function prettyModel(id) {
  const segs = String(id).split('-');
  const tags = [];
  while (segs.length > 1 && MODEL_TAGS.has(segs[segs.length - 1].toLowerCase())) tags.unshift(segs.pop());
  return { name: segs.join(' '), tag: tags.join(' · ') };
}

async function loadModelCatalog(force = false) {
  const fresh = Date.now() - modelCatalog.at < MODEL_CACHE_MS && modelCatalog.models.length > 0;
  if (!force && fresh) return modelCatalog;
  if (modelCatalogInflight) return modelCatalogInflight;
  const cfg = loadConfig();
  modelCatalogInflight = (async () => {
    modelCatalog.status = 'loading';
    modelCatalog.error = null;
    try {
      if (!cfg.apiKey) throw new Error('尚未配置 API Key');
      const r = await fetch(`${BASE}/openai/v1/models`, { headers: { 'Authorization': `Bearer ${cfg.apiKey}` } });
      if (!r.ok) throw new Error(`上游返回 ${r.status}`);
      const j = await r.json();
      const seen = new Set();
      modelCatalog.models = (Array.isArray(j.data) ? j.data : [])
        .map((m) => (m && typeof m.id === 'string' ? m.id.trim() : ''))
        .filter((id) => id && MODEL_RE.test(id))
        .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
        .map((id) => {
          const p = prettyModel(id);
          return { id, name: p.name, tag: p.tag, owned: id === cfg.model, provider: providers.builtin.id };
        });
      if (!modelCatalog.models.length) throw new Error('上游未返回可用模型');
      modelCatalog.status = 'ready';
      modelCatalog.at = Date.now();
      log('info', '模型目录已加载', { count: modelCatalog.models.length });
    } catch (e) {
      modelCatalog.status = 'error';
      modelCatalog.error = e.message || String(e);
      modelCatalog.models = [];
    } finally {
      modelCatalogInflight = null;
    }
    return modelCatalog;
  })();
  return modelCatalogInflight;
}

// ---------- 静态文件 ----------
const STATIC_ASSETS = {
  '/util/sse.mjs': join(__dirname, 'util', 'sse.mjs'),
};
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml; charset=utf-8', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
function serveStatic(res, filePath, { cache = 'no-store', req } = {}) {
  if (!existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  // ETag（size + mtimeMs 派生）+ Last-Modified：重复访问命中 If-None-Match 回 304，
  // 省掉整个产物的重复传输；SPA 外壳因此可以安全地走 no-cache（每次重验证）而非 no-store（每次全量下载）
  let etag = '';
  let lastModified = '';
  try {
    const st = statSync(filePath);
    etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    lastModified = new Date(st.mtimeMs).toUTCString();
  } catch { /* 取不到元数据就不做协商，按 200 全量发 */ }
  const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cache };
  if (etag) {
    headers.ETag = etag;
    headers['Last-Modified'] = lastModified;
    const inm = req?.headers['if-none-match'];
    const ims = req?.headers['if-modified-since'];
    const notModified = (inm && inm === etag) || (!inm && ims && ims === lastModified);
    if (notModified) { res.writeHead(304, headers); res.end(); return; }
  }
  res.writeHead(200, headers);
  res.end(readFileSync(filePath));
}

// ---------- 活跃流注册表（/api/abort 按 requestId 停止；设计借鉴 dsh 的 stream cancel 语义） ----------
const activeStreams = new Map(); // requestId -> { controller, started, usage, stopped, settled, model, provider, price }
function settleUsage(entry, ms) {
  entry.settled = true;
  const u = entry.usage;
  const inTok = u?.prompt_tokens || 0;
  const outTok = u?.completion_tokens || 0;
  // 自定义提供方可在记录里自带单价；只填一侧时另一侧回退内置价格，账本不记假账
  const own = entry.price || {};
  const price = {
    input: Number.isFinite(own.input) ? own.input : PRICE.input,
    output: Number.isFinite(own.output) ? own.output : PRICE.output,
  };
  const cost = (inTok * price.input + outTok * price.output) / 1_000_000;
  const rec = {
    requestId: entry.requestId, model: entry.model, provider: entry.provider, ms,
    inputTokens: inTok, outputTokens: outTok,
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens || 0,
    cost: Number(cost.toFixed(6)), stopped: entry.stopped,
  };
  usage.record(rec);
  return rec;
}
// ---------- 图片解析（本地路径 / URL → base64 data URL） ----------
async function resolveImage(p) {
  const path = String(p).replace(/^~(?=$|[\\/])/, homedir());
  if (/^https?:\/\//i.test(path)) {
    const ir = await fetch(path);
    if (!ir.ok) throw new Error('下载图片失败 HTTP ' + ir.status);
    const ct = (ir.headers.get('content-type') || 'image/png').split(';')[0];
    return 'data:' + ct + ';base64,' + Buffer.from(await ir.arrayBuffer()).toString('base64');
  }
  const buf = readFileSync(path);
  const ext = path.toLowerCase().split('.').pop();
  const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  return 'data:' + mime + ';base64,' + buf.toString('base64');
}

// ---------- 设置 / 开机自启（LaunchAgent 生命周期见 util/service.mjs） ----------
const INSTALLER = join(__dirname, 'tools', 'install-service.mjs');

// ---------- 服务 ----------
const server = createServer(async (req, res) => {
  const cfg = loadConfig();
  const url = req.url.split('?')[0];

  // 本地请求守卫（util/http-guard.mjs）：所有 /api/* 先过闸——Host 回环白名单 + Origin 同源 +
  // Sec-Fetch-Site 挡跨站提交，本机恶意页面借 DNS rebinding / 跨站 fetch 敲本地 HTTP 面在此被拒。
  // 静态产物（/app/* 等）不走 /api 前缀，天然不拦；GET /api/chat 豁免（无 GET 处理器，兼容探活）。
  // 拒绝走 errorlog 留痕（同因 30 秒去重，防恶意页面刷屏），403 话体固定 forbidden_origin
  if (url.startsWith('/api/') && !(req.method === 'GET' && url === '/api/chat')) {
    const denied = guardRequest(req, { port: PORT });
    if (denied) {
      if (errorDeduper.allow(`http_guard|${denied.body.reason}|${String(req.headers.host || '')}`)) {
        errorLog.record('http_guard', `拒绝请求 ${req.method} ${url}`, JSON.stringify({
          reason: denied.body.reason,
          host: String(req.headers.host || ''),
          origin: String(req.headers.origin || ''),
          site: String(req.headers['sec-fetch-site'] || ''),
          ua: String(req.headers['user-agent'] || '').slice(0, 120),
        }));
      }
      res.writeHead(denied.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(denied.body));
    }
  }

  // AuroraAgent 工作台（web-ui 构建产物，随仓库提交、运行时零构建）：/ 与 /app 同一份 index.html
  if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/app' || url.startsWith('/app/'))) {
    const base = join(__dirname, 'public', 'app');
    // rel 为空 = SPA 入口（/、/index.html、/app、/app/ 与无扩展名的深链）：必须回退 index.html 且 no-cache。
    // 曾把入口的 rel 写成 'index.html'，被扩展名正则误判成资产给了 immutable——开过根路径的浏览器
    // 会把旧 HTML 连旧哈希资产一起死缓存一年，发版后看到的永远是老版本（只能硬刷才好）。
    const rel = url.startsWith('/app/') ? url.slice('/app/'.length) : '';
    const target = resolve(base, rel);
    if (target !== base && !target.startsWith(base + sep)) { res.writeHead(403); res.end('forbidden'); return; }
    const isAsset = rel !== '' && /\.[a-z0-9]+$/i.test(rel);
    const file = isAsset ? target : join(base, 'index.html');
    if (isAsset && !existsSync(target)) { res.writeHead(404); res.end('not found'); return; }
    return serveStatic(res, file, { cache: isAsset ? 'public, max-age=31536000, immutable' : 'no-cache', req });
  }
  // 前端模块与样式：白名单映射（而非目录通配），任意路径都不 serveStatic 出去
  const asset = STATIC_ASSETS[url];
  if (req.method === 'GET' && asset) return serveStatic(res, asset, { req });
  if (req.method === 'GET' && url === '/icon.svg') return serveStatic(res, join(__dirname, 'public', 'icon.svg'), { req });
  // 厂商标识：/vendor/<name>.svg（正则白名单防目录穿越），接入新厂商把 svg 放进 public/vendors/ 即可
  if (req.method === 'GET' && /^\/vendor\/[a-z0-9-]+\.svg$/.test(url)) {
    return serveStatic(res, join(__dirname, 'public', 'vendors', url.slice('/vendor/'.length)), { req });
  }
  // computer_use 截图：/api/shots/<会话 id>/<文件>.png|.jpg——正则白名单 + 目录禁锢双重防穿越，
  // 只 serve <数据目录>/shots/ 之内的文件（工具卡缩略图与点击放大用）
  const shotMatch = /^\/api\/shots\/([0-9a-f-]{36})\/([0-9a-zA-Z._-]+\.(?:png|jpg|jpeg))$/.exec(url);
  if (req.method === 'GET' && shotMatch) {
    const base = join(DATA_DIR, 'shots');
    const target = join(base, shotMatch[1], shotMatch[2]);
    if (target !== base && !target.startsWith(base + sep)) { res.writeHead(403); res.end('forbidden'); return; }
    return serveStatic(res, target, { req, cache: 'private, max-age=300' });
  }
  if (req.method === 'GET' && url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ hasKey: Boolean(cfg.apiKey), model: cfg.model }));
  }
  if (req.method === 'GET' && url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, model: cfg.model, hasKey: Boolean(cfg.apiKey), ts: Date.now() }));
  }
  if (req.method === 'GET' && url === '/api/usage') {
    // 面板默认要统计视图（近 30 天走势 + 构成）；?lite=1 只取汇总与最近记录（省一次全文扫描）
    const body = usage.summary();
    if (!new URL(req.url, 'http://localhost').searchParams.has('lite')) {
      body.stats = usage.stats({ days: 30 });
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(body));
  }

  // 错误日志（/api/logs/errors，实现见 util/errorlog.mjs）：前端全局捕获上报 + 设置页查看 / 清空
  if (url === '/api/logs/errors') { // url 已剥离查询串，limit 从 req.url 里取
    if (req.method === 'GET') {
      const limit = Number(new URL(req.url, 'http://localhost').searchParams.get('limit') || 50);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, entries: errorLog.list(limit), total: errorLog.count() }));
    }
    if (req.method === 'DELETE') {
      const cleared = errorLog.clear();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, cleared }));
    }
    if (req.method === 'POST') {
      let raw = '';
      req.on('data', (d) => { raw += d; if (raw.length > 32 * 1024) req.destroy(); });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw || '{}'); } catch {}
        const kind = String(body.kind || 'backend').slice(0, 40);
        const message = String(body.message || '').trim();
        const detail = typeof body.detail === 'string' ? body.detail : '';
        if (!message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: false, error: 'message 不能为空' }));
        }
        // 去重后再落盘：同一处相同错误 30 秒内只记一条
        if (!errorDeduper.allow(`${kind}|${message.slice(0, 200)}`)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, deduped: true }));
        }
        errorLog.record(kind, message, detail);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
  }

  if (req.method === 'GET' && url === '/api/models') {
    const cat = await loadModelCatalog(req.url.includes('force=1'));
    // 自定义提供方的模型目录就在本地，无需等上游；内置目录失败时它们仍可选用
    const extra = providers.list().filter((p) => !p.builtin)
      .flatMap((p) => p.models.map((m) => ({ ...m, provider: p.id })));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: cat.status === 'ready',
      status: cat.status,
      default: cfg.model,
      models: [...cat.models, ...extra],
      providers: providers.list(),
      error: cat.error,
    }));
  }

  // 自定义 Provider（/api/providers*，实现见 util/providers.mjs 的 handleProviderApi）
  if (url.startsWith('/api/providers')) {
    if (await handleProviderApi(req, res, url, { store: providers, log })) return;
  }

  if (req.method === 'GET' && url === '/api/settings') {
    const pid = servicePid();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      version: VERSION,
      autostart: autostartInstalled(),
      managed: pid === process.pid,
      serviceRunning: pid > 0,
      servicePid: pid || null,
      port: PORT,
      dataDir: DATA_DIR,
    }));
  }

  if (req.method === 'POST' && url === '/api/settings') {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 64 * 1024) req.destroy(); });
    req.on('end', () => {
      let want = null;
      try { want = JSON.parse(raw || '{}').autostart; } catch {}
      if (typeof want !== 'boolean') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: '参数应为 { autostart: true|false }' }));
      }
      const managed = isManaged();
      // 先响应，再异步执行切换：开启=安装 job（若当前进程即该 job，bootout 会结束我们，
      // 新 job 靠 EADDRINUSE 重试平滑接管）；关闭=先拉起脱离 launchd 的实例保住本次会话，再卸载
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (want) {
        res.end(JSON.stringify({ ok: true, autostart: true, restarting: true, managed }));
        setTimeout(async () => {
          spawn(process.execPath, [INSTALLER], { detached: true, stdio: 'ignore', env: process.env }).unref();
          if (managed) return; // bootout 会结束当前 job（即我们），无需主动退出
          // 非托管实例：launchd 对频繁 bootstrap 的 label 可能延迟 spawn（实测可达 30s）。
          // 按住端口等 job 真正拉起再退出，把不可用窗口压到约 1 秒（job 侧有 EADDRINUSE 重试兜底）。
          const deadline = Date.now() + 45000;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 500));
            if (servicePid() > 0) break;
          }
          process.exit(0);
        }, 300);
      } else {
        res.end(JSON.stringify({ ok: true, autostart: false, restarting: managed }));
        setTimeout(() => {
          if (managed) {
            const logFd = openSync(SERVICE_LOG, 'a');
            spawn(process.execPath, ['web.mjs'], {
              cwd: __dirname,
              env: { ...process.env, NO_OPEN: '1' },
              detached: true,
              stdio: ['ignore', logFd, logFd],
            }).unref();
          }
          spawn(process.execPath, [INSTALLER, '--remove'], { detached: true, stdio: 'ignore', env: process.env }).unref();
          if (managed) setTimeout(() => process.exit(0), 1500);
        }, 300);
      }
    });
    return;
  }

  // 版本更新检查（GET /api/update/check，实现见 util/update.mjs）：只告知不自动安装，
  // 结果缓存 6 小时（<数据目录>/update-check.json），?force=1 强制重查
  if (req.method === 'GET' && (url === '/api/update/check' || url.startsWith('/api/update/check?'))) {
    const force = new URL(req.url, 'http://localhost').searchParams.has('force');
    const r = await checkUpdate({ current: VERSION, dataDir: DATA_DIR, force });
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(r));
  }

  // 终端 TUI 偏好（/api/settings/tui，实现见 util/tui/settings-api.mjs；终端启动时读取一次）
  if (url.startsWith('/api/settings/tui')) {
    if (await handleTuiSettingsApi(req, res, url, { loadConfig, saveConfig, log })) return;
  }

  // 生成参数与 API Key（/api/settings/generation、/api/settings/key，实现见 util/settings-generation.mjs；下一轮请求即时生效）
  if (url.startsWith('/api/settings/generation') || url.startsWith('/api/settings/key')) {
    if (await handleGenerationApi(req, res, url, { loadConfig, saveConfig, log })) return;
  }

  // Agent 沙箱代理（/api/settings/proxy，实现见 util/proxy.mjs；web_fetch 等出站请求即时生效）
  if (url.startsWith('/api/settings/proxy')) {
    if (await handleAgentProxyApi(req, res, url, { loadConfig, saveConfig, log })) return;
  }
  // 多提供方故障转移偏好（/api/settings/failover，实现见 util/llm/failover.mjs；下一轮请求即时生效）
  if (url.startsWith('/api/settings/failover')) {
    if (await handleFailoverApi(req, res, url, {
      loadConfig, saveConfig, log,
      state: failoverState,
      queue: { get: () => providers.failoverQueueIds() },
      healthIds: () => providers.all().map((p) => p.id),
    })) return;
  }

  if (req.method === 'POST' && url === '/api/abort') {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      let requestId = '';
      try { requestId = String(JSON.parse(raw || '{}').requestId || ''); } catch {}
      const entry = activeStreams.get(requestId);
      if (!entry) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ aborted: false, reason: '没有正在进行中的生成（可能已完成或已停止）' }));
      }
      entry.stopped = true;
      entry.controller.abort(new Error('用户点击了停止按钮'));
      log('info', '已收到停止请求', { requestId });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ aborted: true }));
    });
    return;
  }

  if (req.method === 'POST' && url === '/api/chat') {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 30 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      const started = Date.now();
      let entry = null;
      let requestId = '';
      let reader = null;
      try {
        const body = JSON.parse(raw || '{}');
        let messages = Array.isArray(body.messages) ? body.messages.slice() : [];
        // 模型选择：体验新模型时前端直接传 model，无需改代码；非法值回退到配置默认
        const model = MODEL_RE.test(String(body.model || '')) ? String(body.model) : cfg.model;
        // 提供方路由：前端可直接传 provider，未传时按模型 ID 反查所属提供方
        const provider = resolveChatProvider(body.provider, model);

        if (body.imagePath) {
          try {
            const dataUrl = await resolveImage(body.imagePath);
            const visionMsg = { role: 'user', content: [
              { type: 'image_url', image_url: { url: dataUrl } },
              { type: 'text', text: body.imageText || '请描述这张图片' },
            ] };
            if (messages.length && messages[messages.length - 1].role === 'user') messages[messages.length - 1] = visionMsg;
            else messages.push(visionMsg);
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: '图片读取失败: ' + e.message + '（也可用附件按钮 / 粘贴 / 拖拽发送）' } }));
          }
        }

        // 注册活跃流：/api/abort 与客户端断开都能中止上游，避免继续计费
        requestId = String(body.requestId || '') || randomUUID();
        entry = { requestId, controller: new AbortController(), started, usage: null, stopped: false, settled: false, model, provider: provider.id, price: provider.price };
        activeStreams.set(requestId, entry);
        res.on('close', () => {
          if (!res.writableEnded && !entry.settled) {
            entry.stopped = true;
            entry.controller.abort(new Error('客户端断开连接'));
            log('info', '客户端断开，已中止上游', { requestId });
          }
        });

        // 连接期退避重试：仅网络层失败且未产生任何字节时重试（借鉴 dsh retry-policy 的安全重试思想）
        // 内置提供方沿用全局 maxTokens/temperature/thinking；自定义提供方只在显式声明后发送，
        // 避免上游把未支持的字段当 400 拒绝（故障转移换到另一家时按目标提供方口径重新拼）
        const genFor = (p) => ({
          sendThinking: p.builtin || Boolean(p.thinking),
          thinkingOn: body.thinking !== false,
          maxTokens: p.builtin ? cfg.maxTokens : p.maxTokens,
          temperature: p.builtin ? cfg.temperature : p.temperature,
        });
        // LLM 抽象层统一入口（与 Agent Loop 同源）：构造请求 + 连接期重试 + 错误话术 + 帧翻译选择
        // + 多提供方故障转移（429/5xx/网络错误时换到提供同模型的其它提供方，用户无感知）
        // 故障转移开关 + 生效超时（关闭时超时归零，行为与接入前一致）+ 队列 + 熔断器
        const foCfg = parseFailoverConfig(cfg, {});
        const foEnabled = foCfg.enabled !== false;
        const foTimeouts = effectiveTimeouts(foCfg);
        let opened;
        try {
          opened = await openChatStream(provider, { model, messages, ...genFor(provider) }, {
            signal: entry.controller.signal,
            onRetry: (n, e) => log('warn', '上游连接失败，准备重试', { attempt: n, error: String(e) }),
            ...(foEnabled ? { circuit: failoverState.circuits, timeouts: foTimeouts, nonStreamMs: foTimeouts.nonStreamMs } : {}),
            // 预读：200 的错误 envelope 与首包超时在写字节前变成可换路错误
            ...(foEnabled ? {
              prime: (reader, translate, signal) => primeUpstreamStream(reader, {
                firstByteMs: foTimeouts.firstByteMs, detectFailure: semanticFailure, signal,
              }),
            } : {}),
            failover: {
              enabled: foEnabled,
              maxAttempts: foCfg.maxAttempts,
              queue: providers.failoverQueueIds(),
              candidates: () => providers.all(),
              // 记账归属跟随真实产出 token 的提供方（settleUsage 在收尾时读 entry）
              onSwitch: ({ from, to, reason, attempt }) => {
                entry.provider = to.id;
                entry.price = to.price;
                failoverState.setPref(model, to.id); // 热切换偏好：下次同模型优先这家
                log('warn', '上游暂不可用，已切换提供方重试', { from: from.id, to: to.id, reason, attempt });
              },
            },
          });
        } catch (e) {
          // 上游非 2xx：原样透传状态码与中文提示；网络层异常走下方统一兜底
          if (e?.kind) {
            log('warn', '上游错误', { kind: e.kind, status: e.status, provider: provider.id });
            res.writeHead(e.status || 502, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: { message: e.message } }));
          }
          throw e;
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        reader = opened.reader;
        // Anthropic Messages 的帧形状不同，逐帧翻译成 OpenAI 兼容帧，前端零改动
        if (opened.translate) await pumpTranslated(reader, res, entry, opened.translate, { idleMs: foTimeouts.idleMs });
        else await pumpSse(reader, res, entry, { idleMs: foTimeouts.idleMs });
        const rec = settleUsage(entry, Date.now() - started);
        log('info', '对话完成', { ms: rec.ms, inputTokens: rec.inputTokens, outputTokens: rec.outputTokens, cost: rec.cost, requestId });
      } catch (err) {
        const stopped = entry ? (entry.stopped || entry.controller.signal.aborted || err.name === 'AbortError') : false;
        if (stopped) {
          const rec = settleUsage(entry, Date.now() - started);
          log('info', '对话已停止', { ms: rec.ms, outputTokens: rec.outputTokens, requestId });
          try { res.end(); } catch {}
          return;
        }
        log('error', '代理异常', { error: String(err) });
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
        try { res.end(JSON.stringify({ error: { message: String(err) } })); } catch {}
      } finally {
        if (entry) activeStreams.delete(requestId);
        try { if (reader) Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
      }
    });
    return;
  }

  if (url.startsWith('/api/agent') || url.startsWith('/api/mcp') || url.startsWith('/api/files') || url.startsWith('/api/jobs')) { await agentApi(req, res, url); return; }

  // 工作区上下文（GET /api/workspace，实现见 util/workspace.mjs）：Header 工作区卡片数据源
  if (await handleWorkspaceApi(req, res, url)) return;

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'not found' } }));
});

// 端口占用时自动重试（默认布局与 LaunchAgent 接管、设置页切换自启时的平滑交接）
function startServer(attempt = 0) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < 60) {
      log('warn', '端口被占用，1 秒后重试', { port: PORT, attempt: attempt + 1 });
      setTimeout(() => startServer(attempt + 1), 1000);
      return;
    }
    log('error', '服务启动失败', { error: String(e) });
    process.exit(1);
  });
  server.listen(PORT, () => {
    const cfg = loadConfig();
    log('info', `AuroraAgent 已启动: http://localhost:${PORT}`, { model: cfg.model, hasKey: Boolean(cfg.apiKey), managed: isManaged() });
    // 定时任务调度器只在真正持有端口后启动：抢不到 jobs.lock 的实例（交接期旧实例）不参与调度
    agentApi.scheduler.start();
    if (process.env.NO_OPEN !== '1') exec(`open http://localhost:${PORT}`);
  });
}
// 退出必须释放 jobs.lock：否则要等下一次 PID 探活失败才有人接手调度
process.on('exit', () => { try { agentApi.scheduler.stop(); } catch {} });
startServer();
