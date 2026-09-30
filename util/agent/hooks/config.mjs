/**
 * Hook 目录发现（源头 Cline 的 hook-file-config.ts）：hook 就是「文件名即事件名」的可执行脚本，
 * 不写配置文件、不写注册表——放进目录即生效，删掉即失效。
 * 两个来源（后者同名覆盖前者，项目钩子优先于个人钩子）：
 *   <workspace>/.auroraagent/hooks/PreToolUse.sh   项目钩子（随仓库走，团队共享）
 *   <数据目录>/hooks/PostToolUse.mjs               个人钩子（跨项目常驻）
 * 支持的后缀：无后缀（须可执行）/ .sh / .bash / .zsh / .mjs / .cjs / .js / .py。
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { eventFromFileName } from './events.mjs';

/** 可识别的 hook 脚本后缀 → 解释器（空串 = 文件自身可执行，直接 spawn） */
export const HOOK_INTERPRETERS = {
  '': '',
  '.sh': '/bin/sh',
  '.bash': '/bin/bash',
  '.zsh': '/bin/zsh',
  '.mjs': process.execPath,
  '.cjs': process.execPath,
  '.js': process.execPath,
  '.py': 'python3',
};

/** 递归列举 hooks 目录（深度 1：钩子脚本不放子目录，放子目录的按未见处理） */
function listHookFiles(dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || e.name.startsWith('.')) continue;
    out.push(join(dir, e.name));
  }
  return out;
}

/**
 * 发现 hook 脚本。
 * @param {{ workspace?: string, dataDir?: string }} opts
 * @returns {{ hooks: Array<{event, path, interpreter, source}>, warnings: string[] }}
 */
export function discoverHooks({ workspace = '', dataDir = '' } = {}) {
  const warnings = [];
  const sources = [];
  if (dataDir) sources.push({ dir: join(resolve(dataDir), 'hooks'), source: 'data' });
  if (workspace) sources.push({ dir: join(resolve(workspace), '.auroraagent', 'hooks'), source: 'workspace' });

  // 顺序即优先级：先个人后项目，同名（同事件）时后写的覆盖先写的
  const byEvent = new Map();
  for (const s of sources) {
    if (!existsSync(s.dir)) continue;
    for (const abs of listHookFiles(s.dir)) {
      const ext = abs.slice(abs.lastIndexOf('.')).toLowerCase();
      if (!(ext in HOOK_INTERPRETERS)) { warnings.push(`hook 后缀不支持，已跳过：${abs}`); continue; }
      const event = eventFromFileName(abs.slice(abs.lastIndexOf('/') + 1));
      if (!event) { warnings.push(`hook 文件名不是已知事件，已跳过：${abs}`); continue; }
      if (!ext) {
        // 无后缀必须是可执行文件：否则用户放个 README 进来也会被当脚本跑
        try { if (!statSync(abs).mode & 0o111) { warnings.push(`hook 无后缀但不可执行，已跳过：${abs}`); continue; } } catch { continue; }
      }
      if (byEvent.has(event)) warnings.push(`事件 ${event} 在多个目录有 hook，项目钩子优先：${abs}`);
      byEvent.set(event, { event, path: abs, interpreter: HOOK_INTERPRETERS[ext], source: s.source });
    }
  }
  return { hooks: [...byEvent.values()], warnings };
}
