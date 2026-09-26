#!/usr/bin/env node
/**
 * 把 ModelTester 安装为 macOS LaunchAgent（开机自启 + 崩溃自恢复）。
 *   node tools/install-service.mjs            安装并启动
 *   node tools/install-service.mjs --status   查看运行状态
 *   node tools/install-service.mjs --remove   停止并卸载
 * 换到任何目录后都可重新执行本脚本，路径会自动按当前所在位置生成。
 *
 * 两个关键约定：
 * 1. 日志必须放 ~/Library/Logs——App 若位于 ~/Documents 等 TCC 隐私保护目录，
 *    launchd 无权打开其中的文件做 stdout 重定向，job 会以 exit 78 (EX_CONFIG) 反复失败。
 * 2. 数据目录通过 MODELTESTER_DATA_DIR 显式指定（默认 App 目录）；独立 App 打包时
 *    设置为 ~/Library/Application Support/ModelTester，与 App  Bundle 解耦。
 */
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LABEL = 'com.modeltester.app';
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid()}`;
const NODE = process.execPath;
const LOG = join(homedir(), 'Library/Logs', `${LABEL}.log`);
// 数据目录三级回退：env → ROOT 已有 config（源码态）→ ~/Library/Application Support/ModelTester（App 态）
const DATA_DIR = process.env.MODELTESTER_DATA_DIR ||
  (existsSync(join(ROOT, 'modeltester.config.json')) ? ROOT : join(homedir(), 'Library', 'Application Support', 'ModelTester'));
const PORT = 8787;

const sh = (cmd) => {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
};

const health = () => sh(`curl -s --max-time 3 http://localhost:${PORT}/api/health`).trim();

if (process.argv.includes('--remove')) {
  sh(`launchctl bootout ${DOMAIN}/${LABEL}`);
  if (existsSync(PLIST)) unlinkSync(PLIST);
  console.log(`已卸载 ${LABEL}（数据与配置保留在 ${DATA_DIR}）`);
  process.exit(0);
}

if (process.argv.includes('--status')) {
  const out = sh(`launchctl print ${DOMAIN}/${LABEL}`);
  const line = out.split('\n').filter((l) => /state|program|pid|last exit/i.test(l)).slice(0, 6).join('\n');
  console.log(line.trim() || `未安装（执行 node tools/install-service.mjs 安装）`);
  const h = health();
  console.log(h ? `health: ${h}` : 'health: 无响应');
  process.exit(0);
}

mkdirSync(dirname(PLIST), { recursive: true });
writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>web.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MODELTESTER_DATA_DIR</key><string>${DATA_DIR}</string>
    <key>NO_OPEN</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`);
sh(`launchctl bootout ${DOMAIN}/${LABEL}`);
// bootout 运行中的 job 后立即 bootstrap 会偶发 Input/output error，稍等再装
await new Promise((r) => setTimeout(r, 800));
const boot = sh(`launchctl bootstrap ${DOMAIN} ${PLIST}`);
if (boot.trim()) console.log(boot.trim());
sh(`launchctl kickstart -k ${DOMAIN}/${LABEL}`);

// 安装后自检：等最多 5 秒，确认服务真正起来
let ok = '';
for (let i = 0; i < 10 && !ok; i++) {
  await new Promise((r) => setTimeout(r, 500));
  ok = health();
}
console.log(`已安装 ${LABEL}`);
console.log(`  目录  ${ROOT}`);
console.log(`  数据  ${DATA_DIR}`);
console.log(`  服务  ${PLIST}`);
console.log(`  日志  ${LOG}`);
if (ok) {
  console.log(`  访问  http://localhost:${PORT}  (health: ${ok})`);
} else {
  console.log(`  [!] 服务未响应，请检查日志: ${LOG}`);
  process.exitCode = 1;
}
