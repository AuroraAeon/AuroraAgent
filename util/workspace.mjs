/**
 * 工作区上下文（只读）：Header 工作区卡片的数据源——工作目录、主目录（路径缩写用）、
 * git 分支（零依赖直读 .git/HEAD，不调 git 命令）。移植 ZCode 工作区系统模式：
 * Header 常驻展示 workspace 上下文，会话（task）是工作区里的执行单元。
 *   - readWorkspaceInfo：路径校验 + home + git 分支解析（含 worktree 的 .git 文件形态）
 *   - handleWorkspaceApi：GET /api/workspace?path=<绝对路径>（web.mjs 一行委派）
 * 说明：不统计 dirty 文件数（要读 index，零依赖成本过高）；ZCode 的 gitDirtyFileCount
 * 由其桌面端 git service 提供，Web 端同样只展示分支。
 */
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/**
 * git 分支解析：目录形态读 .git/HEAD；worktree / submodule 的 .git 是文件，
 * 内容形如 `gitdir: /path/to/real/.git/worktrees/<name>`，跟一指再读。
 * @returns {{ isGit: boolean, branch: string|null }}
 */
export function readGitBranch(workspace) {
  const gitPath = join(workspace, '.git');
  let headFile = null;
  try {
    const st = statSync(gitPath);
    if (st.isDirectory()) {
      headFile = join(gitPath, 'HEAD');
    } else if (st.isFile()) {
      const pointer = readFileSync(gitPath, 'utf8').trim();
      const m = /^gitdir:\s*(.+)$/m.exec(pointer);
      if (m) headFile = join(resolve(workspace, m[1].trim()), 'HEAD');
    }
  } catch { /* 没有 .git 或读不动：按非 git 目录处理 */ }
  if (!headFile) return { isGit: false, branch: null };
  try {
    const head = readFileSync(headFile, 'utf8').trim();
    if (/^ref:\s*refs\/heads\//.test(head)) return { isGit: true, branch: head.replace(/^ref:\s*refs\/heads\//, '') };
    // detached HEAD：内容是裸 SHA，取短名
    return { isGit: true, branch: head ? head.slice(0, 7) : null };
  } catch { /* HEAD 读不动：仍是 git 目录但分支未知 */ }
  return { isGit: true, branch: null };
}

/**
 * 工作区信息：路径（已 resolve）+ home + git 分支。
 * @throws Error（中文原因：不存在 / 不是目录 / 不是绝对路径）
 */
export function readWorkspaceInfo(rawPath) {
  const p = String(rawPath || '');
  if (!p || !isAbsolute(p)) throw new Error('工作目录应为绝对路径');
  let st;
  try { st = statSync(p); } catch { throw new Error(`工作目录不存在：${p}`); }
  if (!st.isDirectory()) throw new Error(`不是目录：${p}`);
  const git = readGitBranch(p);
  return { path: p, home: homedir(), isGit: git.isGit, branch: git.branch };
}

/** @returns {Promise<boolean>} true = 已处理（含 400 / 405），false = 路径不归本模块 */
export async function handleWorkspaceApi(req, res, url) {
  if (url !== '/api/workspace' && !url.startsWith('/api/workspace?')) return false;
  if (req.method !== 'GET') { json(res, 405, { ok: false, error: '仅支持 GET' }); return true; }
  const qs = new URL(req.url, 'http://localhost').searchParams;
  try {
    const info = readWorkspaceInfo(qs.get('path') || '');
    json(res, 200, { ok: true, ...info });
  } catch (e) {
    json(res, 400, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
  return true;
}
