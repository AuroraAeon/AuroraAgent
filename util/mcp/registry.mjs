/**
 * MCP 服务器注册表（实验特性 AURORAAGENT_EXPERIMENTAL_MCP 门控，默认关）：
 *   mcp.json      服务器配置（<数据目录>/mcp.json，原子落盘；含连接信息，不存密钥以外的敏感项由用户自管）
 *   McpRegistry   连接所有启用服务器 → 发现工具 → 包装成 kosong 形状工具（mcp__<服务器>__<工具>）
 *                 → 供 loop 的 extraTools 进入请求与执行；每个 MCP 工具经 policy 门控（默认 ask）。
 * 单个服务器连接失败不阻塞其他服务器：错误随 status 透出，UI 与终端可见。
 */
import { readFileSync, existsSync } from 'node:fs';
import { writeFileAtomic } from '../atomic.mjs';
import { join } from 'node:path';
import { connectMcp, callResultText, McpAuthError } from './client.mjs';
import { McpOAuthManager } from './oauth.mjs';

const MCP_FILE = 'mcp.json';
const ID_RE = /^[A-Za-z0-9._-]{1,48}$/;

/** 读取服务器配置；坏文件按空列表处理（不阻塞启动） */
export function loadMcpServers(dataDir) {
  try {
    const j = JSON.parse(readFileSync(join(dataDir, MCP_FILE), 'utf8'));
    if (!j || !Array.isArray(j.servers)) return [];
    return j.servers.filter((s) => s && ID_RE.test(String(s.id || '')));
  } catch { return []; }
}

/** 原子落盘（tmp + fsync + rename + 0600，见 util/atomic.mjs）：服务器配置的 env 里可能带密钥 */
export function saveMcpServers(dataDir, servers) {
  writeFileAtomic(join(dataDir, MCP_FILE), JSON.stringify({ servers }, null, 2));
}

/** 传输类型归一化（对齐 OpenBitFun v1.0.2 #3156 / #3164）：MCP 生态里 streamableHttp 是事实标准拼写，
 *  大小写、连字符与下划线变体一律接受；无法识别返回 null，由调用方报「类型无法识别」而不是
 *  静默当成 stdio 再报一句「缺启动命令」（那会把粘贴失误引向完全错误的方向）。
 *  sse 归一到 http：本地 HTTP 传输本来就兼容「直接 JSON 或 SSE 流」两种响应形态。 */
export function normalizeTransport(raw) {
  const key = String(raw ?? '').trim().toLowerCase().replace(/[\s_-]/g, '');
  if (!key) return null;
  if (key === 'http' || key === 'streamablehttp' || key === 'sse') return 'http';
  if (key === 'stdio') return 'stdio';
  return null;
}

/** source 字段大小写归一化（#3164）：外部配置常写成 Source / SOURCE，落盘前统一成小写 */
export function normalizeTransportSource(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  return value ? value.slice(0, 60) : '';
}

/**
 * OAuth 段归一（消费方 util/mcp/oauth.mjs）：只有 http 传输的服务器能要求授权。
 * clientId 由用户填——本地工具不做动态客户端注册（那要求 redirect_uri 预先登记到对方后台），
 * 所以没有 clientId 就等于没有授权流程，这段配置宁可不落，也不留一个「看起来配了其实不生效」的坑。
 */
function normalizeOauth(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const clientId = String(raw.clientId || '').trim().slice(0, 200);
  if (!clientId) return null;
  const out = { clientId };
  const scope = String(raw.scope || '').trim().slice(0, 400);
  if (scope) out.scope = scope;
  const redirectUri = String(raw.redirectUri || '').trim().slice(0, 400);
  if (/^https?:\/\//.test(redirectUri)) out.redirectUri = redirectUri;
  const resourceMetadataUrl = String(raw.resourceMetadataUrl || '').trim().slice(0, 400);
  if (/^https?:\/\//.test(resourceMetadataUrl)) out.resourceMetadataUrl = resourceMetadataUrl;
  return out;
}

/** 草稿校验：返回 { ok, server?, errors: {字段: 中文原因} } */
export function validateServerDraft(draft) {
  const errors = {};
  const id = String(draft.id || '').trim();
  if (!ID_RE.test(id)) errors.id = 'ID 只能用字母、数字与 . _ -，最长 48 字符';
  const name = String(draft.name || '').trim().slice(0, 60) || id;
  const rawTransport = String(draft.transport ?? '').trim();
  const want = normalizeTransport(rawTransport);
  if (rawTransport && !want) {
    errors.transport = `无法识别的传输类型：${rawTransport}（可用 stdio / http；streamableHttp、streamable-http 等变体也接受）`;
  }
  const transport = want || 'stdio';
  const server = { id, name, transport, enabled: draft.enabled !== false };
  const source = normalizeTransportSource(draft.source);
  if (source) server.source = source;
  if (transport === 'stdio') {
    const command = String(draft.command || '').trim();
    if (!command) errors.command = 'stdio 传输必须填写启动命令';
    server.command = command;
    const args = Array.isArray(draft.args) ? draft.args.map((a) => String(a)).filter((a) => a.length <= 200) : [];
    server.args = args;
    if (draft.env && typeof draft.env === 'object') {
      const env = {};
      for (const [k, v] of Object.entries(draft.env)) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && String(v).length <= 500) env[k] = String(v);
      }
      server.env = env;
    }
  } else {
    const url = String(draft.url || '').trim();
    if (!/^https?:\/\//.test(url)) errors.url = 'HTTP 传输需要 http(s):// 开头的端点';
    server.url = url;
    // OAuth 配置随草稿落盘（mcp.json）：丢在这里的话 oauthStart 永远报「请先填 clientId」，
    // 而设置页明明已经填过——用户看到的是一个骗人的错误
    const oauth = normalizeOauth(draft.oauth);
    if (oauth) server.oauth = oauth;
  }
  return { ok: Object.keys(errors).length === 0, server, errors };
}

/** MCP 工具名：mcp__<服务器 ID>__<工具名>（函数调用安全字符） */
export function mcpToolName(serverId, toolName) {
  const safe = String(toolName || 'tool').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  return `mcp__${serverId}__${safe}`;
}

export class McpRegistry {
  /** @param dataDir 数据目录；@param log 日志 */
  constructor({ dataDir, log = () => {} }) {
    this.dataDir = dataDir;
    this.log = log;
    this.servers = loadMcpServers(dataDir);
    this.connections = new Map(); // id -> { client, serverInfo, toolCount } | { skipped } | { error }
    this.tools = []; // 包装后的 kosong 形状工具（供 loop extraTools）
    // OAuth 令牌库（util/mcp/oauth.mjs）：http 传输的服务器可要求授权，令牌与待授权流程都归它管
    this.oauth = new McpOAuthManager({ dataDir, log: this.log });
  }

  /** HTTP 服务器的 auth 注入器：连接前先刷新过期令牌，再按令牌库出 Authorization 头 */
  #authFor(s) {
    return { get: () => this.oauth.authHeaders(s.id) };
  }

  /** 连接单个服务器（带 OAuth：先刷新，401 挑战上抛 McpAuthError 由 refresh 捕获转状态） */
  async #connectOne(s) {
    await this.oauth.ensureFresh(s, s.id);
    return connectMcp(s.transport === 'http' ? { ...s, auth: this.#authFor(s) } : s);
  }

  /** 增删改配置并落盘（不自动重连；改后由调用方决定何时 refresh） */
  upsert(draft) {
    const { ok, server, errors } = validateServerDraft(draft);
    if (!ok) return { ok: false, errors };
    const exists = this.servers.some((s) => s.id === server.id);
    if (exists && draft.__replace !== true) {
      // 同 ID 更新：保留原 enabled 除非显式给出
      this.servers = this.servers.map((s) => (s.id === server.id ? { ...s, ...server } : s));
    } else if (exists) {
      this.servers = this.servers.map((s) => (s.id === server.id ? { ...s, ...server } : s));
    } else {
      this.servers = [...this.servers, server];
    }
    saveMcpServers(this.dataDir, this.servers);
    return { ok: true, server };
  }

  /** 显示开关：停用后 refresh 直接跳过（工具不进 Agent 工具箱），配置保留、可随时再开 */
  setEnabled(id, enabled) {
    const target = this.servers.find((s) => s.id === String(id || ''));
    if (!target) return { ok: false, error: '服务器不存在' };
    target.enabled = enabled !== false;
    saveMcpServers(this.dataDir, this.servers);
    return { ok: true, server: target };
  }

  remove(id) {
    const before = this.servers.length;
    this.servers = this.servers.filter((s) => s.id !== String(id || ''));
    saveMcpServers(this.dataDir, this.servers);
    return { removed: before - this.servers.length };
  }

  /** 连接全部启用服务器并发现工具；单服务器失败不影响其他 */
  async refresh() {
    for (const [, c] of this.connections) { try { c.client?.close(); } catch {} }
    this.connections.clear();
    this.tools = [];
    for (const s of this.servers) {
      if (s.enabled === false) { this.connections.set(s.id, { skipped: true }); continue; }
      try {
        const client = await this.#connectOne(s);
        const listed = await client.listTools();
        const wrapped = listed.map((t) => this.#wrap(s, t, client));
        this.connections.set(s.id, { client, serverInfo: client.serverInfo, toolCount: wrapped.length });
        this.tools.push(...wrapped);
      } catch (e) {
        this.log('warn', 'MCP 服务器连接失败', { id: s.id, error: String(e?.message || e) });
        this.connections.set(s.id, {
          ...(e instanceof McpAuthError ? { needsAuth: true, oauthChallenge: e.challenge } : {}),
          error: String(e?.message || e),
        });
      }
    }
    return this.status();
  }

  /** 单个服务器试连（设置页「测试连接」用，不改变已注册连接） */
  async probe(id) {
    const s = this.servers.find((x) => x.id === String(id || ''));
    if (!s) return { ok: false, error: '服务器不存在' };
    let client = null;
    try {
      client = await this.#connectOne(s);
      const tools = await client.listTools();
      return { ok: true, serverInfo: client.serverInfo, tools: tools.map((t) => t.name) };
    } catch (e) {
      return { ...(e instanceof McpAuthError ? { needsAuth: true, oauthChallenge: e.challenge } : {}), ok: false, error: String(e?.message || e) };
    } finally {
      try { client?.close(); } catch {}
    }
  }

  #wrap(server, def, client) {
    const name = mcpToolName(server.id, def.name);
    return {
      name,
      description: `[MCP:${server.name || server.id}] ${def.description || def.name}`,
      action: name,
      parameters: def.inputSchema && typeof def.inputSchema === 'object' && def.inputSchema.type
        ? def.inputSchema
        : { type: 'object', properties: {} },
      run: async (args) => callResultText(await client.callTool(def.name, args || {})),
    };
  }

  /** 发起 OAuth 授权：返回让用户去浏览器打开的 URL（授权码由用户粘贴回来） */
  async oauthStart(id) {
    const s = this.servers.find((x) => x.id === String(id || ''));
    if (!s) return { ok: false, error: '服务器不存在' };
    try {
      const { authorizationUrl, state } = await this.oauth.start(s, s.id);
      return { ok: true, authorizationUrl, state, redirectUri: String(s.oauth?.redirectUri || '') };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  /** 用户粘贴授权码回来：state 校验 + 换令牌 + 落盘 */
  async oauthComplete(id, code, state) {
    const s = this.servers.find((x) => x.id === String(id || ''));
    if (!s) return { ok: false, error: '服务器不存在' };
    try {
      const status = await this.oauth.complete(s, s.id, code, state);
      await this.refresh(); // 授权后立刻重连：工具马上可用，不用用户再点一次
      return { ok: true, oauth: status };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  /** 撤销授权（删令牌，下次连接重新走流程） */
  oauthRevoke(id) {
    return { ok: true, removed: this.oauth.revoke(id) };
  }

  /** 状态快照：/api/mcp 与终端 /mcp 共用 */
  status() {
    return this.servers.map((s) => {
      const c = this.connections.get(s.id) || {};
      return {
        id: s.id,
        name: s.name || s.id,
        transport: s.transport,
        enabled: s.enabled !== false,
        connected: Boolean(c.client),
        error: c.error || '',
        tools: c.toolCount || 0,
        serverInfo: c.serverInfo || null,
        // 需要授权时给出去授权的入口信息（授权码流程见 util/mcp/oauth.mjs）
        ...(c.needsAuth ? { needsAuth: true, oauth: this.oauth.status(s.id) } : {}),
      };
    });
  }
}
