#!/usr/bin/env node
/**
 * ModelTester 网页服务（零依赖）· 当前接入：美团 LongCat-2.5-Preview
 * 用法: node web.mjs   →  http://localhost:8787
 * 特性: 断流即中止上游、用量账本、请求日志、健康检查
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, openSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { exec, execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { SseParser } from './util/sse.mjs';
import { UsageLedger } from './util/usage.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 数据目录三级回退：MODELTESTER_DATA_DIR（启动器 / LaunchAgent 显式指定）→
// 同目录已有 modeltester.config.json 时用 App 目录本身（源码开发态）→
// 否则 ~/Library/Application Support/ModelTester（独立 App 态，数据与 Bundle 解耦）
function resolveDataDir() {
  if (process.env.MODELTESTER_DATA_DIR) return process.env.MODELTESTER_DATA_DIR;
  if (existsSync(join(__dirname, 'modeltester.config.json'))) return __dirname;
  return join(homedir(), 'Library', 'Application Support', 'ModelTester');
}
const DATA_DIR = resolveDataDir();
const CONFIG_PATH = join(DATA_DIR, 'modeltester.config.json');
const usage = new UsageLedger(DATA_DIR, { warn: (m, e) => log('warn', m, e) });
const BASE = process.env.MODELTESTER_BASE_URL || 'https://api.longcat.chat';
const PORT = Number(process.env.PORT || 8787);
const PRICE = { input: 2, output: 8 }; // 限时折扣价 ¥/百万 tokens
const VERSION = '4.0.0';

// ---------- 日志（LOG_LEVEL 模式） ----------
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = () => LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
function log(level, msg, extra) {
  if (LEVELS[level] < threshold()) return;
  const suffix = extra && Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${msg}${suffix}`;
  if (level === 'error') console.error(line); else console.log(line);
}

// ---------- 配置 ----------
function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  return {
    apiKey: process.env.MODELTESTER_API_KEY || saved.apiKey || '',
    model: saved.model || 'LongCat-2.5-Preview',
    thinking: saved.thinking !== false,
    temperature: saved.temperature ?? 0.7,
    maxTokens: saved.maxTokens ?? 32768,
  };
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
          return { id, name: p.name, tag: p.tag, owned: id === cfg.model };
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
const MIME = { '.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml; charset=utf-8' };
function serveStatic(res, filePath) {
  if (!existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
  const ext = filePath.slice(filePath.lastIndexOf('.'));
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  res.end(readFileSync(filePath));
}

// ---------- 活跃流注册表（/api/abort 按 requestId 停止；设计借鉴 dsh 的 stream cancel 语义） ----------
const activeStreams = new Map(); // requestId -> { controller, started, usage, stopped, settled, model }
function settleUsage(entry, ms) {
  entry.settled = true;
  const u = entry.usage;
  const inTok = u?.prompt_tokens || 0;
  const outTok = u?.completion_tokens || 0;
  const cost = (inTok * PRICE.input + outTok * PRICE.output) / 1_000_000;
  const rec = {
    requestId: entry.requestId, model: entry.model, ms,
    inputTokens: inTok, outputTokens: outTok,
    reasoningTokens: u?.completion_tokens_details?.reasoning_tokens || 0,
    cost: Number(cost.toFixed(6)), stopped: entry.stopped,
  };
  usage.record(rec);
  return rec;
}
// 额度耗尽的措辞识别（状态码之外的兜底；借鉴 dsh-llm 的 isQuotaExceededError）
const QUOTA_WORDING = /\binsufficient[\s_-]+(?:quota|balance|credits?)\b|\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b|\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b|\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i;

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

// ---------- 设置 / 开机自启（LaunchAgent 生命周期管理） ----------
// plist 生成规则与 tools/install-service.mjs 保持一致：日志固定落 ~/Library/Logs，
// 避免 launchd 打不开 ~/Documents 等 TCC 保护目录里的重定向文件（exit 78 EX_CONFIG）
const SERVICE_LABEL = 'com.modeltester.app';
const SERVICE_DOMAIN = `gui/${process.getuid()}`;
const PLIST_PATH = join(homedir(), 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
const SERVICE_LOG = join(homedir(), 'Library/Logs', `${SERVICE_LABEL}.log`);
const INSTALLER = join(__dirname, 'tools', 'install-service.mjs');
const sh = (cmd) => {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
};
/** launchd 里本服务的 pid；未安装/未运行返回 0 */
function servicePid() {
  const out = sh(`launchctl print ${SERVICE_DOMAIN}/${SERVICE_LABEL} 2>/dev/null`);
  const m = out.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : 0;
}
/** 当前进程是否正由 LaunchAgent 托管（切换自启时决定能否安全 bootout） */
const isManaged = () => servicePid() === process.pid;

// ---------- 服务 ----------
const server = createServer(async (req, res) => {
  const cfg = loadConfig();
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && (url === '/' || url === '/index.html')) return serveStatic(res, join(__dirname, 'public', 'index.html'));
  if (req.method === 'GET' && url === '/util/sse.mjs') return serveStatic(res, join(__dirname, 'util', 'sse.mjs'));
  if (req.method === 'GET' && url === '/icon.svg') return serveStatic(res, join(__dirname, 'public', 'icon.svg'));
  // 厂商标识：/vendor/<name>.svg（正则白名单防目录穿越），接入新厂商把 svg 放进 public/vendors/ 即可
  if (req.method === 'GET' && /^\/vendor\/[a-z0-9-]+\.svg$/.test(url)) {
    return serveStatic(res, join(__dirname, 'public', 'vendors', url.slice('/vendor/'.length)));
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(usage.summary()));
  }

  if (req.method === 'GET' && url === '/api/models') {
    const cat = await loadModelCatalog(req.url.includes('force=1'));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: cat.status === 'ready',
      status: cat.status,
      default: cfg.model,
      models: cat.models,
      error: cat.error,
    }));
  }

  if (req.method === 'GET' && url === '/api/settings') {
    const pid = servicePid();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({
      ok: true,
      version: VERSION,
      autostart: existsSync(PLIST_PATH),
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
        entry = { requestId, controller: new AbortController(), started, usage: null, stopped: false, settled: false, model };
        activeStreams.set(requestId, entry);
        res.on('close', () => {
          if (!res.writableEnded && !entry.settled) {
            entry.stopped = true;
            entry.controller.abort(new Error('客户端断开连接'));
            log('info', '客户端断开，已中止上游', { requestId });
          }
        });

        // 连接期退避重试：仅网络层失败且未产生任何字节时重试（借鉴 dsh retry-policy 的安全重试思想）
        let upstream;
        for (let attempt = 0; ; attempt++) {
          try {
            upstream = await fetch(`${BASE}/openai/v1/chat/completions`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                messages,
                stream: true,
                max_tokens: cfg.maxTokens,
                temperature: cfg.temperature,
                thinking: { type: body.thinking === false ? 'disabled' : 'enabled' },
              }),
              signal: entry.controller.signal,
            });
            break;
          } catch (e) {
            if (attempt >= 2 || entry.controller.signal.aborted || res.destroyed || e.name !== 'TypeError') throw e;
            log('warn', '上游连接失败，准备重试', { attempt: attempt + 1, error: String(e) });
            await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          }
        }

        if (!upstream.ok) {
          const errText = await upstream.text();
          let hint = errText;
          try {
            const e = JSON.parse(errText).error || {};
            if (upstream.status === 401) hint = 'API Key 无效：请检查 modeltester.config.json 里的 apiKey，或访问 https://longcat.chat/platform/api_keys 重新获取';
            else if (upstream.status === 402) hint = '账号额度已用尽：请到 https://longcat.chat/platform/ 充值，或抢购 Token 资源包（每日 10:00/16:00/21:00/23:00），或完成邀请任务领取奖励';
            else if (upstream.status === 429) hint = '请求过于频繁，请稍等几秒再发';
            else if (QUOTA_WORDING.test(errText)) hint = '账号额度可能已用尽：请到 https://longcat.chat/platform/ 充值，或抢购 Token 资源包（每日 10:00/16:00/21:00/23:00），或完成邀请任务领取奖励';
            else hint = e.message || errText;
          } catch {}
          log('warn', '上游错误', { status: upstream.status });
          res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: hint } }));
        }

        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        // 借鉴 dsh cancellableStream：abort 时即使 read() 未立即拒绝，也能立刻跳出循环
        let rejectOnAbort;
        const abortRace = new Promise((_, reject) => { rejectOnAbort = reject; });
        abortRace.catch(() => {}); // 防止循环正常结束后才 abort 导致未处理的拒绝
        entry.controller.signal.addEventListener('abort', () => {
          const reason = entry.controller.signal.reason;
          rejectOnAbort(reason instanceof Error ? reason : new Error('已中止'));
        }, { once: true });
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), abortRace]);
          if (done) break;
          res.write(Buffer.from(value));
          // 顺手用 SSE 解析器从流里提取 usage 记账
          for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
            if (ev.data === '[DONE]') continue;
            try { const j = JSON.parse(ev.data); if (j.usage) { entry.usage = j.usage; } } catch {}
          }
        }
        for (const ev of parser.end()) {
          if (ev.data === '[DONE]') continue;
          try { const j = JSON.parse(ev.data); if (j.usage) entry.usage = j.usage; } catch {}
        }
        res.end();
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
    log('info', `ModelTester 已启动: http://localhost:${PORT}`, { model: cfg.model, hasKey: Boolean(cfg.apiKey), managed: isManaged() });
    if (process.env.NO_OPEN !== '1') exec(`open http://localhost:${PORT}`);
  });
}
startServer();
