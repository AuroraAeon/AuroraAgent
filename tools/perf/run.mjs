#!/usr/bin/env node
/**
 * 性能基准运行器（零依赖）：按场景各起一份 mock 上游 + 临时数据目录的 web.mjs
 * → 驱动场景 → 采样 wall / CPU / peak-RSS → 落 JSON + Markdown 报告。
 *
 * 用法:
 *   node tools/perf/run.mjs [--suite smoke|basic|full] [--scenario <id>] [--out <dir>] [--label <名>]
 *   npm run bench           # basic 套件
 *   npm run bench:smoke     # 仅 startup，断言退出 0 且产出 JSON
 *
 * 定位：本地回归参考，不是 CI 门禁——数字随机器与负载波动，只与「自己历史的基线」比。
 * 每个场景独立进程对（冷启动），场景间互不污染；CPU 采样依赖 process.resourceUsage
 * （Node 18.16+，单位微秒），不可用时该列记 null 而非造假。
 */
import { spawn, execSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { startPerfMock } from './mock-upstream.mjs';
import { scenariosOfSuite, SCENARIOS } from './scenarios.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function parseArgs(argv) {
  const out = { suite: 'basic', scenario: '', outDir: '', label: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--suite') out.suite = argv[++i];
    else if (a === '--scenario') out.scenario = argv[++i];
    else if (a === '--out') out.outDir = argv[++i];
    else if (a === '--label') out.label = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

/** 取一个空闲端口（listen 0 后立刻关，端口让给被测服务） */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    setTimeout(() => reject(new Error('获取空闲端口超时')), 5000);
  });
}

/** 采样子进程峰值 RSS（KB→MiB）；ps 不可用时记 null 而非 0 */
function startRssSampler(pid) {
  const sampler = { peakKb: 0, stop: () => {} };
  const timer = setInterval(() => {
    try {
      const out = execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8', timeout: 1000 }).trim();
      const kb = Number(out.split('\n')[0]);
      if (Number.isFinite(kb) && kb > sampler.peakKb) sampler.peakKb = kb;
    } catch { /* 进程已退出或 ps 不可用：忽略本次采样 */ }
  }, 50);
  sampler.stop = () => clearInterval(timer);
  return sampler;
}

async function waitHealth(base, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return Date.now() - t0;
    } catch {}
    if (Date.now() - t0 > timeoutMs) throw new Error('web.mjs 健康检查超时');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 读完整 SSE 流，统计字节与帧数；until 命中即停（agent 场景等 turn_completed） */
async function readAll(resp, { until } = {}) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let bytes = 0, frames = 0, tail = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    const chunk = dec.decode(value, { stream: true });
    frames += (chunk.match(/\n\n/g) || []).length;
    if (until) {
      tail += chunk;
      if (tail.includes(`event: ${until}\n`)) break;
    }
  }
  return { bytes, frames };
}

async function driveChat(base, scenario) {
  let bytes = 0, frames = 0;
  const t0 = Date.now();
  for (let i = 0; i < scenario.requests; i++) {
    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'PerfModel-1', messages: [{ role: 'user', content: `第 ${i} 次速测请求` }] }),
    });
    if (!resp.ok) throw new Error(`/api/chat 返回 ${resp.status}`);
    const r = await readAll(resp);
    bytes += r.bytes; frames += r.frames;
  }
  return { wallMs: Date.now() - t0, detail: { requests: scenario.requests, bytes, frames } };
}

async function driveAgent(base, scenario) {
  const mk = await fetch(`${base}/api/agent/sessions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'perf-history', model: 'PerfModel-1', harness: 'ultimate' }),
  });
  const { session } = await mk.json();
  const totalTurns = Math.ceil(scenario.rounds / scenario.roundsPerTurn);
  let bytes = 0, frames = 0;
  const t0 = Date.now();
  for (let t = 0; t < totalTurns; t++) {
    const resp = await fetch(`${base}/api/agent/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, input: `PERF_HISTORY_${t}` }),
    });
    if (!resp.ok) throw new Error(`/api/agent/turn 返回 ${resp.status}`);
    const r = await readAll(resp, { until: 'turn_completed' });
    bytes += r.bytes; frames += r.frames;
  }
  return { wallMs: Date.now() - t0, detail: { turns: totalTurns, targetRounds: scenario.rounds, bytes, frames } };
}

/** 跑一个场景：独立 mock + 独立 web.mjs 进程对，采完即收 */
async function runScenario(sc) {
  const mock = await startPerfMock({ port: 0, ...sc.mock });
  const dataDir = mkdtempSync(join(tmpdir(), 'auroraagent-perf-'));
  const webPort = await freePort();
  const cpuBefore = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null;
  const child = spawn(process.execPath, [join(ROOT, 'web.mjs')], {
    env: {
      ...process.env,
      PORT: String(webPort),
      AURORAAGENT_DATA_DIR: dataDir,
      AURORAAGENT_BASE_URL: `http://127.0.0.1:${mock.port}`,
      AURORAAGENT_API_KEY: 'perf-key',
      NO_OPEN: '1',
      LOG_LEVEL: 'error',
    },
    stdio: 'ignore',
  });
  const sampler = startRssSampler(child.pid);
  const base = `http://127.0.0.1:${webPort}`;
  try {
    const healthWaitMs = await waitHealth(base);
    const detail = { healthWaitMs };
    let wallMs = healthWaitMs;
    if (sc.drive === 'chat') {
      const r = await driveChat(base, sc);
      wallMs = r.wallMs; Object.assign(detail, r.detail);
    } else if (sc.drive === 'agent') {
      const r = await driveAgent(base, sc);
      wallMs = r.wallMs; Object.assign(detail, r.detail);
    }
    sampler.stop();
    const cpuAfter = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null;
    const cpu = cpuBefore && cpuAfter
      ? { userMs: Math.round((cpuAfter.userCPUTime - cpuBefore.userCPUTime) / 100) / 10, systemMs: Math.round((cpuAfter.systemCPUTime - cpuBefore.systemCPUTime) / 100) / 10 }
      : null;
    return {
      id: sc.id, wallMs, detail, cpu,
      peakRssMiB: sampler.peakKb ? Math.round((sampler.peakKb / 1024) * 10) / 10 : null,
      mock: { requests: mock.state.requests, toolRounds: mock.state.toolRounds, bytes: mock.state.bytes },
    };
  } finally {
    sampler.stop();
    try { child.kill('SIGTERM'); } catch {}
    await mock.close();
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}

function fmtMs(ms) { return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log([
      '用法: node tools/perf/run.mjs [--suite smoke|basic|full] [--scenario <id>] [--out <dir>] [--label <名>]',
      '套件: smoke=startup · basic=startup+upstream-100 · full=basic+history-300',
    ].join('\n'));
    return 0;
  }
  const list = args.scenario ? [SCENARIOS[args.scenario]] : scenariosOfSuite(args.suite);
  if (!list[0]) throw new Error(`未知场景: ${args.scenario}`);
  const label = args.label || `bench-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const outDir = args.outDir || join(ROOT, 'docs', 'perf');
  mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const sc of list) {
    process.stdout.write(`场景 ${sc.id} 运行中…\n`);
    rows.push(await runScenario(sc));
  }
  const report = {
    label,
    at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    suite: args.suite,
    scenarios: rows,
  };
  const jsonPath = join(outDir, `${label}.json`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  const mdPath = join(outDir, `${label}.md`);
  const md = [
    `# 性能基准报告 ${label}`,
    '',
    `- 时间: ${report.at}`,
    `- 环境: Node ${report.node} · ${report.platform}`,
    `- 套件: ${args.suite}`,
    '',
    '| 场景 | wall | 峰值 RSS | 子进程 CPU（用户+系统） | 细节 |',
    '| --- | --- | --- | --- | --- |',
    ...rows.map((r) => `| ${r.id} | ${fmtMs(r.wallMs)} | ${r.peakRssMiB == null ? '不可用' : r.peakRssMiB + ' MiB'} | ${r.cpu ? `${r.cpu.userMs} + ${r.cpu.systemMs} ms` : '不可用'} | ${JSON.stringify(r.detail)} |`),
    '',
    '说明: 每场景独立冷启动进程对；数字随机器与负载波动，只与历史基线对比，不作门禁。',
    '',
  ].join('\n');
  writeFileSync(mdPath, md);
  console.log(md);
  console.log(`报告已写入: ${jsonPath}`);
  return 0;
}

process.exitCode = await main();
