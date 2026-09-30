/**
 * 本地请求守卫单元测试（util/http-guard.mjs）：
 * Origin 缺失 / 异源 / Sec-Fetch-Site cross-site / Host 伪造 / 豁免路径五类断言。
 * 纯函数断言，不起服务；对真实服务的 raw socket 断言在 run-tests.mjs 的服务端段落。
 */
import { guardRequest, DEFAULT_PUBLIC_PATHS } from '../util/http-guard.mjs';

const PORT = 8787;
const req = (headers, url = '/api/agent/sessions') => ({ method: 'POST', url, headers });

export async function runHttpGuardTests(test, assert, eq) {
  console.log('\n本地请求守卫单元测试');

  await test('http-guard: 回环 Host 且无 Origin 放行（终端 / Node fetch 形态）', () => {
    eq(guardRequest(req({ host: '127.0.0.1:8787' }), { port: PORT }), null, '127.0.0.1 + 端口应放行');
    eq(guardRequest(req({ host: 'localhost:8787' }), { port: PORT }), null, 'localhost + 端口应放行');
    eq(guardRequest(req({ host: '[::1]:8787' }), { port: PORT }), null, 'IPv6 回环 + 端口应放行');
  });

  await test('http-guard: 同源 Origin 放行，异源 Origin 拒绝', () => {
    eq(guardRequest(req({ host: 'localhost:8787', origin: 'http://localhost:8787' }), { port: PORT }), null, '同源应放行');
    eq(guardRequest(req({ host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787' }), { port: PORT }), null, '同源另一形态应放行');
    const bad = guardRequest(req({ host: 'localhost:8787', origin: 'https://evil.com' }), { port: PORT });
    eq(bad?.status, 403, '异源应 403');
    eq(bad?.body.error, 'forbidden_origin', '拒绝话体固定');
    eq(bad?.body.reason, 'origin', '原因应是 origin');
    const httpsLocal = guardRequest(req({ host: 'localhost:8787', origin: 'https://localhost:8787' }), { port: PORT });
    eq(httpsLocal?.body.reason, 'origin', '本服务不提供 https 形态，同端口 https 源也算异源');
  });

  await test('http-guard: 无 Origin 但 Sec-Fetch-Site: cross-site 拒绝（表单 / 导航形态）', () => {
    const r = guardRequest(req({ host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }), { port: PORT });
    eq(r?.status, 403);
    eq(r?.body.reason, 'sec_fetch_site');
    eq(guardRequest(req({ host: '127.0.0.1:8787', 'sec-fetch-site': 'same-origin' }), { port: PORT }), null, 'same-origin 放行');
    eq(guardRequest(req({ host: '127.0.0.1:8787', 'sec-fetch-site': 'none' }), { port: PORT }), null, 'none（地址栏直开）放行');
  });

  await test('http-guard: Host 伪造拒绝（DNS rebinding：Host 是攻击者域名）', () => {
    for (const host of ['evil.com', 'evil.com:8787', '127.0.0.1:9999', 'localhost:9999', '', 'auroraagent.internal:8787']) {
      const r = guardRequest(req({ host }), { port: PORT });
      eq(r?.status, 403, `Host ${host || '(空)'} 应 403`);
      eq(r?.body.reason, 'host', `Host ${host || '(空)'} 的原因应是 host`);
    }
  });

  await test('http-guard: 豁免路径不拦（健康检查），且默认豁免只此一条', () => {
    eq(guardRequest(req({ host: 'evil.com' }, '/api/health'), { port: PORT }), null, '豁免路径即使 Host 坏也放行');
    eq(JSON.stringify(DEFAULT_PUBLIC_PATHS), JSON.stringify(['/api/health']), '默认豁免仅 /api/health');
    const custom = guardRequest(req({ host: 'evil.com' }, '/api/status'), { port: PORT, publicPaths: ['/api/status'] });
    eq(custom, null, '调用方可显式扩大豁免（测试 / 内部探活用）');
    assert(guardRequest(req({ host: 'evil.com' }, '/api/agent/sessions'), { port: PORT }) !== null, '非豁免路径照拦');
  });

  await test('http-guard: 查询串不影响路径判定，端口缺参按 0 处理（全部拒绝）', () => {
    eq(guardRequest(req({ host: 'evil.com' }, '/api/health?x=1'), { port: PORT }), null, '带查询串的豁免路径仍豁免');
    eq(guardRequest(req({ host: '127.0.0.1:8787' }), { port: 0 })?.body.reason, 'host', '端口缺参（0）时任何带端口 Host 都不命中，一律拒绝');
    eq(guardRequest(req({}), { port: PORT })?.body.reason, 'host', '无 Host 头按 host 拒绝');
  });
}
