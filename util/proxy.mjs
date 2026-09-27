/**
 * 本机代理：Agent 沙箱出站请求（web_fetch 等）经用户设置的 HTTP 代理访问外网
 * （本机直连维基百科等站点被重置时的出路）。零依赖，只用 Node 内置模块：
 *   - parseAgentProxy：代理地址归一化与校验（http://host:port 或裸 host:port；空 = 直连）
 *   - proxyFetch：http 目标走正向代理（绝对 URI），https 目标走 CONNECT 隧道 + TLS
 *   - handleAgentProxyApi：GET / POST /api/settings/proxy（设置页「网络」面板，web.mjs 一行委派）
 * 说明：Node 内置 fetch 不读 HTTP_PROXY 环境变量，故自行实现隧道而非引 undici。
 */
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

const MAX_REDIRECTS = 5;

/**
 * 代理地址归一化：'' = 直连（合法），'http://host:port' = 规范形态，null = 非法。
 * 接受裸 host:port（补 http://）；拒绝 socks5 等其它协议与越界端口。
 */
export function parseAgentProxy(raw, { warn } = {}) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/[^\x00-\x7F]/.test(s)) {
    if (warn) warn('agentProxy 含非 ASCII 字符，已回退直连', { value: s });
    return null;
  }
  let u;
  try { u = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s) ? s : `http://${s}`); } catch {
    if (warn) warn('agentProxy 不是合法地址，已回退直连', { value: s });
    return null;
  }
  if (u.protocol !== 'http:') {
    if (warn) warn('agentProxy 仅支持 http 代理（socks5 等暂不支持），已回退直连', { value: s });
    return null;
  }
  const port = Number(u.port || 80);
  if (!u.hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    if (warn) warn('agentProxy 端口越界，已回退直连', { value: s });
    return null;
  }
  return `http://${u.hostname}:${port}`;
}

/** 代理地址 → { host, port }（入参应是 parseAgentProxy 的合法产物） */
function proxyParts(proxyUrl) {
  const u = new URL(proxyUrl);
  return { host: u.hostname, port: Number(u.port || 80) };
}

/** 错误文案中文化：代理拒绝连接 / 超时 / CONNECT 被拒都要说清下一步 */
function friendlyProxyError(e, proxy) {
  const where = `代理 ${proxy.host}:${proxy.port}`;
  if (e?.code === 'ECONNREFUSED' || e?.code === 'ECONNRESET') {
    return `${where} 拒绝连接（请确认本机代理软件正在运行、端口填写正确）`;
  }
  if (e?.code === 'ETIMEDOUT' || /超时/.test(String(e?.message || ''))) {
    return `${where} 连接超时（请检查代理软件状态或网络）`;
  }
  return `${where} 转发失败：${e?.message || String(e)}`;
}

/** 经代理建 CONNECT 隧道并完成 TLS 握手，返回可直接复用的 TLS socket */
function openTunnel(proxy, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = netConnect({ host: proxy.host, port: proxy.port });
    let settled = false;
    const fail = (e) => { if (!settled) { settled = true; try { sock.destroy(); } catch {} reject(e); } };
    sock.setTimeout(timeoutMs, () => fail(new Error(`代理连接超时（${Math.round(timeoutMs / 1000)}s）`)));
    sock.on('error', fail);
    sock.on('connect', () => {
      sock.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', function onData(chunk) {
      buf += chunk.toString('latin1');
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      sock.off('data', onData);
      const statusLine = buf.slice(0, buf.indexOf('\r\n'));
      const m = /^HTTP\/\d\.\d (\d{3})/.exec(statusLine);
      if (!m || m[1] !== '200') {
        return fail(new Error(`代理拒绝 CONNECT ${host}:${port}（${statusLine.trim() || '无响应'}）`));
      }
      const tlsSock = tlsConnect({ socket: sock, servername: host }, () => {
        if (!settled) { settled = true; resolve(tlsSock); }
      });
      tlsSock.on('error', fail);
    });
  });
}

/** 单次请求（不跟随重定向）；http 目标走正向代理绝对 URI，https 目标走隧道 */
function fetchOnce(targetUrl, proxy, timeoutMs) {
  const u = new URL(targetUrl);
  const isHttps = u.protocol === 'https:';
  // WHATWG URL 已把非 ASCII 路径百分号编码（中文 URL 直连会被 http 客户端拒绝，必须编码后进请求行）
  const requestPath = `${u.pathname}${u.search}`;
  const absoluteUri = `${u.protocol}//${u.host}${requestPath}`;
  const headers = { 'user-agent': 'AuroraAgent', accept: '*/*', host: u.host };
  return new Promise((resolve, reject) => {
    const onResp = (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: { get: (name) => res.headers[String(name).toLowerCase()] ?? null },
        text: async () => Buffer.concat(chunks).toString('utf8'),
      }));
      res.on('error', reject);
    };
    const fail = (e) => reject(new Error(friendlyProxyError(e, proxy)));
    let req;
    if (isHttps) {
      openTunnel(proxy, u.hostname, Number(u.port || 443), timeoutMs).then((tlsSock) => {
        req = httpsRequest({ method: 'GET', path: requestPath, headers, agent: false, createConnection: () => tlsSock }, onResp);
        req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)));
        req.on('error', fail);
        req.end();
      }, (e) => reject(new Error(friendlyProxyError(e, proxy))));
    } else {
      // 正向代理：请求行为绝对 URI，Host 头仍是目标站点
      req = httpRequest({ host: proxy.host, port: proxy.port, method: 'GET', path: absoluteUri, headers }, onResp);
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）`)));
      req.on('error', fail);
      req.end();
    }
  });
}

/**
 * 经代理抓取 URL（跟随重定向，封顶 5 跳）。
 * @returns {Promise<{ status: number, headers: { get(name): string|null }, text(): Promise<string> }>}
 */
export async function proxyFetch(url, proxyUrl, { timeoutMs = 20000 } = {}) {
  const proxy = proxyParts(parseAgentProxy(proxyUrl) || '');
  let current = String(url);
  for (let hop = 0; ; hop++) {
    const resp = await fetchOnce(current, proxy, timeoutMs);
    const loc = resp.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(resp.status) && loc && hop < MAX_REDIRECTS) {
      current = new URL(loc, current).toString();
      continue;
    }
    return resp;
  }
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

/** @returns {Promise<boolean>} true = 已处理（含 405），false = 路径不归本模块 */
export async function handleAgentProxyApi(req, res, url, ctx) {
  const { loadConfig, saveConfig, log = () => {} } = ctx;
  if (url !== '/api/settings/proxy') return false;

  if (req.method === 'GET') {
    json(res, 200, { ok: true, agentProxy: loadConfig().agentProxy || '' });
    return true;
  }

  if (req.method === 'POST') {
    const body = await readBody(req, 8 * 1024);
    if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return true; }
    const parsed = parseAgentProxy(body.agentProxy);
    if (parsed === null) {
      json(res, 400, { ok: false, error: '代理地址应为 http://主机:端口（如 http://127.0.0.1:7890），留空表示直连；socks5 暂不支持' });
      return true;
    }
    const cfg = loadConfig();
    cfg.agentProxy = parsed;
    saveConfig(cfg);
    log('info', 'Agent 代理设置已更新', { agentProxy: parsed || '直连' });
    json(res, 200, { ok: true, agentProxy: parsed });
    return true;
  }

  json(res, 405, { ok: false, error: '仅支持 GET / POST' });
  return true;
}
