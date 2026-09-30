/**
 * 文件新鲜度追踪单测（util/agent/file-tracker.mjs + util/agent/tools.mjs 的接入）。
 * 三条不变式：
 *   1. read_file 记指纹、外部改动后 edit_file 在结果里明说「基于重新读到的内容」；
 *   2. 自己写完不误报——否则每次 edit 都会看到一条吓人的提示；
 *   3. 模型没读过的文件不提示（无从对比，别制造噪声）。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTracker, staleFileNotice } from '../util/agent/file-tracker.mjs';
import { getTool } from '../util/agent/tools.mjs';

function tmp() { return mkdtempSync(join(tmpdir(), 'aurora-ftrack-')); }

/** 建好工作目录并写一个文件 */
function ws(dir, name, text) {
  const root = join(dir, 'ws');
  mkdirSync(root, { recursive: true });
  const p = join(root, name);
  writeFileSync(p, text);
  return p;
}

/** 把 mtime 往前推，模拟「另一个人改了文件」 */
function touchLater(path, ms = 5000) {
  const now = Date.now() + ms;
  utimesSync(path, new Date(now), new Date(now));
}

export async function runFileTrackerTests(test, assert, eq) {
  test('指纹：读过之后外部改动即判 stale，未读过不判', () => {
    const dir = tmp();
    try {
      const f = ws(dir, 'a.txt', '一');
      const t = new FileTracker();
      eq(t.changedSince(f), null, '没读过不该有意见');
      t.note(f);
      eq(t.changedSince(f), null, '没变不该报');
      writeFileSync(f, '二');
      assert(t.changedSince(f) !== null, '内容变了就应判 stale——同体积也躲不过 mtime');
      t.refresh(f);
      eq(t.changedSince(f), null, 'refresh 后重新同步');
      rmSync(f);
      assert(t.changedSince(f) !== null, '文件被外部删掉也算改过：别让 write_file 静默重建它');
      t.note(join(dir, 'nope.txt'));
      eq(t.size, 1, '不存在的文件不进追踪表（read_file 读不到它）');
      t.forget(f);
      eq(t.size, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('自己写完不误报：write_file / edit_file 后指纹同步刷新', () => {
    const dir = tmp();
    try {
      const f = ws(dir, 'a.txt', 'hello');
      const root = join(dir, 'ws');
      const t = new FileTracker();
      const ctx = { workspace: root, fileTracker: t };
      t.note(f);
      getTool('edit_file').run({ path: 'a.txt', old_string: 'hello', new_string: 'world' }, ctx);
      eq(t.changedSince(f), null, '自己 edit 过不应报 stale');
      getTool('write_file').run({ path: 'a.txt', content: 'third' }, ctx);
      eq(t.changedSince(f), null, '自己 write 过不应报 stale');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('edit_file：外部改过之后，工具结果里明说基于重新读到的内容', () => {
    const dir = tmp();
    try {
      const f = ws(dir, 'a.txt', 'hello');
      const root = join(dir, 'ws');
      const t = new FileTracker();
      const ctx = { workspace: root, fileTracker: t };
      getTool('read_file').run({ path: 'a.txt' }, ctx);
      // 用户在外面改了文件（内容与体积都不同，mtime 也推后）
      writeFileSync(f, 'goodbye world');
      touchLater(f);
      const r = getTool('edit_file').run({ path: 'a.txt', old_string: 'goodbye', new_string: 'farewell' }, ctx);
      assert(String(r.output).includes('外部改动过'), `结果应提示外部改动，实际：${r.output}`);
      assert(String(r.output).includes('farewell'), '替换本身应成功');
      eq(t.changedSince(f), null, '提示过一次之后指纹已同步');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('write_file：外部改过之后同样提示', () => {
    const dir = tmp();
    try {
      const f = ws(dir, 'a.txt', 'hello');
      const root = join(dir, 'ws');
      const t = new FileTracker();
      const ctx = { workspace: root, fileTracker: t };
      getTool('read_file').run({ path: 'a.txt' }, ctx);
      writeFileSync(f, 'someone else was here');
      touchLater(f);
      const r = getTool('write_file').run({ path: 'a.txt', content: 'mine now' }, ctx);
      assert(String(r).includes('外部改动过'), `结果应提示外部改动，实际：${r}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('read_file 记指纹：读过才谈得上新鲜度', () => {
    const dir = tmp();
    try {
      ws(dir, 'a.txt', 'x');
      const root = join(dir, 'ws');
      const t = new FileTracker();
      const ctx = { workspace: root, fileTracker: t };
      eq(t.size, 0);
      getTool('read_file').run({ path: 'a.txt' }, ctx);
      eq(t.size, 1, 'read_file 应把文件纳入追踪');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('staleFileNotice：带上路径，模型才知道说的是哪个文件', () => {
    const s = staleFileNotice('src/a.ts');
    assert(s.includes('src/a.ts'), '应带路径');
    assert(s.includes('外部改动过'), '应说明原因');
  });
}
