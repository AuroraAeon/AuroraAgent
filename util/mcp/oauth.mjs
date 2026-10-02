/**
 * MCP OAuth 2.1（零依赖，仅 Node 内置模块；迁移 pi packages/mcp/src/oauth 的本地下半场）。
 *
 * 背景：MCP 规范要求 HTTP 传输的远端服务器可以要求 OAuth 2.1 授权。pi 为此搬了整套
 * MCP TypeScript SDK 的 auth.ts（动态客户端注册、回调服务器、loopback、PKCE、发现链）。
 * 本地单用户工具不需要那么全，但要的几条硬边界一条不让：
 *
 *  - 发现链：RFC 9728 protected-resource metadata → RFC 8414 authorization-server metadata
 *    （.well-known/oauth-authorization-server，回退 .well-known/openid-configuration）；
 *  - PKCE S256：不落地 client_secret，公开客户端 + loopback 重定向（单用户本机工具的标准形态）；
 *  - 令牌落盘 0600 原子写（util/atomic.mjs）：含 access_token 的文件半截与全局可读都是事故；
 *  - scope 收缩与 issuer 不匹配一律拒绝（pi 同款口径：不把令牌送给来路不明的授权服务器）。
 *
 * 刻意不做：动态客户端注册（DCR）、device code（本地没有第二屏）、回调 HTTP 服务器的
 * 自动开浏览器之外的搬运——授权码由用户从浏览器地址栏复制回终端 / 设置页粘贴，本机工具
 * 这么做比开一个端口等回调更稳（端口被占、防火墙弹窗都不影响）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic.mjs';

const OAUTH_STORE_VERSION = 1;

/** base64url 编码（无 padding，PKCE / state 都用它） */
function base64Url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE 对：verifier 43-128 字符，challenge = base64url(sha256(verifier)) */
export function pkcePair() {
  const verifier = base64Url(randomBytes(48));
  const challenge = base64Url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

/** 随机 state（防 CSRF：回填的授权码必须配我们发出去的那个 state） */
export function oauthState() {
  return base64Url(randomBytes(24));
}

/**
 * 解析 WWW-Authenticate 挑战头（RFC 9728 §11.3 形态）：
 *   Bearer realm="...", scope="tools:read", resource_metadata="https://.../.well-known/oauth-protected-resource"
 * 解析不了（不是一个 Bearer 挑战）时返回 null。
 */
export function parseWwwAuthenticate(header) {
  const raw = String(header || '');
  if (!/^bearer/i.test(raw.trim())) return null;
  const out = {};
  // 逗号分隔的 auth-param，值可能是带引号的字符串
  for (const m of raw.matchAll(/([a-zA-Z_][a-zA-Z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    const key = m[1].toLowerCase();
    const val = (m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3]).trim();
    if (val) out[key] = val;
  }
  return Object.keys(out).length ? out : null;
}

/** 是否「需要走 OAuth」的响应：401 / 403 且带 Bearer 挑战头 */
export function isOAuthChallenge(status, wwwAuthenticate) {
  const code = Number(status);
  if (code !== 401 && code !== 403) return false;
  return Boolean(parseWwwAuthenticate(wwwAuthenticate));
}

/** RFC 8414 发现 URL 序列（oauth 优先，openid-configuration 回退） */
export function buildDiscoveryUrls(authServerUrl) {
  const issuer = new URL(String(authServerUrl));
  const path = issuer.pathname.endsWith('/') ? issuer.pathname.slice(0, -1) : issuer.pathname;
  const urls = [
    { url: new URL(`/.well-known/oauth-authorization-server${path}`, issuer.origin).href, type: 'oauth' },
    { url: new URL(`/.well-known/openid-configuration${path}`, issuer.origin).href, type: 'oidc' },
  ];
  if (path) urls.push({ url: new URL(`${path}/.well-known/openid-configuration`, issuer.origin).href, type: 'oidc' });
  return urls;
}

/** 发现链：先 protected-resource，再 authorization-server；issuer 不匹配直接拒 */
export async function discoverOAuthMetadata(serverUrl, { fetchImpl = globalThis.fetch, resourceMetadataUrl = '' } = {}) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const server = new URL(String(serverUrl));
  let resource;
  try {
    const rmUrl = resourceMetadataUrl
      || new URL(`/.well-known/oauth-protected-resource${server.pathname === '/' ? '' : server.pathname.replace(/\/$/, '')}`, server.origin).href;
    const resp = await doFetch(rmUrl, { headers: { Accept: 'application/json' } });
    if (resp.ok) {
      const meta = await resp.json().catch(() => null);
      if (meta && typeof meta === 'object') resource = meta;
    }
  } catch { /* 没有 protected-resource 元数据不是错误：直接当授权服务器就是自己 */ }
  const authServerUrl = (resource && Array.isArray(resource.authorization_servers) && resource.authorization_servers[0]) || new URL('/', server).href;
  let metadata = null;
  let lastErr = null;
  for (const { url } of buildDiscoveryUrls(authServerUrl)) {
    try {
      const resp = await doFetch(url, { headers: { Accept: 'application/json' } });
      if (!resp.ok) { if (resp.status !== 404) lastErr = new Error(`HTTP ${resp.status}`); continue; }
      const meta = await resp.json().catch(() => null);
      if (!meta || typeof meta !== 'object') continue;
      const trim = (v) => String(v || '').replace(/\/$/, '');
      if (trim(meta.issuer) && trim(meta.issuer) !== trim(authServerUrl)) {
        throw new Error(`授权服务器 issuer 不匹配：元数据声明 ${meta.issuer}，期望 ${authServerUrl}`);
      }
      metadata = meta;
      break;
    } catch (e) { lastErr = e; }
  }
  if (!metadata || !metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error(`未找到可用的 OAuth 授权服务器元数据（${authServerUrl}）${lastErr ? `：${lastErr.message}` : ''}`);
  }
  return {
    authorizationServerUrl: authServerUrl,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    registrationEndpoint: metadata.registration_endpoint || null,
    scopesSupported: Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported : [],
    resource: resource && typeof resource.resource === 'string' ? resource.resource : undefined,
  };
}

/** 拼授权 URL（authorization code + PKCE） */
export function buildAuthorizationUrl({ authorizationEndpoint, clientId, redirectUri, scope = '', resource, state, codeChallenge }) {
  const url = new URL(String(authorizationEndpoint));
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', String(clientId));
  url.searchParams.set('redirect_uri', String(redirectUri));
  url.searchParams.set('state', String(state));
  url.searchParams.set('code_challenge', String(codeChallenge));
  url.searchParams.set('code_challenge_method', 'S256');
  if (scope) url.searchParams.set('scope', String(scope));
  if (resource) url.searchParams.set('resource', String(resource));
  return url.href;
}

/** 令牌响应归一：缺 expires_in 当 1 小时，缺 refresh_token 时保留旧的（scope 收缩时尤其重要） */
export function normalizeTokens(fresh, previous = null, nowMs = Date.now()) {
  const prev = previous && typeof previous === 'object' ? previous : {};
  const accessToken = String(fresh?.access_token || '');
  if (!accessToken) throw new Error('令牌响应缺少 access_token');
  const expiresIn = Number(fresh?.expires_in);
  const expiresAt = Number.isFinite(expiresIn) && expiresIn > 0 ? nowMs + expiresIn * 1000 : nowMs + 3600 * 1000;
  return {
    accessToken,
    refreshToken: String(fresh?.refresh_token || prev.refreshToken || ''),
    tokenType: String(fresh?.token_type || prev.tokenType || 'Bearer'),
    scope: String(fresh?.scope || prev.scope || ''),
    expiresAt,
    ...(fresh?.id_token ? { idToken: String(fresh.id_token) } : {}),
  };
}

/** 是否过期（留 30s 余量：快过期的令牌发出去只会拿到 401，不如提前刷新） */
export function tokenExpired(tokens, nowMs = Date.now()) {
  if (!tokens || typeof tokens !== 'object') return true;
  if (!tokens.accessToken) return true;
  if (!Number.isFinite(Number(tokens.expiresAt))) return false; // 未声明过期时间：不猜，用到 401 再说
  return Number(tokens.expiresAt) - nowMs <= 30000;
}

/** 授权码换令牌 */
export async function exchangeAuthorizationCode({ tokenEndpoint, code, redirectUri, clientId, codeVerifier, resource, fetchImpl = globalThis.fetch }) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: String(code),
    redirect_uri: String(redirectUri),
    client_id: String(clientId),
    code_verifier: String(codeVerifier),
  });
  if (resource) body.set('resource', String(resource));
  const resp = await doFetch(String(tokenEndpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json) throw new Error(`令牌交换失败：HTTP ${resp.status} ${json?.error_description || json?.error || ''}`.trim());
  return normalizeTokens(json);
}

/** 刷新令牌（refresh_token 被撤销时抛错，调用方退回重新授权） */
export async function refreshTokens({ tokenEndpoint, refreshToken, clientId, resource, fetchImpl = globalThis.fetch }) {
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch;
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: String(refreshToken || ''), client_id: String(clientId) });
  if (resource) body.set('resource', String(resource));
  const resp = await doFetch(String(tokenEndpoint), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok || !json) throw new Error(`令牌刷新失败：HTTP ${resp.status} ${json?.error_description || json?.error || ''}`.trim());
  return normalizeTokens(json, { refreshToken });
}

/** 读令牌库（<数据目录>/mcp-oauth.json，原子 0600：半截文件 = 丢授权，全局可读 = 泄露令牌） */
export function loadOAuthStore(path) {
  try {
    const store = JSON.parse(readFileSync(String(path), 'utf8'));
    if (store && typeof store === 'object' && store.v === OAUTH_STORE_VERSION && store.servers && typeof store.servers === 'object') return store;
  } catch { /* 不存在 / 损坏：按空库处理（用户重新授权一次即可） */ }
  return { v: OAUTH_STORE_VERSION, servers: {} };
}

export function saveOAuthStore(path, store) {
  try {
    writeFileAtomic(String(path), JSON.stringify({ v: OAUTH_STORE_VERSION, servers: store?.servers || {} }));
    return true;
  } catch { return false; }
}

/**
 * OAuth 管理器：令牌库 + 授权入口 + 到期刷新。
 *
 * 用户配置形态（mcp.json 的 http 服务器可带 oauth 段，缺省全部关闭）：
 *   { "id": "s1", "transport": "http", "url": "https://mcp.test/mcp",
 *     "oauth": { "clientId": "auroraagent", "scope": "tools:read", "redirectUri": "http://127.0.0.1:8765/callback" } }
 * clientId 由用户填（本地工具不做动态客户端注册：那需要把 redirect_uri 预先登记到对方后台，
 * 用户早晚得手动做一次，不如直接说明白）。redirectUri 缺省 http://127.0.0.1:8765/callback，
 * 授权码由用户从浏览器地址栏复制回来粘贴——不开端口等回调，端口被占 / 防火墙弹窗都不影响。
 */
const DEFAULT_REDIRECT_URI = 'http://127.0.0.1:8765/callback';

export class McpOAuthManager {
  constructor({ dataDir, log = () => {} } = {}) {
    this.dir = String(dataDir || '');
    this.path = join(this.dir, 'mcp-oauth.json');
    this.log = log;
    this.#pending = new Map();
  }

  #pending = new Map();

  /** 该服务器的授权状态（设置页与 /api/mcp 状态共用） */
  status(serverId) {
    const entry = loadOAuthStore(this.path).servers[String(serverId || '')] || null;
    if (!entry || !entry.tokens || !entry.tokens.accessToken) return { authorized: false, expiresAt: 0, expired: false, scope: '' };
    const expired = tokenExpired(entry.tokens);
    return { authorized: true, expiresAt: Number(entry.tokens.expiresAt) || 0, expired, scope: entry.tokens.scope || '' };
  }

  /** 连接时用的 Authorization 头（同步：到期刷新在 ensureFresh 里做） */
  authHeaders(serverId) {
    const entry = loadOAuthStore(this.path).servers[String(serverId || '')] || null;
    if (!entry || !entry.tokens || !entry.tokens.accessToken) return null;
    if (tokenExpired(entry.tokens)) return null;
    return { Authorization: `${entry.tokens.tokenType || 'Bearer'} ${entry.tokens.accessToken}` };
  }

  /** 连不上前的预先刷新：过期且拿得到 refresh_token 就换一把，失败不抛（沿用旧令牌试一次） */
  async ensureFresh(server, serverId) {
    const id = String(serverId || server?.id || '');
    const store = loadOAuthStore(this.path);
    const entry = store.servers[id];
    if (!entry || !entry.tokens?.accessToken || !tokenExpired(entry.tokens)) return false;
    if (!entry.tokens.refreshToken || !entry.tokenEndpoint) return false;
    try {
      entry.tokens = await refreshTokens({
        tokenEndpoint: entry.tokenEndpoint,
        refreshToken: entry.tokens.refreshToken,
        clientId: entry.clientId,
        resource: entry.resource,
      });
      saveOAuthStore(this.path, store);
      this.log('info', 'MCP 令牌已刷新', { serverId: id });
      return true;
    } catch (e) {
      this.log('warn', 'MCP 令牌刷新失败', { serverId: id, error: String(e?.message || e) });
      return false;
    }
  }

  /** 发起授权：发现元数据 + 生成 PKCE / state，返回让用户去打开的 URL */
  async start(server, serverId) {
    const id = String(serverId || server?.id || '');
    const cfg = (server && server.oauth) || {};
    if (server?.transport !== 'http' || !server?.url) throw new Error('只有 http 传输的服务器需要 OAuth 授权');
    const meta = await discoverOAuthMetadata(server.url, {
      ...(cfg.resourceMetadataUrl ? { resourceMetadataUrl: cfg.resourceMetadataUrl } : {}),
    });
    const pkce = pkcePair();
    const state = oauthState();
    const redirectUri = String(cfg.redirectUri || DEFAULT_REDIRECT_URI);
    const clientId = String(cfg.clientId || '').trim();
    if (!clientId) throw new Error('请先在服务器配置里填 oauth.clientId（本地工具不做动态客户端注册）');
    this.#pending.set(id, { verifier: pkce.verifier, state, redirectUri, clientId, resource: meta.resource, tokenEndpoint: meta.tokenEndpoint, at: Date.now() });
    return {
      authorizationUrl: buildAuthorizationUrl({
        authorizationEndpoint: meta.authorizationEndpoint,
        clientId, redirectUri, scope: cfg.scope || '', resource: meta.resource,
        state, codeChallenge: pkce.challenge,
      }),
      state,
    };
  }

  /** 用户粘贴授权码回来：校验 state → 换令牌 → 落盘 */
  async complete(server, serverId, code, state) {
    const id = String(serverId || server?.id || '');
    const pending = this.#pending.get(id);
    if (!pending) throw new Error('没有进行中的授权流程，请重新发起');
    if (String(state || '') !== pending.state) throw new Error('state 不匹配（可能是伪造的回调），本次授权作废');
    const tokens = await exchangeAuthorizationCode({
      tokenEndpoint: pending.tokenEndpoint,
      code: String(code || '').trim(),
      redirectUri: pending.redirectUri,
      clientId: pending.clientId,
      codeVerifier: pending.verifier,
      resource: pending.resource,
    });
    const store = loadOAuthStore(this.path);
    store.servers[id] = {
      clientId: pending.clientId,
      tokenEndpoint: pending.tokenEndpoint,
      resource: pending.resource,
      tokens,
    };
    this.#pending.delete(id);
    if (!saveOAuthStore(this.path, store)) throw new Error('令牌落盘失败，授权未保存');
    return this.status(id);
  }

  /** 撤销：删掉该服务器的令牌（下次连接重新授权） */
  revoke(serverId) {
    const id = String(serverId || '');
    const store = loadOAuthStore(this.path);
    if (!store.servers[id]) return false;
    delete store.servers[id];
    this.#pending.delete(id);
    return saveOAuthStore(this.path, store);
  }
}
