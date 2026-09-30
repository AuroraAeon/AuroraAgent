/**
 * 检查点单测（util/agent/checkpoint.mjs / checkpoint-restore.mjs / checkpoint-cmd.mjs）：
 * git 路径的 stash + 第三父快照与私有 ref、干净工作区降级、非 git 路径的内容镜像、
 * 恢复事务（commit / rollback / 双失败 AggregateError）、HEAD 前走时拒绝恢复、
 * 转录裁剪边界、会话删除清理、终端 /checkpoint 纯函数层，以及 Loop 接入点。
 *
 * 断言方式分两类：
 *  - 假 exec：按调用序列断言「敲了哪些 git 命令」，不打真 git，也不挑 git 版本；
 *  - 真实临时 git 仓库：端到端验证对象真的能存能还原（只在有 git 的环境跑，没有就跳过）。
 * 数据隔离：临时目录一律 mkdtempSync，finally 统一 rmSync，绝不碰真实数据目录。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  CHECKPOINT_REF_PREFIX, CHECKPOINT_STASH_MESSAGE_PREFIX, MAX_CHECKPOINT_HISTORY,
  checkpointRef, checkpointScratchDir, pruneStaleScratchDirs,
  readCheckpointHistory, writeCheckpointHistory, findCheckpointForTurn,
  deleteCheckpointRefs, restoreMirror, deleteMirrorBackups, createCheckpointRuntime,
} from '../util/agent/checkpoint.mjs';
import {
  beginWorktreeRestoreTransaction, applyCheckpointToWorktree, restoreCheckpoint,
  userTurnBoundaries, trimRecordsToTurn, filesTouchedAfter,
} from '../util/agent/checkpoint-restore.mjs';
import {
  parseCheckpointArg, formatCheckpointLines, formatCheckpointLine, formatCheckpointDiffLines,
} from '../util/agent/checkpoint-cmd.mjs';
import { runAgentTurn } from '../util/agent/loop.mjs';
import { SessionStore } from '../util/agent/session.mjs';
import { UsageLedger } from '../util/usage.mjs';
import { getHarness } from '../util/agent/harness.mjs';

const TMP_DIRS = [];
const keep = (d) => { TMP_DIRS.push(d); return d; };
const mkws = (files = {}) => {
  const dir = keep(mkdtempSync(join(tmpdir(), 'aurora-cp-')));
  const ws = join(dir, 'workspace');
  mkdirSync(ws, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(ws, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  return { dir, ws };
};

/** 假执行器：记录调用序列，按应答表回值（缺省回空 stdout） */
function fakeExec(responder = () => ({ stdout: '', stderr: '' })) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args: [...(args || [])], opts });
    const r = await responder({ cmd, args: [...(args || [])], opts });
    if (r && r.throw) throw r.throw;
    return { stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
  };
  /** 假 spawn：走 stdin 喂 pathspec 的 git（update-index --stdin）也记进 calls */
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args: [...(args || [])], opts, spawn: true });
    const handlers = {};
    const child = {
      stderr: { on: (ev, fn) => { handlers.stderr = fn; } },
      stdin: { on: () => {}, end: () => {} },
      on: (ev, fn) => { if (ev === 'close') setTimeout(() => fn(0), 0); if (ev === 'error') handlers.error = fn; },
    };
    return child;
  };
  /** git 参数数组（已剥掉 -C <workspace> 前缀） */
  const gitCalls = () => calls.filter((c) => c.cmd === 'git').map((c) => c.args.slice(2));
  return { calls, gitCalls, exec, spawn };
}

const hasGit = (() => {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
})();

/** 真 git 仓库助手：返回已初始化的目录（有首次提交，可改文件） */
function realGitRepo(files = { 'a.txt': 'v1\n' }) {
  const { dir, ws } = mkws(files);
  const git = (args) => execFileSync('git', ['-C', ws, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['config', 'user.email', 't@t']);
  git(['config', 'user.name', 't']);
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  return { dir, ws, git };
}

const sseResp = (frames) => new Response(new ReadableStream({
  start(c) {
    for (const f of frames) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
    c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    c.close();
  },
}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const textFrames = (txt) => [
  { choices: [{ index: 0, delta: { content: txt } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
];
const toolFrames = (name, args) => [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_cp1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8 } },
];

/** Loop 接入环境（与 test/hooks.mjs 同构，注入 checkpoints 运行时） */
async function runLoop({ framesByCall, checkpoints, wsFiles = {}, permission = 'allow', harness = getHarness('standard'), sessionPatch = {}, ws: givenWs }) {
  const dir = mkdtempSync(join(tmpdir(), 'aurora-cploop-'));
  TMP_DIRS.push(dir);
  const ws = givenWs || join(dir, 'workspace');
  mkdirSync(ws, { recursive: true });
  for (const [rel, text] of Object.entries(wsFiles)) {
    const abs = join(ws, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
  const store = new SessionStore(dir);
  const usage = new UsageLedger(dir);
  const created = store.create({ name: '', model: 'm1', harness: harness.id, workspace: ws });
  const session = store.patch(created.id, sessionPatch) || created;
  const events = [];
  const provider = { id: 'p1', name: '测试提供方', protocol: 'openai', baseUrl: 'https://up.test', pathPrefix: '/v1', apiKey: 'k' };
  const realFetch = globalThis.fetch;
  let call = 0;
  const requests = [];
  globalThis.fetch = async (url, opts = {}) => {
    requests.push({ url: String(url), body: JSON.parse(opts.body || '{}') });
    const scripted = typeof framesByCall === 'function' ? framesByCall(call, requests.at(-1)) : framesByCall[Math.min(call, framesByCall.length - 1)];
    call++;
    return sseResp(scripted);
  };
  try {
    const result = await runAgentTurn({
      store, usage, session, provider, model: 'm1', harness, builtinPrice: { in: 0, out: 0 },
      gen: {}, input: '开始', emit: (t, p) => events.push({ type: t, ...p }),
      controller: new AbortController(),
      requestPermission: async () => permission,
      permissionMode: 'never_ask', titleMode: 'none',
      checkpoints,
    });
    return { result, events, requests, session, store, ws };
  } finally { globalThis.fetch = realFetch; }
}

export async function runCheckpointTests(test, assert, eq) {
  // ——————————————— 纯函数层 ———————————————

  await test('checkpoint: 历史读写往返，坏数据静默丢弃', () => {
    const meta = writeCheckpointHistory([
      { turnIndex: 2, kind: 'git', ref: 'abc', at: 100, createdAt: 90, note: 'n' },
      { turnIndex: 1, kind: 'mirror', ref: '', at: 50, createdAt: 40 },
    ]);
    const back = readCheckpointHistory({ checkpoints: meta });
    eq(back.length, 2, '两条都在');
    eq(back[0].turnIndex, 1, '按轮次升序');
    eq(back[0].kind, 'mirror', 'kind 保留');
    eq(back[1].ref, 'abc', 'ref 保留');
    eq(readCheckpointHistory({}).length, 0, '没有 checkpoints 段给空数组');
    eq(readCheckpointHistory({ checkpoints: [] }).length, 0, '数组形状（坏数据）给空');
    eq(readCheckpointHistory({ checkpoints: { entries: [null, { turnIndex: 0 }, { turnIndex: 'x' }, 5, { turnIndex: 3, kind: '怪' }] } }).length, 1, '只收合法的');
    eq(readCheckpointHistory({ checkpoints: { entries: [{ turnIndex: 3, kind: '怪' }] } })[0].kind, 'git', '未知 kind 归一为 git');
  });

  await test('checkpoint: findCheckpointForTurn 取不晚于目标轮次的最近一个', () => {
    const entries = [{ turnIndex: 1 }, { turnIndex: 3 }, { turnIndex: 7 }];
    eq(findCheckpointForTurn(entries, 1).turnIndex, 1, '正好有');
    eq(findCheckpointForTurn(entries, 4).turnIndex, 3, '落到上一个');
    eq(findCheckpointForTurn(entries, 99).turnIndex, 7, '越界取最后一个');
    eq(findCheckpointForTurn(entries, 0), null, '比第一个还早——没有');
    eq(findCheckpointForTurn([], 2), null, '空表');
  });

  await test('checkpoint: 私有 ref 名与 scratch 目录键', () => {
    eq(checkpointRef('s1', 3), `${CHECKPOINT_REF_PREFIX}s1/3`, 'ref 名带命名空间与轮次');
    const a = checkpointScratchDir('/data', '/ws', 's1');
    const b = checkpointScratchDir('/data', '/ws', 's1');
    eq(a, b, '同输入同键（跨轮要复用同一份 index）');
    assert(a.startsWith('/data'), 'scratch 落在数据目录下');
    assert(a.includes('checkpoint-scratch'), 'scratch 有独立子目录');
    assert(checkpointScratchDir('/data', '/ws', 's1') !== checkpointScratchDir('/data', '/ws', 's2'), '不同会话不撞');
    assert(checkpointScratchDir('/data', '/wsA', 's1') !== checkpointScratchDir('/data', '/wsB', 's1'), '不同工作区不撞');
  });

  await test('checkpoint: pruneStaleScratchDirs 只回收超龄目录', () => {
    const dir = keep(mkdtempSync(join(tmpdir(), 'aurora-cpprune-')));
    const base = join(dir, 'checkpoint-scratch');
    const old = join(base, 'old');
    const fresh = join(base, 'fresh');
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    const past = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    utimesSync(old, past, past);
    pruneStaleScratchDirs(dir);
    assert(!existsSync(old), '超 14 天的回收');
    assert(existsSync(fresh), '新鲜的留着');
    pruneStaleScratchDirs(join(dir, 'nope'));
    assert(true, '基础目录不存在不抛');
  });

  await test('checkpoint: 会话删除清理 ref 与镜像', async () => {
    const dir = keep(mkdtempSync(join(tmpdir(), 'aurora-cpdel-')));
    const { calls, gitCalls, exec } = fakeExec(({ args }) => (
      args.includes('for-each-ref') ? { stdout: `${CHECKPOINT_REF_PREFIX}s1/1\n${CHECKPOINT_REF_PREFIX}s1/2\n` } : { stdout: '' }
    ));
    await deleteCheckpointRefs('/ws', 's1', dir, exec);
    const fc = gitCalls().find((a) => a.includes('for-each-ref'));
    assert(fc && fc[fc.length - 1] === `${CHECKPOINT_REF_PREFIX}s1/`, 'for-each-ref 用前缀扫');
    eq(gitCalls().filter((a) => a.includes('update-ref') && a.includes('-d')).length, 2, '逐条删 ref');
    // 非 git / git 不可用：静默
    await deleteCheckpointRefs('', 's1', dir, fakeExec(() => ({ throw: new Error('no git') })).exec);
    assert(true, 'git 不可用不抛');
    const backup = join(dir, 'backups', 's1', '1');
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, 'manifest.json'), '[]');
    deleteMirrorBackups(dir, 's1');
    assert(!existsSync(join(dir, 'backups', 's1')), '镜像目录清掉');
    deleteMirrorBackups(dir, 's1');
    assert(true, '重复清不抛');
  });

  // ——————————————— git 路径（假 exec 断言命令序列）———————————————

  await test('checkpoint: git 路径敲 stash create + 第三父 + update-ref 私有 ref', async () => {
    const dd = keep(mkdtempSync(join(tmpdir(), 'aurora-cpdata-')));
    const { calls, gitCalls, exec, spawn } = fakeExec(({ args }) => {
      if (args.includes('rev-parse') && args.includes('--is-inside-work-tree')) return { stdout: 'true' };
      if (args.includes('stash') && args.includes('create')) return { stdout: 'stashsha\n' };
      if (args.includes('ls-files') && args.includes('--others')) return { stdout: 'new.txt\0' };
      if (args.includes('ls-files')) return { stdout: 'new.txt\0vanished.txt\0' };
      if (args.includes('rev-parse') && String(args).includes('^{tree}')) return { stdout: 'treesha\n' };
      if (args.includes('rev-parse')) return { stdout: 'sha\n' };
      if (args.includes('write-tree')) return { stdout: 'untrackedtree\n' };
      if (args.includes('commit-tree')) return { stdout: 'commitsha\n' };
      return { stdout: '' };
    });
    const logs = [];
    const rt = createCheckpointRuntime({ workspace: '/ws', dataDir: dd, sessionId: 's1', log: (l, m, e) => logs.push([l, m, e]), exec, spawnExec: spawn });
    const entry = await rt.beginTurn(1, '第 1 轮');
    eq(entry.kind, 'git', '认成 git 路径');
    eq(rt.kind, 'git', '运行时 kind');
    const gc = gitCalls();
    assert(gc.some((a) => a.includes('stash') && a.includes('create')), '先 stash create 拿工作区快照');
    assert(gc.some((a) => a.includes('ls-files') && a.includes('--others')), '列举未跟踪文件');
    assert(gc.some((a) => a.includes('add') && a.includes('--pathspec-from-file')), '用持久化 scratch index 收未跟踪');
    assert(gc.some((a) => a.includes('update-index') && a.includes('--force-remove')), '清掉退出未跟踪集合的条目');
    assert(gc.some((a) => a.includes('write-tree')), '写未跟踪树');
    // 三父合成提交：stash 树 + 基 + index 父 + 未跟踪父
    const synth = gc.find((a) => a.includes('commit-tree') && a.filter((x) => x === '-p').length === 3);
    assert(synth, '合成带第三父的 stash 形状提交');
    const ur = gc.find((a) => a.includes('update-ref') && a[1]?.startsWith(CHECKPOINT_REF_PREFIX));
    assert(ur && ur[1] === checkpointRef('s1', 1), '钉进私有检查点 ref');
    eq(ur[2], 'commitsha', 'ref 指向合成提交');
    assert(gc.some((a) => a.includes('core.ignorestat=false') && a.includes('core.splitIndex=false')), '碰 index 的 git 钉死 ignorestat / splitIndex');
    const rawGit = calls.filter((c) => c.cmd === 'git');
    assert(rawGit.every((c) => c.args[0] === '-C' && c.args[1] === '/ws'), '每条 git 都带 -C（工作目录注入）');
    eq(rt.entries.length, 1, '历史记一条');
    eq(logs.length, 0, '顺利时无告警');
    assert(entry.ref === 'commitsha', '条目记 ref');
    assert(typeof entry.at === 'number' && entry.at > 0, '条目记时间');
  });

  await test('checkpoint: 干净工作区（stash create 空 + 无未跟踪）降级为 HEAD 检查点', async () => {
    const dd = keep(mkdtempSync(join(tmpdir(), 'aurora-cpdata-')));
    const { gitCalls, exec } = fakeExec(({ args }) => {
      if (args.includes('rev-parse') && args.includes('--is-inside-work-tree')) return { stdout: 'true' };
      if (args.includes('stash') && args.includes('create')) return { stdout: '\n' };
      if (args.includes('ls-files') && args.includes('--others')) return { stdout: '\n' };
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'headsha\n' };
      return { stdout: '' };
    });
    const logs = [];
    const rt = createCheckpointRuntime({ workspace: '/ws', dataDir: dd, sessionId: 's1', log: (l, m, e) => logs.push([l, m, e]), exec });
    const entry = await rt.beginTurn(1);
    eq(entry.ref, 'headsha', '退回 HEAD');
    eq(entry.kind, 'git', '仍是 git 检查点');
    eq(logs.length, 0, '干净工作区不算失败，不告警');
    assert(!gitCalls().some((a) => a.includes('update-ref') && String(a).includes(CHECKPOINT_REF_PREFIX)), '没有可拍的东西就不钉 ref');
  });

  await test('checkpoint: 快照炸了退化为 HEAD 检查点并告警，turn 不中断', async () => {
    const dd = keep(mkdtempSync(join(tmpdir(), 'aurora-cpdata-')));
    const { gitCalls, exec } = fakeExec(({ args }) => {
      if (args.includes('rev-parse') && args.includes('--is-inside-work-tree')) return { stdout: 'true' };
      if (args.includes('stash') && args.includes('create')) return { stdout: 'stashsha\n' };
      if (args.includes('ls-files') && args.includes('--others')) return { stdout: 'u.txt\0' };
      if (args.includes('add') && args.includes('--pathspec-from-file')) return { throw: Object.assign(new Error('index 损坏'), { stderr: 'fatal: index corrupt' }) };
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'headsha\n' };
      return { stdout: '' };
    });
    const logs = [];
    const rt = createCheckpointRuntime({ workspace: '/ws', dataDir: dd, sessionId: 's1', log: (l, m, e) => logs.push([l, m, e]), exec });
    const entry = await rt.beginTurn(2);
    eq(entry.ref, 'headsha', '降级 HEAD');
    eq(logs.length, 1, '记一条告警');
    assert(logs[0][2].error.length > 0, '告警带原因');
    // 坏 index 会先删掉重试一次，仍失败才降级
    const adds = gitCalls().filter((a) => a.includes('add') && a.includes('--pathspec-from-file'));
    eq(adds.length, 2, '坏 index 清掉后重试一次');
  });

  await test('checkpoint: 同轮重复快照后者覆盖，历史按上限裁剪', async () => {
    const { exec } = fakeExec(({ args }) => {
      if (args.includes('rev-parse') && args.includes('--is-inside-work-tree')) return { stdout: 'true' };
      if (args.includes('stash') && args.includes('create')) return { stdout: 's\n' };
      if (args.includes('ls-files') && args.includes('--others')) return { stdout: '\n' };
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'head\n' };
      return { stdout: '' };
    });
    const rt = createCheckpointRuntime({ workspace: '/ws', dataDir: '/data', sessionId: 's1', exec });
    await rt.beginTurn(1);
    await rt.beginTurn(1);
    eq(rt.entries.length, 1, '同轮不堆两条');
    for (let i = 2; i <= MAX_CHECKPOINT_HISTORY + 6; i += 1) await rt.beginTurn(i);
    eq(rt.entries.length, MAX_CHECKPOINT_HISTORY, '历史封顶');
    eq(rt.entries[0].turnIndex, 7, '裁掉最旧的');
  });

  await test('checkpoint: close 清 ref（git 路径）', async () => {
    const dd = keep(mkdtempSync(join(tmpdir(), 'aurora-cpdata-')));
    const { gitCalls, exec } = fakeExec(({ args }) => {
      if (args.includes('rev-parse') && args.includes('--is-inside-work-tree')) return { stdout: 'true' };
      if (args.includes('stash') && args.includes('create')) return { stdout: 's\n' };
      if (args.includes('ls-files') && args.includes('--others')) return { stdout: '\n' };
      if (args.includes('rev-parse') && args.includes('HEAD')) return { stdout: 'head\n' };
      if (args.includes('for-each-ref')) return { stdout: `${CHECKPOINT_REF_PREFIX}s1/1\n` };
      return { stdout: '' };
    });
    const rt = createCheckpointRuntime({ workspace: '/ws', dataDir: dd, sessionId: 's1', exec });
    await rt.beginTurn(1);
    await rt.close();
    assert(gitCalls().some((a) => a.includes('update-ref') && a.includes('-d')), 'close 删掉私有 ref');
    eq(rt.entries.length, 0, '历史清空');
  });

  await test('checkpoint: 无 workspace 的运行时禁用，beginTurn 直接返回 null', async () => {
    const rt = createCheckpointRuntime({ workspace: '', dataDir: '/nonexistent', sessionId: 's1' });
    eq(rt.enabled, false, '没有工作目录即禁用');
    eq(await rt.beginTurn(1), null, '不拍快照');
    eq(rt.kind, 'mirror', '非 git 兜底');
    eq(await rt.beginTurn(0), null, '轮次号非法');
    eq(await rt.beginTurn(1.5), null, '轮次号非整数');
  });

  // ——————————————— 非 git 路径：内容镜像 ———————————————

  await test('checkpoint: 非 git 工作区走内容镜像，落笔前抄原内容', async () => {
    const { dir, ws } = mkws({ 'keep.txt': '原文\n', 'sub/nested.txt': '嵌套原文\n' });
    const { exec } = fakeExec(({ args }) => {
      if (args.includes('rev-parse') && args.includes('--is-inside-work-tree')) return { stdout: 'false\n' };
      return { stdout: '' };
    });
    const rt = createCheckpointRuntime({ workspace: ws, dataDir: dir, sessionId: 's1', exec });
    eq(rt.kind, 'mirror', '认成镜像路径');
    const entry = await rt.beginTurn(1);
    eq(entry.kind, 'mirror', '条目记镜像');
    const manifestPath = join(dir, 'backups', 's1', '1', 'manifest.json');
    assert(existsSync(manifestPath), 'manifest 落盘');
    eq(JSON.parse(readFileSync(manifestPath, 'utf8')).length, 0, '起初空清单');
    rt.capture(join(ws, 'keep.txt'));
    rt.capture(join(ws, 'keep.txt'));
    rt.capture(join(ws, 'sub', 'nested.txt'));
    rt.capture(join(ws, '..', 'escape.txt'));
    const list = JSON.parse(readFileSync(manifestPath, 'utf8'));
    eq(list.length, 2, '同轮重复 capture 不重复抄，穿越路径被拒');
    eq(list[0].path, 'keep.txt', '记相对路径');
    eq(list[0].existed, true, '标记原本存在');
    assert(readFileSync(join(dir, 'backups', 's1', '1', 'files', 'keep.txt'), 'utf8') === '原文\n', '原内容抄进镜像');
    assert(readFileSync(join(dir, 'backups', 's1', '1', 'files', 'sub', 'nested.txt'), 'utf8') === '嵌套原文\n', '嵌套路径目录层级保留');
    // 新建的文件（原本不存在）记 existed:false——镜像要在 write_file 落笔前抄，所以此刻磁盘上还没有
    rt.capture(join(ws, 'brand.txt'));
    const list2 = JSON.parse(readFileSync(manifestPath, 'utf8'));
    eq(list2.length, 3, '新文件也记一条');
    eq(list2[2].existed, false, '标出原本不存在');
    assert(!existsSync(join(dir, 'backups', 's1', '1', 'files', 'brand.txt')), '不存在的文件没有内容可抄');
  });

  await test('checkpoint: restoreMirror 还原改动、删掉新建', () => {
    const { dir, ws } = mkws({ 'a.txt': 'v1\n' });
    const backupDir = join(dir, 'backups', 's1', '1');
    mkdirSync(join(backupDir, 'files'), { recursive: true });
    writeFileSync(join(backupDir, 'manifest.json'), JSON.stringify([
      { path: 'a.txt', existed: true },
      { path: 'made/b.txt', existed: false },
      { path: 'gone/c.txt', existed: false },
    ]));
    writeFileSync(join(dir, 'backups', 's1', '1', 'files', 'a.txt'), 'v1\n');
    writeFileSync(join(ws, 'a.txt'), 'v2 改坏了\n');
    mkdirSync(join(ws, 'made'), { recursive: true });
    writeFileSync(join(ws, 'made', 'b.txt'), '本轮新建\n');
    const r = restoreMirror(dir, 's1', 1, ws);
    eq(r.restored, 1, '还原一个改过的');
    eq(r.removed, 1, '删掉一个新建的');
    eq(readFileSync(join(ws, 'a.txt'), 'utf8'), 'v1\n', '内容回到快照时');
    assert(!existsSync(join(ws, 'made', 'b.txt')), '新建的没了');
    const none = restoreMirror(dir, 's1', 99, ws);
    eq(none.restored + none.removed, 0, '没有那个轮次的镜像时空操作');
    const broken = restoreMirror(dir, 's1', 1, join(dir, 'nowhere'));
    assert(typeof broken.restored === 'number', '工作区目录没了也不抛');
  });

  await test('checkpoint: 镜像路径 close 清备份，工作区保留', async () => {
    const { dir, ws } = mkws({ 'a.txt': 'v1\n' });
    const { exec } = fakeExec(() => ({ stdout: 'false\n' }));
    const rt = createCheckpointRuntime({ workspace: ws, dataDir: dir, sessionId: 's1', exec });
    await rt.beginTurn(1);
    rt.capture(join(ws, 'a.txt'));
    await rt.close();
    assert(!existsSync(join(dir, 'backups', 's1')), '备份目录清掉');
    assert(existsSync(join(ws, 'a.txt')), '工作区文件不动');
  });

  // ——————————————— 恢复事务与工作区恢复（假 exec）———————————————

  await test('checkpoint-restore: 恢复前先 stash push --include-untracked 挪私有 ref', async () => {
    let stashPushes = 0;
    const { gitCalls, exec } = fakeExec(({ args }) => {
      if (args.includes('--is-inside-work-tree')) return { stdout: 'true' };
      if (args.includes('stash') && args.includes('push')) { stashPushes += 1; return { stdout: '' }; }
      if (args.includes('rev-parse') && args.includes('--verify') && args.includes('HEAD')) return { stdout: 'headsha\n' };
      if (args.includes('rev-parse') && args.includes('--verify')) return { stdout: stashPushes ? 'newstash\n' : 'prevstash\n' };
      return { stdout: '' };
    });
    const tx = await beginWorktreeRestoreTransaction('/ws', exec);
    const gc = gitCalls();
    assert(gc.some((a) => a.includes('stash') && a.includes('push') && a.includes('--include-untracked')), '连未跟踪一起收');
    const ur = gc.find((a) => a.includes('update-ref') && String(a).includes('restore-transactions/'));
    assert(ur, '挪进私有事务 ref');
    eq(ur[2], 'newstash', '指向刚拍的快照');
    assert(gc.some((a) => a.includes('stash') && a.includes('drop')), '从用户可见 stash 列表摘掉');
    await tx.commit();
    const after = gitCalls();
    assert(after.some((a) => a.includes('update-ref') && a.includes('-d') && String(a).includes('restore-transactions/')), 'commit 删私有 ref');
    const before = after.length;
    await tx.commit();
    eq(gitCalls().length, before, '重复 commit 幂等（不再敲 git）');
  });

  await test('checkpoint-restore: 事务在干净工作区不拍快照，rollback 只回 HEAD', async () => {
    const { gitCalls, exec } = fakeExec(({ args }) => {
      if (args.includes('--is-inside-work-tree')) return { stdout: 'true' };
      if (args.includes('rev-parse')) return { stdout: 'headsha\n' };
      // 干净工作区 git stash push 仍会跑，只是 refs/stash 不变、stdout 提示无事可存
      if (args.includes('stash') && args.includes('push')) return { stdout: 'No local changes to save\n' };
      return { stdout: '' };
    });
    const tx = await beginWorktreeRestoreTransaction('/ws', exec);
    assert(gitCalls().some((a) => a.includes('stash') && a.includes('push')), '仍探一次 stash push');
    assert(!gitCalls().some((a) => a.includes('stash') && a.includes('drop')), '没拍到东西就不往私有 ref 挪');
    await tx.rollback();
    const gc = gitCalls();
    assert(gc.some((a) => a.includes('reset') && a.includes('--hard')), 'rollback 复位工作区');
    assert(!gc.some((a) => a.includes('stash') && a.includes('apply')), '没有快照就不 apply');
  });

  await test('checkpoint-restore: 事务在非 git 仓库直接抛中文原因', async () => {
    const { exec } = fakeExec(() => ({ stdout: 'false\n' }));
    let msg = '';
    try { await beginWorktreeRestoreTransaction('/ws', exec); } catch (e) { msg = e.message; }
    assert(msg.includes('不是 git 仓库'), '说清楚为什么做不了');
  });

  await test('checkpoint-restore: apply 顺序 reset --hard → 有第三父才 clean -fd → stash apply', async () => {
    const order = [];
    const { exec } = fakeExec(({ args }) => {
      const a = args.join(' ');
      if (a.includes('--is-inside-work-tree')) return { stdout: 'true' };
      // HEAD 与检查点基座同一个提交：分支没前走，允许恢复
      if (a.includes('rev-parse --verify')) { order.push(`rev-parse ${args[args.length - 1]}`); return { stdout: 'basesha\n' }; }
      if (a.includes('show -s')) return { stdout: 'base sha2 sha3\0auroraagent checkpoint session=s1 run=1' };
      if (a.includes('cat-file -e') && a.includes('^3')) return { stdout: '' };
      if (a.includes('cat-file -e')) return { stdout: '' };
      if (a.includes('rev-list --count')) return { stdout: '0\n' };
      if (a.includes('update-ref')) { order.push(`update-ref ${args.includes('HEAD') ? 'HEAD' : 'other'}`); return { stdout: '' }; }
      if (a.includes('reset --hard')) { order.push('reset'); return { stdout: '' }; }
      if (a.includes('clean -fd')) { order.push('clean'); return { stdout: '' }; }
      if (a.includes('stash apply')) { order.push('stash-apply'); return { stdout: '' }; }
      return { stdout: '' };
    });
    const r = await applyCheckpointToWorktree('/ws', { turnIndex: 1, kind: 'git', ref: 'cpsha' }, { exec });
    eq(r.kind, 'stash', '认成 stash 形状');
    eq(order.indexOf('reset'), order.indexOf('clean') - 1, '先 reset 再 clean');
    eq(order.indexOf('clean'), order.indexOf('stash-apply') - 1, 'clean 在 apply 之前');
    assert(order.indexOf('update-ref HEAD') < order.indexOf('reset'), 'HEAD 用 CAS 先移动');
  });

  await test('checkpoint-restore: 没有第三父的旧快照不跑 clean -fd（否则丢数据）', async () => {
    const order = [];
    const { exec } = fakeExec(({ args }) => {
      const a = args.join(' ');
      if (a.includes('--is-inside-work-tree')) return { stdout: 'true' };
      if (a.includes('show -s')) return { stdout: 'base sha2\0auroraagent checkpoint session=s1 run=1' };
      if (a.includes('cat-file -e') && a.includes('^3')) return { throw: new Error('missing') };
      if (a.includes('cat-file -e')) return { stdout: '' };
      if (a.includes('rev-list --count')) return { stdout: '0\n' };
      if (a.includes('reset --hard')) { order.push('reset'); return { stdout: '' }; }
      if (a.includes('clean -fd')) { order.push('clean'); return { stdout: '' }; }
      if (a.includes('stash apply')) { order.push('apply'); return { stdout: '' }; }
      if (a.includes('rev-parse --verify')) return { stdout: 'basesha\n' };
      return { stdout: '' };
    });
    await applyCheckpointToWorktree('/ws', { turnIndex: 1, kind: 'git', ref: 'cpsha' }, { exec });
    assert(!order.includes('clean'), '没拍未跟踪就不清未跟踪');
    assert(order.includes('apply'), '照常 apply');
  });

  await test('checkpoint-restore: 分支已前走时拒绝恢复（不毁历史）', async () => {
    const { gitCalls, exec } = fakeExec(({ args }) => {
      const a = args.join(' ');
      if (a.includes('--is-inside-work-tree')) return { stdout: 'true' };
      if (a.includes('show -s')) return { stdout: 'base sha2\0auroraagent checkpoint session=s1 run=1' };
      if (a.includes('cat-file -e')) return { stdout: '' };
      if (a.includes('rev-list --count')) return { stdout: '3\n' };
      if (a.includes('rev-parse --verify')) return { stdout: a.includes('HEAD') ? 'headsha' : 'cpsha' };
      return { stdout: '' };
    });
    let msg = '';
    try { await applyCheckpointToWorktree('/ws', { turnIndex: 1, kind: 'git', ref: 'cpsha' }, { exec }); } catch (e) { msg = e.message; }
    assert(msg.includes('又多了 3 个提交'), '给出提交数');
    assert(msg.includes('可以只回滚对话'), '给出替代方案');
    assert(!gitCalls().some((x) => x.includes('reset')), '一个 reset 都不跑');
  });

  await test('checkpoint-restore: 条目不完整 / 非 git / mirror 分支的中文报错', async () => {
    const { exec } = fakeExec(() => ({ stdout: '' }));
    for (const bad of [null, {}, { turnIndex: 1 }, { turnIndex: 0, kind: 'git', ref: 'r' }]) {
      let msg = '';
      try { await applyCheckpointToWorktree('/ws', bad, { exec }); } catch (e) { msg = e.message; }
      assert(msg.length > 0, `坏条目有中文原因: ${JSON.stringify(bad)}`);
    }
    const notGit = fakeExec(({ args }) => (args.includes('--is-inside-work-tree') ? { stdout: 'false' } : { stdout: '' })).exec;
    let msg = '';
    try { await applyCheckpointToWorktree('/ws', { turnIndex: 1, kind: 'git', ref: 'r' }, { exec: notGit }); } catch (e) { msg = e.message; }
    assert(msg.includes('不是 git 仓库'), '非 git 不给硬跑');
    const mirror = await applyCheckpointToWorktree('/ws', { turnIndex: 1, kind: 'mirror' }, { exec, dataDir: '/nope', sessionId: 's' });
    eq(mirror.kind, 'mirror', '镜像路径不碰 git');
    eq(mirror.restored + mirror.removed, 0, '没有镜像即空操作');
  });

  await test('checkpoint-restore: restoreCheckpoint 失败后回滚并带 rolledBack', async () => {
    let stashPushes = 0;
    let resets = 0;
    const { gitCalls, exec } = fakeExec(({ args }) => {
      const a = args.join(' ');
      if (a.includes('--is-inside-work-tree')) return { stdout: 'true' };
      if (a.includes('stash') && a.includes('push')) { stashPushes += 1; return { stdout: '' }; }
      if (a.includes('rev-parse --verify') && a.includes('refs/stash')) return { stdout: stashPushes ? 'newstash\n' : 'prevstash\n' };
      // HEAD 与检查点基座同一个提交：分支没前走，可以走到 reset 那一步再炸
      if (a.includes('rev-parse --verify')) return { stdout: 'basesha\n' };
      if (a.includes('show -s')) return { stdout: 'base sha2\0auroraagent checkpoint session=s1 run=1' };
      if (a.includes('cat-file -e')) return { stdout: '' };
      if (a.includes('rev-list --count')) return { stdout: '0\n' };
      // 恢复那一次 reset 炸；随后回滚用的 reset 要能成——否则测不到「已回滚」标记
      if (a.includes('reset --hard')) { resets += 1; if (resets === 1) return { throw: new Error('reset 炸了') }; return { stdout: '' }; }
      return { stdout: '' };
    });
    const logs = [];
    let err = null;
    try {
      await restoreCheckpoint('/ws', { turnIndex: 1, kind: 'git', ref: 'cpsha' }, { exec, log: (l, m, e) => logs.push([l, m, e]) });
    } catch (e) { err = e; }
    assert(err && err.rolledBack === true, '标记已回滚');
    assert(String(err.message).includes('已回滚到恢复前的工作区'), '说明回滚过');
    eq(logs.length, 1, '记一条告警');
    assert(gitCalls().some((a) => a.includes('stash') && a.includes('apply')), '回滚时把恢复前状态 apply 回来');
  });

  await test('checkpoint-restore: 恢复与回滚双失败抛 AggregateError（不吞错）', async () => {
    const { exec } = fakeExec(({ args }) => {
      const a = args.join(' ');
      if (a.includes('--is-inside-work-tree')) return { stdout: 'true' };
      if (a.includes('rev-parse --verify')) return { stdout: 'basesha\n' };
      if (a.includes('show -s')) return { stdout: 'base sha2\0auroraagent checkpoint session=s1 run=1' };
      if (a.includes('cat-file -e')) return { stdout: '' };
      if (a.includes('rev-list --count')) return { stdout: '0\n' };
      if (a.includes('reset --hard')) return { throw: new Error('reset 炸了') };
      return { stdout: '' };
    });
    let err = null;
    try {
      await restoreCheckpoint('/ws', { turnIndex: 1, kind: 'git', ref: 'cpsha' }, { exec });
    } catch (e) { err = e; }
    assert(err instanceof AggregateError, '双失败是 AggregateError');
    eq(err.errors.length, 2, '恢复失败与回滚失败都在');
    assert(String(err.message).includes('回滚'), '说清回滚也失败了');
  });

  // ——————————————— 转录裁剪 ———————————————

  await test('checkpoint-restore: trimRecordsToTurn 只裁用户轮边界', () => {
    const records = [
      { t: 'user', text: '第一轮' },
      { t: 'assistant', text: 'a1' },
      { t: 'tool_call', id: 'c1', name: 'read_file', args: { path: 'a.txt' } },
      { t: 'tool_result', id: 'c1', content: 'ok' },
      { t: 'assistant', text: 'a2' },
      { t: 'user', text: '第二轮' },
      { t: 'tool_call', id: 'c2', name: 'write_file', args: { path: 'b.txt' } },
      { t: 'tool_result', id: 'c2', content: 'ok' },
      { t: 'user', text: '第三轮' },
    ];
    eq(userTurnBoundaries(records).join(','), '0,5,8', '用户轮边界表');
    const r1 = trimRecordsToTurn(records, 1);
    eq(r1.records.length, 1, '裁到第一轮的用户消息（其后的回答与工具结果都删）');
    eq(r1.records[0].text, '第一轮', '该轮的问题留着');
    eq(r1.trimmed, 8, '报裁掉几条');
    const r2 = trimRecordsToTurn(records, 2);
    eq(r2.records.length, 6, '裁到第二轮的用户消息');
    eq(r2.records.at(-1).text, '第二轮', '末尾是第二轮的问题');
    eq(r2.records[0].text, '第一轮', '第一轮的完整往返还在');
    const r3 = trimRecordsToTurn(records, 3);
    eq(r3.records.length, 9, '最后一轮的用户消息留着');
    eq(r3.trimmed, 0, '最后一轮之后没东西可裁');
    const over = trimRecordsToTurn(records, 99);
    eq(over.trimmed, 0, '轮次越界原样返回（调用方给中文原因）');
    eq(trimRecordsToTurn(records, 0).trimmed, 0, '轮次 0 无效');
    eq(trimRecordsToTurn([], 1).records.length, 0, '空转录');
    eq(filesTouchedAfter(records, 1).join(','), 'a.txt,b.txt', '该轮用户消息之后动过的文件都算');
    eq(filesTouchedAfter(records, 3).length, 0, '最后一轮之后没有');
    assert(Array.isArray(filesTouchedAfter(records, 1)), '返回数组');
  });

  // ——————————————— 终端 /checkpoint 纯函数层 ———————————————

  await test('checkpoint-cmd: parseCheckpointArg 全子命令与错误提示', () => {
    eq(parseCheckpointArg('').action, 'list', '缺参即列表');
    eq(parseCheckpointArg('  ls ').action, 'list', 'ls 别名');
    eq(parseCheckpointArg('clean').action, 'clean', 'clean');
    eq(parseCheckpointArg('clear').action, 'clean', 'clear 别名');
    eq(parseCheckpointArg('restore 3').turnIndex, 3, 'restore 轮次');
    eq(parseCheckpointArg('restore 3 chat').withChat, true, '带 chat 连对话一起裁');
    eq(parseCheckpointArg('restore 3 chat extra').withChat, true, 'chat 位置不限');
    eq(parseCheckpointArg('diff 2').turnIndex, 2, 'diff 轮次');
    for (const bad of ['restore', 'restore x', 'restore 0', 'restore -1', 'diff', 'huh']) {
      const r = parseCheckpointArg(bad);
      eq(r.action, 'error', `「${bad}」报错`);
      assert(r.message.length > 0 && !r.message.includes('undefined'), `「${bad}」有中文原因`);
    }
    assert(parseCheckpointArg('restore').message.includes('用法'), '缺轮次给用法');
    assert(parseCheckpointArg('huh').message.includes('未知子命令'), '未知子命令点名');
  });

  await test('checkpoint-cmd: 展示行与 diff 预览', () => {
    const entries = [
      { turnIndex: 1, kind: 'git', ref: 'r1', at: Date.now(), note: '第 1 轮' },
      { turnIndex: 2, kind: 'mirror', ref: '', at: Date.now() },
    ];
    const lines = formatCheckpointLines(entries);
    eq(lines.length, 2, '一行一个');
    assert(lines[0].includes('第 2 轮'), '新的在前');
    assert(lines[0].includes('内容镜像'), '镜像路径标注方式');
    assert(lines[1].includes('git'), 'git 路径标注方式');
    assert(lines[1].includes('第 1 轮'), '说明带上');
    eq(formatCheckpointLines([]).length, 1, '空清单给一行');
    assert(formatCheckpointLines([])[0].includes('还没有检查点'), '空清单给可操作提示');
    assert(formatCheckpointLine({ turnIndex: 5, kind: 'git' }).includes('—'), '没时间给占位');
    const records = [
      { t: 'user', text: '一' },
      { t: 'tool_call', id: 'c1', name: 'write_file', args: { path: 'x.txt' } },
      { t: 'user', text: '二' },
      { t: 'tool_call', id: 'c2', name: 'edit_file', args: { path: 'y.txt' } },
    ];
    const dl = formatCheckpointDiffLines(records, 1, entries);
    assert(dl[0].includes('第 1 轮'), '标题带轮次');
    assert(dl.some((l) => l.includes('x.txt')), '列出会动的文件');
    assert(dl.some((l) => l.includes('y.txt')), '之后改的也列');
    assert(dl.some((l) => l.includes('对话记录将保留')), '说明对话默认不动');
    const noHit = formatCheckpointDiffLines(records, 9, entries);
    eq(noHit.length, 1, '没有那个检查点给一行');
    assert(noHit[0].includes('没有检查点'), '说清楚');
    const clean = formatCheckpointDiffLines([{ t: 'user', text: '一' }], 1, entries);
    assert(clean.some((l) => l.includes('没有文件被改动')), '没有改动时说明白');
  });

  // ——————————————— 真 git 仓库端到端 ———————————————

  if (hasGit) {
    await test('checkpoint(e2e): 真 git 仓库快照可存可还原（含未跟踪文件）', async () => {
      const { dir, ws, git } = realGitRepo({ 'a.txt': 'v1\n' });
      const rt = createCheckpointRuntime({ workspace: ws, dataDir: dir, sessionId: 's1' });
      await rt.beginTurn(1);
      eq(rt.kind, 'git', '认成 git 仓库');
      const e1 = rt.entries[0];
      assert(e1 && e1.ref, '拿到快照 ref');
      // 快照后改一个已跟踪 + 建一个未跟踪
      writeFileSync(join(ws, 'a.txt'), 'v2 改坏\n');
      writeFileSync(join(ws, 'untracked.txt'), '本轮新建\n');
      const e2 = await rt.beginTurn(2);
      assert(e2 && e2.ref, '第二轮也拍到');
      eq(git(['rev-parse', '--verify', checkpointRef('s1', 2)]).trim(), e2.ref, '私有 ref 真的存在');
      // 未跟踪文件进了第三父
      const parents = git(['show', '-s', '--format=%P', e2.ref]).trim().split(/\s+/);
      assert(parents.length >= 3, '第三父在（未跟踪文件）');
      eq(git(['show', `${e2.ref}^3:untracked.txt`]).trim(), '本轮新建', '未跟踪内容可从快照取出');
      eq(git(['show', `${e2.ref}:a.txt`]).trim(), 'v2 改坏', '已跟踪改动在 stash 树里');
      assert(!git(['stash', 'list']).trim(), '不进用户的 stash 列表');
      await rt.close();
      eq(git(['for-each-ref', '--format=%(refname)', `${CHECKPOINT_REF_PREFIX}s1/`]).trim(), '', 'close 后 ref 消失');
    });

    await test('checkpoint(e2e): 恢复把工作区带回检查点（未跟踪新建文件被清掉）', async () => {
      const { dir, ws, git } = realGitRepo({ 'a.txt': 'v1\n' });
      const rt = createCheckpointRuntime({ workspace: ws, dataDir: dir, sessionId: 's1' });
      await rt.beginTurn(1);
      writeFileSync(join(ws, 'a.txt'), 'v2 改坏\n');
      writeFileSync(join(ws, 'made.txt'), '本轮新建\n');
      await rt.beginTurn(2);
      const entry = rt.entries.find((e) => e.turnIndex === 1);
      const logs = [];
      const r = await restoreCheckpoint(ws, entry, { dataDir: dir, log: (l, m, e) => logs.push([l, m, e]) });
      eq(r.kind, 'commit', '干净仓库的快照是 commit 形状（按 reset 恢复）');
      eq(readFileSync(join(ws, 'a.txt'), 'utf8'), 'v1\n', '已跟踪文件回到快照时');
      assert(!existsSync(join(ws, 'made.txt')), '检查点之后新建的未跟踪文件被回滚');
      eq(logs.length, 0, '顺利无告警');
      assert(!git(['stash', 'list']).trim(), '事务 ref 没污染用户 stash 列表');
      // HEAD 未被移动：分支历史不受影响
      assert(git(['rev-parse', 'HEAD']).trim(), 'HEAD 仍在');
    });

    await test('checkpoint(e2e): 恢复失败时工作区还原回原样', async () => {
      const { dir, ws } = realGitRepo({ 'a.txt': 'v1\n' });
      const rt = createCheckpointRuntime({ workspace: ws, dataDir: dir, sessionId: 's1' });
      await rt.beginTurn(1);
      writeFileSync(join(ws, 'a.txt'), 'v2 我的在制品\n');
      writeFileSync(join(ws, 'wip.txt'), '未跟踪在制品\n');
      await rt.beginTurn(2);
      // 用一个指向不存在 ref 的条目让恢复必然失败
      let err = null;
      try {
        await restoreCheckpoint(ws, { turnIndex: 2, kind: 'git', ref: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, { dataDir: dir });
      } catch (e) { err = e; }
      assert(err, '恢复失败抛错');
      eq(err.rolledBack, true, '已回滚');
      eq(readFileSync(join(ws, 'a.txt'), 'utf8'), 'v2 我的在制品\n', '已跟踪改动还在');
      assert(existsSync(join(ws, 'wip.txt')), '未跟踪在制品还在');
    });
  } else {
    await test('checkpoint(e2e): 环境无 git——跳过真仓库用例', () => assert(true, '跳过'));
  }

  // ——————————————— Loop 接入点 ———————————————

  await test('checkpoint: Loop 每轮开头拍快照、事件出、meta 落历史', async () => {
    const dir = keep(mkdtempSync(join(tmpdir(), 'aurora-cploop-')));
    const ws = join(dir, 'workspace');
    mkdirSync(ws, { recursive: true });
    const begun = [];
    const rt = createCheckpointRuntime({ workspace: '', dataDir: dir, sessionId: 's1' });
    const fake = { ...rt, enabled: true, kind: 'git', beginTurn: async (n, note) => { begun.push(n); return { turnIndex: n, kind: 'git', ref: `r${n}`, at: Date.now(), createdAt: Date.now(), note }; }, entries: [{ turnIndex: 1, kind: 'git', ref: 'r1', at: 1, createdAt: 1, note: '' }] };
    const { result, events, store, session } = await runLoop({ framesByCall: [textFrames('好的')], checkpoints: fake });
    eq(result.failed, undefined, 'turn 成功');
    eq(begun.join(','), '1', '本轮拍一次');
    const ev = events.find((e) => e.type === 'checkpoint_created');
    assert(ev, '发 checkpoint_created 事件');
    eq(ev.turnIndex, 1, '事件带轮次');
    eq(ev.kind, 'git', '事件带方式');
    eq(ev.ref, 'r1', '事件带 ref');
    const meta = store.get(session.id).meta;
    assert(meta.checkpoints && meta.checkpoints.entries.length === 1, '历史落进会话 meta');
    eq(meta.checkpoints.entries[0].ref, 'r1', 'meta 里的 ref');
  });

  await test('checkpoint: Loop 轮次号接续会话已有轮数', async () => {
    const begun = [];
    const fake = { enabled: true, kind: 'git', beginTurn: async (n) => { begun.push(n); return { turnIndex: n, kind: 'git', ref: 'r', at: 1, createdAt: 1, note: '' }; }, entries: [], capture() {} };
    await runLoop({ framesByCall: [textFrames('好的')], checkpoints: fake, sessionPatch: { turns: 4 } });
    eq(begun.join(','), '5', '接在已有轮数后面');
  });

  await test('checkpoint: 不注入检查点（侧边 / 子代理 / 旧调用方）时完全空转', async () => {
    const { result, events } = await runLoop({ framesByCall: [textFrames('好的')] });
    eq(result.failed, undefined, 'turn 正常');
    assert(!events.some((e) => e.type === 'checkpoint_created'), '不发事件');
  });

  await test('checkpoint: 快照失败只告警不挡 turn', async () => {
    const logs = [];
    const fake = { enabled: true, kind: 'git', beginTurn: async () => { throw new Error('git 炸了'); }, entries: [], capture() {} };
    const { result } = await runLoop({ framesByCall: [textFrames('好的')], checkpoints: fake });
    eq(result.failed, undefined, 'turn 照常跑');
    const { result: r2 } = await runLoop({ framesByCall: [textFrames('好的')], checkpoints: { ...fake, enabled: false } });
    eq(r2.failed, undefined, '禁用的运行时也不挡');
  });

  await test('checkpoint: write_file 落笔前把原内容抄进本轮镜像', async () => {
    const captured = [];
    const fake = { enabled: true, kind: 'mirror', beginTurn: async (n) => ({ turnIndex: n, kind: 'mirror', ref: '', at: 1, createdAt: 1, note: '' }), entries: [], capture: (abs) => captured.push(abs) };
    const { result, ws: loopWs } = await runLoop({
      framesByCall: [toolFrames('write_file', { path: 'a.txt', content: '新内容\n' }), textFrames('写好了')],
      checkpoints: fake, wsFiles: { 'a.txt': '原文\n' },
    });
    eq(result.failed, undefined, '工具照常执行');
    eq(captured.length, 1, 'write_file 触发一次 capture');
    assert(captured[0].endsWith('a.txt'), 'capture 的是绝对路径');
    assert(captured[0].startsWith(loopWs), 'capture 的是本工作区内的路径');
    eq(readFileSync(join(loopWs, 'a.txt'), 'utf8'), '新内容\n', '文件真的被写了');
  });

  await test('checkpoint: 真实镜像运行时经 Loop 走完可 restoreMirror 回滚', async () => {
    const dir = keep(mkdtempSync(join(tmpdir(), 'aurora-cpmirror-')));
    const ws = join(dir, 'workspace');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'a.txt'), '原文\n');
    const rt = createCheckpointRuntime({ workspace: ws, dataDir: dir, sessionId: 's1' });
    const fake = { ...rt, enabled: true, kind: 'mirror', beginTurn: async (n) => rt.beginTurn(n), entries: [], capture: (abs) => rt.capture(abs) };
    const { result } = await runLoop({
      framesByCall: [toolFrames('write_file', { path: 'a.txt', content: '被改坏\n' }), textFrames('好了')],
      checkpoints: fake, ws,
    });
    eq(result.failed, undefined, 'turn 正常');
    eq(readFileSync(join(ws, 'a.txt'), 'utf8'), '被改坏\n', '写进去了');
    const r = restoreMirror(dir, 's1', 1, ws);
    eq(r.restored, 1, '还原一个');
    eq(readFileSync(join(ws, 'a.txt'), 'utf8'), '原文\n', '内容回到本轮开始前');
  });
}
