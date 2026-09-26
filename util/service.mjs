/**
 * LaunchAgent 生命周期（仅 macOS）：安装 / 卸载 / 状态查询。
 * plist 生成规则与 tools/install-service.mjs 保持一致：日志固定落 ~/Library/Logs，
 * 避免 launchd 打不开 ~/Documents 等 TCC 保护目录里的重定向文件（exit 78 EX_CONFIG）。
 * 端口冲突（EADDRINUSE）重试逻辑仍留在 web.mjs，不在此模块。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync } from 'node:child_process';

export const SERVICE_LABEL = 'com.modeltester.app';
export const SERVICE_DOMAIN = `gui/${process.getuid()}`;
export const PLIST_PATH = join(homedir(), 'Library/LaunchAgents', `${SERVICE_LABEL}.plist`);
export const SERVICE_LOG = join(homedir(), 'Library/Logs', `${SERVICE_LABEL}.log`);

const sh = (cmd) => {
  try { return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { return `${e.stdout || ''}${e.stderr || ''}`; }
};

/** launchd 里本服务的 pid；未安装/未运行返回 0 */
export function servicePid() {
  const out = sh(`launchctl print ${SERVICE_DOMAIN}/${SERVICE_LABEL} 2>/dev/null`);
  const m = out.match(/^\s*pid\s*=\s*(\d+)\s*$/m);
  return m ? Number(m[1]) : 0;
}

/** 当前进程是否正由 LaunchAgent 托管（切换自启时决定能否安全 bootout） */
export const isManaged = () => servicePid() === process.pid;

/** plist 是否已安装（设置页「开机自启」开关的语义） */
export const autostartInstalled = () => existsSync(PLIST_PATH);
