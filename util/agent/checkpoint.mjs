/**
 * 检查点（快照）：每个用户轮开始前给工作目录拍一张照，之后可以整体回滚到那一照，
 * 而会话历史照样留着（对话里积累的上下文不丢）。对齐 Cline 的 checkpoint-hooks，
 * 按本地单用户 / 零依赖底线落地。
 *
 * 两条路径，按工作目录是不是 git 仓库自动选：
 *
 *  1) git 仓库——走 Cline 的原版方案，不碰用户的 git 历史：
 *     `git stash create` 拿工作区快照（它遗漏未跟踪文件），再用一个私有的持久化
 *     scratch index 把「未跟踪但未被 .gitignore 排除」的文件补成第三父提交，
 *       refs/auroraagent/checkpoints/<sessionId>/<turnIndex>
 *     私有 ref 命名空间让快照对象可达（不会被 GC）又不进 `git stash list`。
 *     scratch index 跨轮持久化，git 的 stat 缓存因此能跳过「自上一轮没变过的文件」——
 *     否则每一轮都要把工作区所有未跟踪字节重新哈希一遍。
 *     钉死 core.ignorestat=false / core.splitIndex=false：持久化 index 会继承仓库配置，
 *     ignorestat=true 会让后轮不再 stat 已加条目，改过的文件从此一直留在首轮内容里。
 *
 *  2) 非 git 仓库——降级为「内容镜像」：本轮的 write_file / edit_file 在落笔前把
 *     被改文件的原内容抄进 <数据目录>/backups/<sessionId>/<turnIndex>/，新建的文件
 *     记一条「原本不存在」，回滚时照单删回。只镜像被动过的文件（不是整个工作区），
 *     所以大仓库也不会炸；代价是 shell 工具造的文件不在管辖内（镜像管不到进程内部）。
 *
 * 两条路径都不改用户数据形态：历史写进会话 meta 的 checkpoints 段，快照本体在
 * 仓库 .git 或数据目录里。删会话时 close() 清 ref + 清备份目录。
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, statSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';

const execFileP = promisify(execFile);

/** 私有 ref 命名空间：对用户不可见（不进 git stash list），但让快照对象可达不被 GC */
export const CHECKPOINT_REF_PREFIX = 'refs/auroraagent/checkpoints/';
/** stash 消息前缀：恢复路径靠它认出「这是我们的快照」而不是用户自己的 stash */
export const CHECKPOINT_STASH_MESSAGE_PREFIX = 'auroraagent checkpoint session=';

/** scratch 目录年龄上限：会话从未被显式删除时，靠它回收（每次快照都会刷新 mtime） */
const SCRATCH_DIR_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const LS_FILES_MAX_BUFFER = 64 * 1024 * 1024;
/** 每个会话保留的检查点数上限：超了从最旧的开始删 ref（本地长期跑不至于无限膨胀） */
export const MAX_CHECKPOINT_HISTORY = 40;

/** 碰 scratch index 的每条 git 命令都要钉死这两项（理由见文件头） */
const SCRATCH_INDEX_GIT_CONFIG = ['-c', 'core.ignorestat=false', '-c', 'core.splitIndex=false'];

/** 默认执行器：execFile 语义——非零退出 reject，错误对象带 .stderr */
const defaultExec = (cmd, args, opts) => execFileP(cmd, args, { windowsHide: true, maxBuffer: LS_FILES_MAX_BUFFER, ...opts });
/** 需要往 stdin 喂数据的场景用 spawn（execFile 拿不到子进程句柄） */
const defaultSpawn = (cmd, args, opts) => spawn(cmd, args, { windowsHide: true, maxBuffer: LS_FILES_MAX_BUFFER, ...opts });

/** 快照 ref 名：<prefix><sessionId>/<turnIndex> */
export function checkpointRef(sessionId, turnIndex) {
  return `${CHECKPOINT_REF_PREFIX}${sessionId}/${turnIndex}`;
}

/**
 * 每个会话一份 scratch 目录（持久化 index + pathspec 文件）。
 * 键 = sha256(workspace + sessionId)：哈希避免不同 id 的清洗冲突，折进 workspace 让
 * 「同一会话换到别的工作目录」不会继承一份外人的 index。
 */
export function checkpointScratchDir(dataDir, workspace, sessionId) {
  const key = createHash('sha256').update(`${workspace}\0${sessionId}`).digest('hex').slice(0, 32);
  return join(dataDir, 'checkpoint-scratch', key);
}

/** 回收年龄超过上限的 scratch 目录。一切在基础目录下的都是我们的，年龄是唯一判据 */
export function pruneStaleScratchDirs(dataDir) {
  const base = join(dataDir, 'checkpoint-scratch');
  try {
    const cutoff = Date.now() - SCRATCH_DIR_MAX_AGE_MS;
    for (const name of readdirSync(base)) {
      const dir = join(base, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        if (statSync(dir).mtimeMs < cutoff) rmSync(dir, { recursive: true, force: true });
      } catch { /* 与并发会话撞车——忽略，下一轮再收 */ }
    }
  } catch { /* 基础目录不存在或读不了——没得可收 */ }
}

/** 读一份 checkpoint 历史（会话 meta.checkpoints）；坏数据当没有，绝不让快照功能挡住会话 */
export function readCheckpointHistory(meta) {
  const raw = meta?.checkpoints;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const list = Array.isArray(raw.entries) ? raw.entries : [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const turnIndex = Number(e.turnIndex);
    if (!Number.isInteger(turnIndex) || turnIndex < 1) continue;
    const kind = e.kind === 'git' || e.kind === 'mirror' ? e.kind : 'git';
    out.push({ turnIndex, kind, ref: String(e.ref || ''), at: Number(e.at) || 0, createdAt: Number(e.createdAt) || 0, note: String(e.note || '') });
  }
  return out.sort((a, b) => a.turnIndex - b.turnIndex);
}

/** 历史 → 会话 meta 里落的形状（只留必要的，别把用户 meta 撑大） */
export function writeCheckpointHistory(entries) {
  return { entries: entries.map((e) => ({ turnIndex: e.turnIndex, kind: e.kind, ref: e.ref, at: e.at, createdAt: e.createdAt, note: e.note || '' })) };
}

/** 取某个轮次（含之前最近一个）的检查点 */
export function findCheckpointForTurn(entries, turnIndex) {
  let best = null;
  for (const e of entries) {
    if (e.turnIndex > turnIndex) continue;
    if (!best || e.turnIndex > best.turnIndex) best = e;
  }
  return best;
}

// ——————————————————————————————— git 路径 ———————————————————————————————

async function git(workspace, args, exec) {
  const r = await exec('git', ['-C', workspace, ...args]);
  return { stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() };
}

async function gitWithIndex(workspace, indexFile, args, exec) {
  const r = await exec('git', ['-C', workspace, ...SCRATCH_INDEX_GIT_CONFIG, ...args], { env: { ...process.env, GIT_INDEX_FILE: indexFile } });
  return String(r.stdout || '').trim();
}

/** 把 pathspec 列表经 stdin 喂给 git（NUL 分隔）：一个进程搞定，不受命令行长度限制 */
function gitWithIndexStdin(workspace, indexFile, args, input, spawnExec = defaultSpawn) {
  return new Promise((resolve, reject) => {
    const child = spawnExec('git', ['-C', workspace, ...SCRATCH_INDEX_GIT_CONFIG, ...args], {
      env: { ...process.env, GIT_INDEX_FILE: indexFile },
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]} exited with ${code}: ${stderr.trim()}`))));
    // 没有这个监听，子进程在读完 stdin 前退出会让进程崩在 EPIPE 上
    child.stdin?.on('error', () => {});
    child.stdin?.end(input);
  });
}

/**
 * 造一棵只含「当前未跟踪（且未被 gitignore 排除）」文件的树，不动工作区、不动真 index。
 * 这正是 `git stash create --include-untracked` 会记录的第三父，plain stash create 没有它。
 */
async function createUntrackedParentCommit(workspace, scratchDir, exec, spawnExec) {
  const listing = await git(workspace, ['ls-files', '--others', '--exclude-standard', '-z'], exec);
  const untracked = listing.stdout.split('\0').filter(Boolean);
  if (!untracked.length) return undefined;
  // 0700：index 与 pathspec 枚举了工作区路径，只属于本用户
  mkdirSync(scratchDir, { recursive: true, mode: 0o700 });
  const indexFile = join(scratchDir, 'index');
  const pathspecFile = join(scratchDir, 'pathspec');
  writeFileSync(pathspecFile, `${untracked.join('\0')}\0`);
  const addArgs = ['add', '--force', '--pathspec-from-file', pathspecFile, '--pathspec-file-nul'];
  try {
    await gitWithIndex(workspace, indexFile, addArgs, exec);
  } catch (error) {
    const stderr = String(error?.stderr || '');
    if (stderr.includes('did not match any files')) throw error; // 列举后文件消失：本轮竞态，不是 index 坏
    // index 损坏或残留 index.lock（写一半被 SIGKILL）会让此后每一轮都失败：清掉重来一次
    rmSync(indexFile, { force: true });
    rmSync(`${indexFile}.lock`, { force: true });
    await gitWithIndex(workspace, indexFile, addArgs, exec);
  }
  // 摘掉已退出未跟踪集合的条目（文件被删 / 变成已跟踪），否则它们会鬼进快照树——
  // 带 pathspec 的 git add 从不删条目。尾斜杠要归一：ls-files 把未跟踪的嵌套仓库报成
  // "sub/"，index 里记的是 gitlink "sub"，不归一会把刚加进来的 gitlink 当脏数据 purge 掉
  const indexed = await exec('git', ['-C', workspace, ...SCRATCH_INDEX_GIT_CONFIG, 'ls-files', '-z'], { env: { ...process.env, GIT_INDEX_FILE: indexFile }, maxBuffer: LS_FILES_MAX_BUFFER });
  const untrackedSet = new Set(untracked.map((p) => (p.endsWith('/') ? p.slice(0, -1) : p)));
  const stale = String(indexed.stdout || '').split('\0').filter(Boolean).filter((p) => !untrackedSet.has(p));
  if (stale.length) await gitWithIndexStdin(workspace, indexFile, ['update-index', '-z', '--force-remove', '--stdin'], `${stale.join('\0')}\0`, spawnExec);
  const tree = await gitWithIndex(workspace, indexFile, ['write-tree'], exec);
  if (!tree) return undefined;
  const commit = await gitWithIndex(workspace, indexFile, ['commit-tree', tree, '-m', 'untracked files on auroraagent checkpoint'], exec);
  return commit || undefined;
}

/**
 * 造一个 stash 形状的快照提交：既有 plain stash create 的工作区改动，又把未跟踪文件
 * 补成第三父。没有可拍的东西（干净工作区 + 无未跟踪文件）时返回 undefined，让调用方
 * 退化成 HEAD 检查点。
 */
async function createWorktreeStashCommit(workspace, scratchDir, message, exec, spawnExec) {
  const stashRef = (await git(workspace, ['stash', 'create', message], exec)).stdout;
  const untrackedParent = await createUntrackedParentCommit(workspace, scratchDir, exec, spawnExec);
  if (stashRef) {
    if (!untrackedParent) return stashRef; // 只有已跟踪改动，plain stash 已覆盖
    const tree = (await git(workspace, ['rev-parse', `${stashRef}^{tree}`], exec)).stdout;
    const base = (await git(workspace, ['rev-parse', `${stashRef}^1`], exec)).stdout;
    const indexParent = (await git(workspace, ['rev-parse', `${stashRef}^2`], exec)).stdout;
    if (!tree || !base || !indexParent) return stashRef;
    return (await git(workspace, ['commit-tree', tree, '-p', base, '-p', indexParent, '-p', untrackedParent, '-m', message], exec)).stdout || stashRef;
  }
  // 已跟踪工作区干净。只在有未跟踪文件要保时合成一个 stash；否则调用方用 HEAD 检查点
  if (!untrackedParent) return undefined;
  const head = (await git(workspace, ['rev-parse', 'HEAD'], exec)).stdout;
  const headTree = (await git(workspace, ['rev-parse', 'HEAD^{tree}'], exec)).stdout;
  if (!head || !headTree) return undefined;
  // index 父照抄（未变的）HEAD 树，好让合成提交有 stash apply 期待的两 / 三父形状
  const indexParent = (await git(workspace, ['commit-tree', headTree, '-p', head, '-m', 'index on auroraagent checkpoint'], exec)).stdout;
  if (!indexParent) return undefined;
  return (await git(workspace, ['commit-tree', headTree, '-p', head, '-p', indexParent, '-p', untrackedParent, '-m', message], exec)).stdout || undefined;
}

/** 删掉某个会话的全部私有检查点 ref 与它的 scratch 目录。非 git 仓库 / ref 不存在都是空操作 */
export async function deleteCheckpointRefs(workspace, sessionId, dataDir, exec = defaultExec) {
  try { rmSync(checkpointScratchDir(dataDir, workspace, sessionId), { recursive: true, force: true }); } catch { /* 没建过 */ }
  if (!workspace) return;
  try {
    const prefix = `${CHECKPOINT_REF_PREFIX}${sessionId}/`;
    const { stdout } = await git(workspace, ['for-each-ref', '--format=%(refname)', prefix], exec);
    const refs = stdout.split('\n').filter(Boolean);
    await Promise.allSettled(refs.map((ref) => git(workspace, ['update-ref', '-d', ref], exec)));
  } catch { /* 不是 git 仓库或 git 不可用——忽略 */ }
}

/** 非 git 路径：回滚时照清单把镜像写回去 / 把新建的文件删掉 */
export function restoreMirror(dataDir, sessionId, turnIndex, workspace) {
  const dir = join(dataDir, 'backups', sessionId, String(turnIndex));
  let entries = [];
  try { entries = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')); } catch { return { restored: 0, removed: 0 }; }
  let restored = 0, removed = 0;
  for (const e of Array.isArray(entries) ? entries : []) {
    const target = join(workspace, e.path);
    if (e.existed) {
      const src = join(dir, 'files', e.path);
      if (!existsSync(src)) continue;
      mkdirSync(join(target, '..'), { recursive: true });
      copyFileSync(src, target);
      restored += 1;
    } else if (existsSync(target)) {
      try { unlinkSync(target); removed += 1; } catch { /* 正在被占用之类——跳过 */ }
    }
  }
  return { restored, removed };
}

/** 非 git 路径：清掉某个会话的全部内容镜像 */
export function deleteMirrorBackups(dataDir, sessionId) {
  try { rmSync(join(dataDir, 'backups', sessionId), { recursive: true, force: true }); } catch { /* 没建过 */ }
}

// ——————————————————————————————— 运行时 ———————————————————————————————

/**
 * 建一个会话的检查点运行时。
 * @param {{ workspace: string, dataDir: string, sessionId: string, log?: Function, exec?: Function, history?: Array }} opts
 * @returns {{ kind, entries, enabled, beginTurn(turnIndex, note), capture(abs), describe(), close() }}
 */
export function createCheckpointRuntime({ workspace = '', dataDir = '', sessionId = '', log = () => {}, exec = defaultExec, spawnExec = defaultSpawn, history = [] } = {}) {
  let entries = readCheckpointHistory({ checkpoints: { entries: history } });
  let gitWorkspace = false;
  let gitProbed = false;
  // 非 git 路径：本轮正在收集的镜像（beginTurn 建目录，capture 落原内容）
  let mirror = null;
  // 已探明不是 git 仓库后就固定走镜像，不再每轮敲 git（用户中途 git init 由重启生效）
  const probeGit = async () => {
    if (gitProbed) return gitWorkspace;
    gitProbed = true;
    if (!workspace) return false;
    try { gitWorkspace = (await git(workspace, ['rev-parse', '--is-inside-work-tree'], exec)).stdout === 'true'; } catch { gitWorkspace = false; }
    return gitWorkspace;
  };

  const headCheckpoint = async (turnIndex, note) => {
    const ref = (await git(workspace, ['rev-parse', 'HEAD'], exec)).stdout;
    if (!ref) return null;
    return { turnIndex, kind: 'git', ref, at: Date.now(), createdAt: Date.now(), note };
  };

  /** 每个用户轮开头调一次：拍快照、入历史、返回本条检查点 */
  const beginTurn = async (turnIndex, note = '') => {
    if (!Number.isInteger(turnIndex) || turnIndex < 1) return null;
    // 没有工作目录（侧边对话 / 未配置）无从拍也无从回滚：直接禁用，别去建镜像目录
    if (!workspace) return null;
    pruneStaleScratchDirs(dataDir);
    if (await probeGit()) {
      const message = `${CHECKPOINT_STASH_MESSAGE_PREFIX}${sessionId} run=${turnIndex}`;
      let entry = null;
      try {
        const ref = await createWorktreeStashCommit(workspace, checkpointScratchDir(dataDir, workspace, sessionId), message, exec, spawnExec);
        if (ref) {
          await git(workspace, ['update-ref', checkpointRef(sessionId, turnIndex), ref], exec);
          entry = { turnIndex, kind: 'git', ref, at: Date.now(), createdAt: Date.now(), note };
        }
      } catch (e) {
        log('warn', '检查点快照失败，退化为 HEAD 检查点', { sessionId, turnIndex, error: String(e?.message || e) });
      }
      if (!entry) entry = await headCheckpoint(turnIndex, note || '工作区干净，记 HEAD');
      if (!entry) return null;
      entries = upsert(entries, entry);
      return entry;
    }
    // 非 git 工作区：建镜像目录，原内容由 capture 在写落笔前补齐
    const dir = join(dataDir, 'backups', sessionId, String(turnIndex));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, 'files'), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'manifest.json'), '[]');
    mirror = { turnIndex, dir, captured: new Set() };
    const entry = { turnIndex, kind: 'mirror', ref: '', at: Date.now(), createdAt: Date.now(), note: note || '内容镜像' };
    entries = upsert(entries, entry);
    return entry;
  };

  /**
   * 非 git 路径的落笔前钩子：第一次碰某个文件时把它的原内容抄进镜像。
   * 之后同一轮再改同一文件就不再抄（要的是「本轮开始前」的样子）。
   */
  const capture = (abs) => {
    if (!mirror || !abs) return;
    const rel = relative(workspace, abs);
    if (!rel || rel.startsWith('..') || rel.includes('..')) return;
    if (mirror.captured.has(rel)) return;
    mirror.captured.add(rel);
    let list = [];
    try { list = JSON.parse(readFileSync(join(mirror.dir, 'manifest.json'), 'utf8')); } catch { list = []; }
    if (!Array.isArray(list)) list = [];
    if (list.some((e) => e && e.path === rel)) return;
    const existed = existsSync(abs);
    if (existed) {
      const dst = join(mirror.dir, 'files', rel);
      mkdirSync(join(dst, '..'), { recursive: true });
      copyFileSync(abs, dst);
    }
    list.push({ path: rel, existed });
    writeFileSync(join(mirror.dir, 'manifest.json'), JSON.stringify(list));
  };

  return {
    sessionId,
    get kind() { return gitWorkspace ? 'git' : 'mirror'; },
    get entries() { return entries.slice(); },
    get enabled() { return Boolean(workspace); },
    beginTurn,
    capture,
    describe: () => entries.slice().sort((a, b) => b.turnIndex - a.turnIndex),
    close: async () => {
      mirror = null;
      if (gitWorkspace) await deleteCheckpointRefs(workspace, sessionId, dataDir, exec);
      else deleteMirrorBackups(dataDir, sessionId);
      entries = [];
    },
  };
}

/** 同轮次重复快照时后者覆盖前者（重启后补跑不该把轮次号往前挪） */
function upsert(entries, entry) {
  const idx = entries.findIndex((e) => e.turnIndex === entry.turnIndex);
  const next = idx < 0 ? [...entries, entry] : entries.map((e, i) => (i === idx ? entry : e));
  return next.sort((a, b) => a.turnIndex - b.turnIndex).slice(-MAX_CHECKPOINT_HISTORY);
}
