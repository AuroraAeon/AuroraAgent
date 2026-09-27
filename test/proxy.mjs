/**
 * 本机代理单测（util/proxy.mjs + web-ui/src/proxy-input.ts）：
 * 地址归一化 / 正向代理抓取 / 重定向 / 拒绝连接的友好错误 / CONNECT 被拒 / web_fetch 经 ctx.proxy 出站。
 * 抓取用例全部打本机真实 socket（源站 + 转发代理都是测试内临时服务），不碰外网。
 */
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createServer as netCreateServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAgentProxy, proxyFetch } from '../util/proxy.mjs';
import { getTool } from '../util/agent/tools.mjs';
import { validateProxyInput } from '../web-ui/src/proxy-input.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 测试夹具：源站（/ok 正文、/redirect 302）+ 正向代理（认绝对 URI）+ 假隧道代理（CONNECT 一律 403） */
export async function startFetchFixtures() {
  const origin = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ORIGIN-OK 正文内容');
  });
  await new Promise((r) => origin.listen(0, '127.0.0.1', r));
  const originPort = origin.address().port;
  const proxy = createServer((req, res) => {
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400); res.end('proxy expects absolute uri'); return; }
    const up = (target.protocol === 'https:' ? httpsRequest : httpRequest)({ host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: 'GET', headers: { ...req.headers, host: target.host } }, (pr) => {
      res.writeHead(pr.statusCode, pr.headers);
      pr.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end('bad gateway'); });
    up.end();
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyPort = proxy.address().port;
  const tunnel = netCreateServer((sock) => { sock.once('data', () => sock.end('HTTP/1.1 403 Forbidden\r\n\r\n')); });
  await new Promise((r) => tunnel.listen(0, '127.0.0.1', r));
  const tunnelPort = tunnel.address().port;
  // 关闭端口：先占后放，拿到一个几乎必然无人监听端口（验证 ECONNREFUSED 文案）
  const closed = createServer();
  await new Promise((r) => closed.listen(0, '127.0.0.1', r));
  const closedPort = closed.address().port;
  await new Promise((r) => closed.close(r));
  return {
    originPort, proxyPort, tunnelPort, closedPort,
    close: () => { origin.close(); proxy.close(); tunnel.close(); },
  };
}

export async function runProxyTests(test, assert, eq) {
  console.log('\n本机代理单测');

  await test('proxy: parseAgentProxy 归一化与坏值拒绝', () => {
    eq(parseAgentProxy(''), '', '空 = 直连');
    eq(parseAgentProxy('   '), '', '纯空白 = 直连');
    eq(parseAgentProxy('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
    eq(parseAgentProxy('127.0.0.1:7890'), 'http://127.0.0.1:7890', '裸 host:port 补 http://');
    eq(parseAgentProxy('localhost:7890'), 'http://localhost:7890');
    eq(parseAgentProxy('HTTP://127.0.0.1:80'), 'http://127.0.0.1:80', '协议大小写不敏感');
    eq(parseAgentProxy('socks5://127.0.0.1:7890'), null, 'socks5 暂不支持');
    eq(parseAgentProxy('https://127.0.0.1:7890'), null, '代理本身只支持 http');
    eq(parseAgentProxy('http://127.0.0.1:99999'), null, '端口越界');
    eq(parseAgentProxy('http://127.0.0.1:0'), null, '端口 0 非法');
    eq(parseAgentProxy('这不是地址'), null, '非 ASCII 主机名拒绝');
    eq(parseAgentProxy('hello'), 'http://hello:80', '裸主机名补 http 与缺省端口');
    eq(parseAgentProxy(null), '', '缺省直连');
  });

  await test('proxy-input: 客户端预校验与服务端同规约', () => {
    eq(validateProxyInput(''), '');
    eq(validateProxyInput('http://127.0.0.1:7890'), '');
    eq(validateProxyInput('127.0.0.1:7890'), '');
    assert(validateProxyInput('socks5://127.0.0.1:7890').includes('socks5'), 'socks5 应被拒绝并说明');
    assert(validateProxyInput('hello').includes('http://'), '坏值应给出格式提示');
    assert(validateProxyInput('127.0.0.1:99999').includes('端口'), '端口越界应提示');
  });

  const fx = await startFetchFixtures();
  try {
    await test('proxy: proxyFetch 经正向代理抓取 http 目标', async () => {
      const resp = await proxyFetch(`http://127.0.0.1:${fx.originPort}/ok`, `http://127.0.0.1:${fx.proxyPort}`);
      eq(resp.status, 200);
      eq(await resp.text(), 'ORIGIN-OK 正文内容');
    });

    await test('proxy: proxyFetch 跟随重定向（封顶 5 跳）', async () => {
      const resp = await proxyFetch(`http://127.0.0.1:${fx.originPort}/redirect`, `127.0.0.1:${fx.proxyPort}`);
      eq(resp.status, 200, '应跟到 302 落地页');
      eq(await resp.text(), 'ORIGIN-OK 正文内容');
    });

    await test('proxy: 代理拒绝连接时错误消息说清下一步', async () => {
      let err = null;
      try { await proxyFetch(`http://127.0.0.1:${fx.originPort}/ok`, `http://127.0.0.1:${fx.closedPort}`); } catch (e) { err = e; }
      assert(err && new RegExp(`代理 127\\.0\\.0\\.1:${fx.closedPort} 拒绝连接`).test(err.message), `应提示代理拒绝连接，实际：${err && err.message}`);
      assert(err.message.includes('代理软件'), '应提示检查代理软件');
    });

    await test('proxy: https 目标 CONNECT 被拒时错误消息带走 Host:Port', async () => {
      let err = null;
      try { await proxyFetch('https://example.com/', `http://127.0.0.1:${fx.tunnelPort}`); } catch (e) { err = e; }
      assert(err && err.message.includes('代理拒绝 CONNECT example.com:443'), `应提示 CONNECT 被拒，实际：${err && err.message}`);
    });

    await test('web_fetch: ctx.proxy 在场时经代理出站（维基百科类场景的出路）', async () => {
      const out = await getTool('web_fetch').run({ url: `http://127.0.0.1:${fx.originPort}/wiki` }, { proxy: `http://127.0.0.1:${fx.proxyPort}` });
      assert(out.startsWith('HTTP 200'), `应拿到 200，实际：${out.slice(0, 80)}`);
      assert(out.includes('ORIGIN-OK'), '正文应经代理取回');
    });

    await test('web_fetch: 未配置代理时保持直连（行为不变）', async () => {
      const out = await getTool('web_fetch').run({ url: `http://127.0.0.1:${fx.originPort}/direct` }, {});
      assert(out.startsWith('HTTP 200') && out.includes('ORIGIN-OK'), '直连路径应不变');
    });

    await test('web_fetch: 代理不可达时工具错误带可读原因', async () => {
      let err = null;
      try { await getTool('web_fetch').run({ url: `http://127.0.0.1:${fx.originPort}/x` }, { proxy: `http://127.0.0.1:${fx.closedPort}` }); } catch (e) { err = e; }
      assert(err && err.code === 'fetch_error' && err.message.includes('抓取失败') && err.message.includes('代理'), `错误应说清代理问题，实际：${err && err.message}`);
    });
  } finally {
    fx.close();
  }

  await test('代理接线源码契约：工具 / 路由 / 前端面板在场', () => {
    const tools = readFileSync(join(ROOT, 'util', 'agent', 'tools.mjs'), 'utf8');
    assert(tools.includes('ctx?.proxy') && tools.includes('proxyFetch(url, proxy'), 'web_fetch 应读 ctx.proxy 并走 proxyFetch');
    const loop = readFileSync(join(ROOT, 'util', 'agent', 'loop.mjs'), 'utf8');
    assert(loop.includes("agentProxy = ''") && loop.includes('proxy: agentProxy'), 'loop 应把 agentProxy 注入工具 ctx');
    const http = readFileSync(join(ROOT, 'util', 'agent', 'http.mjs'), 'utf8');
    assert(http.includes('agentProxy: cfg.agentProxy'), 'Agent HTTP 面应传 cfg.agentProxy');
    const swarm = readFileSync(join(ROOT, 'util', 'agent', 'swarm.mjs'), 'utf8');
    assert(swarm.includes('子代理与父层共用同一条本机代理出站'), '子代理应透传代理');
    const term = readFileSync(join(ROOT, 'util', 'agent', 'terminal-turn.mjs'), 'utf8');
    assert(term.includes('agentProxy: cfg.agentProxy'), '终端 turn 应传 cfg.agentProxy');
    const web = readFileSync(join(ROOT, 'web.mjs'), 'utf8');
    assert(web.includes("url.startsWith('/api/settings/proxy')") && web.includes('handleAgentProxyApi'), 'web.mjs 应委派代理设置路由');
    const cfg = readFileSync(join(ROOT, 'util', 'config.mjs'), 'utf8');
    assert(cfg.includes('agentProxy: parseAgentProxy(saved.agentProxy'), 'loadConfig 应归一化 agentProxy');
    const api = readFileSync(join(ROOT, 'web-ui', 'src', 'api.ts'), 'utf8');
    assert(api.includes('/api/settings/proxy') && api.includes('setAgentProxy'), '前端 api 应读写代理设置');
    const dlg = readFileSync(join(ROOT, 'web-ui', 'src', 'components', 'SettingsDialog.tsx'), 'utf8');
    assert(dlg.includes('<ProxyPanel />'), '设置弹层应挂载网络面板');
    const panel = readFileSync(join(ROOT, 'web-ui', 'src', 'components', 'ProxyPanel.tsx'), 'utf8');
    assert(panel.includes('validateProxyInput') && panel.includes('getAgentProxy'), '网络面板应有校验与读写');
  });
}
