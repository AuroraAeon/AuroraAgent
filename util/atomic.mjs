/**
 * 原子落盘单一真值源：tmp + fsync + rename + 目录 fsync，临时文件一律 0600。
 *
 * 会话转录 / 配置 / 消息队列 / 定时任务 / 故障转移状态这些文件要么含 API Key、
 * 要么含会话与任务全文——半截文件是数据事故，全局可读是泄露事故，两头都要堵：
 *   - 写临时文件后 fsync 再 rename，断电 / 崩溃不会留下解析不了的半截 JSON；
 *   - 临时文件显式 chmod 0600（openSync 的 mode 受 umask 影响，必须钉死）；
 *   - rename 后对父目录再 fsync，让「文件已替换」本身也落盘；
 *   - 目录按 0700 创建（只对本次新建生效，已有目录权限不动）。
 * 所有同步原子写都走这里，各存储模块不再各自拼 tmp+rename。
 */
import { openSync, writeSync, closeSync, fsyncSync, renameSync, unlinkSync, mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/** 原子写一个文件（同步，调用方持有的事件循环阻塞即写入完成的保证） */
export function writeFileAtomic(path, data, { mode = 0o600, dirMode = 0o700 } = {}) {
  const text = typeof data === 'string' ? data : String(data ?? '');
  const dir = dirname(path);
  try { mkdirSync(dir, { recursive: true, mode: dirMode }); } catch { /* 目录已存在或不可建：交给 openSync 报错 */ }
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  let fd;
  try {
    fd = openSync(tmp, 'w', mode);
    chmodSync(tmp, mode); // umask 会吃掉 openSync 的 mode（如 022 → 640），显式补齐
    writeSync(fd, text);
    fsyncSync(fd); // 数据先落盘，再谈替换
  } catch (e) {
    try { if (fd !== undefined) closeSync(fd); } catch {}
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path); // 同目录原子替换：读者只会看到旧全文或新全文
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    throw e;
  }
  // 目录 fsync：rename 是目录项变更，不刷盘的话断电后可能「内容写了但文件名没换」
  try {
    const dfd = openSync(dir, 'r');
    try { fsyncSync(dfd); } catch { /* 个别平台目录不可 fsync，忽略 */ }
    closeSync(dfd);
  } catch { /* 同上 */ }
}

/** 确保数据目录存在且权限 0700（首次创建才生效，已有目录保持原状） */
export function ensureDataDir(dir, mode = 0o700) {
  try { mkdirSync(dir, { recursive: true, mode }); } catch { /* 调用方随后自行报错 */ }
}
