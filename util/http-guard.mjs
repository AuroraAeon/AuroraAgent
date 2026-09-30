/**
 * 本地请求守卫：所有 /api/* 入口的第一道闸（防 DNS rebinding 与跨站表单 / fetch 滥用）。
 *
 * 威胁模型：AuroraAgent 是绑在本机回环上的服务，HTTP 面能读会话全文、改提供方 Key、
 * 派发 Agent。任何本机浏览器里的恶意页面都想来敲这门：
 *   - DNS rebinding：攻击者域名先解析到自己的服务器投递恶意页，再改解析到 127.0.0.1，
 *     之后页面里的 fetch 带着 Host: evil.com 打到本地服务——按 Host 白名单拒绝；
 *   - 跨站 fetch / 表单：浏览器会带 Origin: https://evil.com——按同源白名单拒绝；
 *   - 不带 Origin 的跨站提交（表单导航 / 部分旧浏览器）：Sec-Fetch-Site: cross-site 拒绝。
 * 三项都不命中才放行。豁免路径只有健康检查（LaunchAgent 探活与设置页状态灯要用）。
 *
 * 纯函数 + 返回拒绝描述，不碰 res：web.mjs 统一负责回 403 与记 errorlog，
 * 测试可直接对假 req 断言三种拒绝原因。
 */

/** 默认豁免：健康检查不拦（端口探活 / 状态轮询） */
export const DEFAULT_PUBLIC_PATHS = ['/api/health'];
/** 拒绝响应体（客户端一眼可辨是守卫拦的，不是业务错误） */
const FORBIDDEN_BODY = { error: 'forbidden_origin' };

/** 合法 Host：回环字面量 + 当前端口（端口不猜，按服务实际监听端口传） */
function allowedHosts(port) {
  return new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
}

/** 合法 Origin：上述三种 Host 的 http 形态（https 形态本服务不提供，一律拒） */
function allowedOrigins(port) {
  return new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
}

function deny(reason) {
  return { status: 403, body: { ...FORBIDDEN_BODY, reason } };
}

/**
 * 判定请求是否放行。
 * @param {import('node:http').IncomingMessage} req
 * @param {{ port: number, publicPaths?: string[] }} opts
 * @returns {null | { status: number, body: { error: string, reason: string } }} null = 放行
 */
export function guardRequest(req, { port, publicPaths = DEFAULT_PUBLIC_PATHS } = {}) {
  const p = Number(port) || 0;
  const url = String(req?.url || '').split('?')[0];
  if (publicPaths.includes(url)) return null;
  const headers = req?.headers || {};
  // 1) Host 必须命中回环白名单：挡掉 DNS rebinding（Host 是攻击者域名）
  const host = String(headers.host || '').trim().toLowerCase();
  if (!allowedHosts(p).has(host)) return deny('host');
  // 2) 有 Origin 就必须同源：挡掉跨站 fetch / XHR（含 https 形态的伪造源）
  const origin = String(headers.origin || '').trim().toLowerCase();
  if (origin) {
    if (!allowedOrigins(p).has(origin)) return deny('origin');
    return null;
  }
  // 3) 无 Origin 但显式声明跨站（表单提交 / 导航）：同样拒
  if (String(headers['sec-fetch-site'] || '').trim().toLowerCase() === 'cross-site') return deny('sec_fetch_site');
  return null;
}
