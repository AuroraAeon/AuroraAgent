/**
 * 工作目录文件搜索（只读）：BFS 限定深度与条目数，跳过依赖 / 构建产物目录。
 * 路径禁锢两道：根本不去 join 用户输入（只读目录名拼相对路径）；结果过 resolveInside
 * 校验后才出列。仅返回工作目录内的相对路径，供输入区 @ 提及使用。
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInside } from './tools.mjs';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.cache', '__pycache__', '.venv', 'venv']);

/**
 * @param workspace 工作目录绝对路径（会话 meta.workspace）
 * @param kw 文件名关键字（大小写不敏感；空 = 列当前层代表文件）
 * @returns 相对路径字符串数组（≤ limit 条）
 */
export function searchWorkspaceFiles(workspace, kw = '', { limit = 20, maxDepth = 4, maxEntries = 8000 } = {}) {
  const out = [];
  const needle = String(kw || '').toLowerCase();
  const queue = [{ dir: String(workspace || '.'), depth: 0, rel: '' }];
  let seen = 0;
  while (queue.length && out.length < limit && seen < maxEntries) {
    const cur = queue.shift();
    let entries;
    try { entries = readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (++seen > maxEntries) break;
      if (SKIP_DIRS.has(ent.name)) continue;
      const rel = cur.rel ? `${cur.rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (cur.depth < maxDepth) queue.push({ dir: join(cur.dir, ent.name), depth: cur.depth + 1, rel });
      } else if (ent.isFile() && (!needle || ent.name.toLowerCase().includes(needle))) {
        // 禁锢校验：累计相对路径必须解析回工作目录内，否则不出列
        try { resolveInside(workspace, rel); out.push(rel); } catch { /* 越界条目不出列 */ }
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}
