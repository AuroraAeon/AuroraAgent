/**
 * 本机代理输入的客户端预校验（零依赖纯函数，与服务端 parseAgentProxy 同规约）：
 * 空 = 直连（合法）；http://主机:端口 或裸 主机:端口；拒绝 socks5 等其它协议与越界端口。
 * 返回 '' 表示合法，否则为可直接展示的中文错误消息。
 */
export function validateProxyInput(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^socks/i.test(s)) return '暂不支持 socks5 代理，请填 http 代理（如 http://127.0.0.1:7890）';
  const m = /^(?:http:\/\/)?([^\s/:]+):(\d{1,5})$/.exec(s);
  if (!m) return '应为 http://主机:端口（如 http://127.0.0.1:7890），留空表示直连';
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return '端口应在 1–65535 之间';
  return '';
}
