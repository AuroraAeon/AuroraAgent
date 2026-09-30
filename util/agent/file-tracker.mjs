/**
 * 文件新鲜度追踪（本地化 Cline 的 file-changed 检测）。
 *
 * 要防的事故：模型第 2 轮读了 a.ts，第 9 轮依据记忆里的内容去 edit_file——中间用户在编辑器里
 * 改了同一个文件。替换串对不上还则罢了，怕的是「对得上但语义已变」，静默写坏。
 *
 * 实现取舍——用指纹快照而不是 fs.watch：
 *   read_file 时记下 (mtimeMs, size)，edit_file / write_file 落笔前比对当前指纹。
 *   不一致即「外部改过」，把原内容重读一遍（工具本来就要读）并在结果里告知模型。
 *   fs.watch 看起来更主动，实则要给每个文件养一个 watcher、还得区分「自己写的」与
 *   「别人改的」（否则每次 edit 都误报），长会话里就是一堆 fd 和竞态。macOS 的 APFS
 *   mtime 是纳秒级，指纹比对足够可靠，且完全确定性——测试不用等文件系统事件。
 */
import { statSync } from 'node:fs';

/** 单个会话内追踪的文件数上限：防长会话把 Map 撑爆（超出的按插入序淘汰） */
const MAX_TRACKED = 512;

function fingerprint(abs) {
  try {
    const st = statSync(abs);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch { return null; }
}

function same(a, b) {
  if (!a || !b) return false;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * 文件不见了算「改过」而非「没改」：模型读过它、它却被外部删掉时，edit_file 自己会抛
 * 「文件不存在」，但 write_file 会静默把它重建出来——那正好把用户删文件的意图抹了。
 * 宁可多一句提示，不要静默还原。
 */

export class FileTracker {
  #seen = new Map();

  /** read_file 读完之后调用：记下这一刻的指纹 */
  note(abs) {
    const fp = fingerprint(abs);
    if (!fp) return;
    if (!this.#seen.has(abs) && this.#seen.size >= MAX_TRACKED) {
      const oldest = this.#seen.keys().next().value;
      this.#seen.delete(oldest);
    }
    this.#seen.set(abs, fp);
  }

  /**
   * 落笔前调用：这个文件在本次会话里被外部改过吗？
   * @returns {{ changed: boolean, path: string } | null} 没追踪过返回 null（模型没读过，无从对比）
   */
  changedSince(abs) {
    const before = this.#seen.get(abs);
    if (!before) return null;
    if (same(before, fingerprint(abs))) return null;
    return { changed: true, path: abs };
  }

  /** 自己写完调用：把指纹刷新成新的，否则下一次 edit 会把自己上次的写当成外部改动 */
  refresh(abs) {
    const fp = fingerprint(abs);
    if (fp) this.#seen.set(abs, fp);
  }

  /** 遗忘一个文件（删除 / 重命名后） */
  forget(abs) { this.#seen.delete(abs); }

  clear() { this.#seen.clear(); }

  get size() { return this.#seen.size; }
}

/** 供工具结果前缀用的一句话：说明「这次替换基于重新读到的内容」 */
export function staleFileNotice(relPath) {
  return `注意：${relPath} 在本次会话中被外部改动过（上次读取之后），以上结果基于刚刚重新读到的内容。`;
}
