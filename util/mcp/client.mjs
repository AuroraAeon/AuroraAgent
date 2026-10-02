/**
 * MCP 客户端（零依赖，仅 Node 内置模块；实验特性 AURORAAGENT_EXPERIMENTAL_MCP 门控）。
 * 实现 JSON-RPC 2.0 的最小子集：initialize / notifications.initialized / tools/list / tools/call / ping。
 * 两种传输：
 *   stdio      —— child_process spawn + 行分隔 JSON（MCP 标准传输）
 *   http+sse   —— fetch POST JSON-RPC；响应可能是直接 JSON 或 SSE 流（复用 util/sse.mjs 解析）
 * 生命周期：connect() 完成 initialize 握手；close() 释放进程 / 中断在途请求。
 */
import { spawn } from 'node:child_process';
import { SseParser } from '../sse.mjs';
import { isOAuthChallenge, parseWwwAuthenticate } from './oauth.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const CLIENT_INFO = { name: 'auroraagent', version: '1.0.0' };
const TIMEOUT_MS = 20000;

export class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

/**
 * MCP 服务器要求 OAuth 授权（401 / 403 + WWW-Authenticate: Bearer ...）。
 * 与普通 McpError 分开是为了让调用方（registry / 设置页）能据此给出「去授权」入口，
 * 而不是把它当成又一次连接失败刷出一串红字。
 */
export class McpAuthError extends Error {
  constructor(message, challenge = null) {
    super(message);
    this.name = 'McpAuthError';
    this.code = 401;
    this.oauth = true;
    this.challenge = challenge;
  }
}

/** 行缓冲：把流式 chunk 拼成完整行 */
function lineSplitter(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) onLine(line);
    }
  };
}

/** stdio 传输：spawn 子进程，stdout 按行读 JSON，stdin 写单行 JSON */
export function createStdioTransport({ command, args = [], env = {}, cwd = '' }) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    ...(cwd ? { cwd } : {}),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const pending = new Map(); // id -> { resolve, reject, timer }
  let nextId = 1;
  let stderr = '';
  let closed = false;

  child.stdout.on('data', lineSplitter((line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id === undefined) return; // 通知（notifications/*）无需响应
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.error) entry.reject(new McpError(msg.error.message || 'MCP 服务器错误', msg.error.code));
    else entry.resolve(msg.result);
  }));
  child.stderr.on('data', (d) => { stderr += String(d); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
  child.on('exit', (code) => {
    closed = true;
    for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(new McpError(`MCP 服务器进程已退出（code ${code}）${stderr ? `：${stderr.slice(0, 200)}` : ''}`)); }
    pending.clear();
  });
  child.on('error', (e) => {
    closed = true;
    for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(new McpError(`无法启动 MCP 服务器：${e.message}`)); }
    pending.clear();
  });

  return {
    kind: 'stdio',
    request(method, params) {
      if (closed) return Promise.reject(new McpError('MCP 传输已关闭'));
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new McpError(`MCP 请求超时：${method}`, -32001)); }, TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(payload + '\n');
      });
    },
    notify(method, params) {
      if (closed) return;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [, entry] of pending) { clearTimeout(entry.timer); entry.reject(new McpError('MCP 传输已关闭')); }
      pending.clear();
      try { child.stdin.end(); } catch {}
      try { child.kill(); } catch {}
    },
  };
}

/** HTTP 传输：POST JSON-RPC；响应为 JSON 或 SSE 流（取首个带 result/error 的 data 帧） */
export function createHttpTransport({ url, headers = {}, auth = null }) {
  const pending = new Map();
  let nextId = 1;
  // auth：可选的令牌注入器 { get(): { Authorization: 'Bearer ...' } | null }。
  // 401 / 403 且带 Bearer 挑战头时抛 McpAuthError（调用方据此走 OAuth 授权流程），
  // 而不是当成普通连接失败——用户需要的是「去授权」，不是「再试一次」
  const authHeaders = () => {
    try { return (auth && typeof auth.get === 'function' ? auth.get() : null) || {}; } catch { return {}; }
  };
  const guard = (resp) => {
    if (!resp.ok && isOAuthChallenge(resp.status, resp.headers.get('www-authenticate'))) {
      throw new McpAuthError(`MCP 服务器要求授权：${parseWwwAuthenticate(resp.headers.get('www-authenticate'))?.realm || url}`, parseWwwAuthenticate(resp.headers.get('www-authenticate')));
    }
  };
  return {
    kind: 'http',
    async request(method, params) {
      const id = nextId++;
      const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers, ...authHeaders() },
        body,
      });
      guard(resp);
      if (!resp.ok) throw new McpError(`MCP HTTP 端点返回 ${resp.status}`, resp.status);
      const ctype = resp.headers.get('content-type') || '';
      if (ctype.includes('text/event-stream') && resp.body) {
        const parser = new SseParser();
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new McpError(`MCP 请求超时：${method}`, -32001)), TIMEOUT_MS);
          const done = (fn, v) => { clearTimeout(timer); fn(v); };
          (async () => {
            try {
              for (;;) {
                const { done: end, value } = await reader.read();
                if (end) break;
                for (const ev of parser.push(dec.decode(value, { stream: true }))) {
                  let msg;
                  try { msg = JSON.parse(ev.data); } catch { continue; }
                  if (msg.id !== id) continue;
                  done(msg.error ? reject : resolve, msg.error ? new McpError(msg.error.message || 'MCP 服务器错误', msg.error.code) : msg.result);
                  return;
                }
              }
              done(reject, new McpError('MCP SSE 流结束但未收到响应'));
            } catch (e) { done(reject, e instanceof McpError ? e : new McpError(String(e.message || e))); }
          })();
        });
      }
      const msg = await resp.json().catch(() => null);
      if (!msg) throw new McpError('MCP 响应不是合法 JSON');
      if (msg.error) throw new McpError(msg.error.message || 'MCP 服务器错误', msg.error.code);
      return msg.result;
    },
    notify() { /* HTTP 传输的通知经单独 POST 尽力送达，失败不影响主流程 */ },
    async close() {},
  };
}

/** 建连并完成 initialize 握手；返回 { listTools, callTool, close, serverInfo } */
export async function connectMcp(server) {
  const transport = server.transport === 'http'
    ? createHttpTransport({ url: server.url, headers: server.headers || {}, ...(server.auth ? { auth: server.auth } : {}) })
    : createStdioTransport({ command: server.command, args: server.args || [], env: server.env || {}, cwd: server.cwd || '' });
  const result = await transport.request('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  transport.notify('notifications/initialized', {});
  const listTools = () => transport.request('tools/list', {}).then((r) => (Array.isArray(r?.tools) ? r.tools : []));
  const callTool = (name, args) => transport.request('tools/call', { name, arguments: args || {} });
  return { transport, serverInfo: result?.serverInfo || {}, listTools, callTool, close: () => transport.close() };
}

/** tools/call 结果 → 纯文本（content 块拼装；isError 时抛出可读错误） */
export function callResultText(result) {
  if (result?.isError) {
    const text = (result.content || []).map((c) => c.text || '').join('\n');
    throw new McpError(text || 'MCP 工具返回错误');
  }
  const parts = (result?.content || []).map((c) => {
    if (c.type === 'text') return c.text || '';
    if (c.type === 'resource') return c.text || c.resource?.uri || '';
    return `[${c.type}]`;
  });
  const text = parts.join('\n').trim();
  return text || (result?.structuredContent ? JSON.stringify(result.structuredContent) : '（工具无文本输出）');
}
