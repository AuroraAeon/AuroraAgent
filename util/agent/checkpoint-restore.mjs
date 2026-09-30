/**
 * 检查点恢复（对齐 Cline 的 checkpoint-restore.ts）：把工作区整体回滚到某一照，
 * 并按需把会话转录裁到那一轮为止（对话里之后的轮次删掉，代码回到照的时候）。
 *
 * 安全边界（这是全模块最重要的部分）：
 *
 *  1) 恢复前先给「当前」工作区拍一张私有快照（stash push --include-untracked →
 *     挪到私有 ref → 从用户可见的 stash 列表里摘掉）。恢复失败就 rollback 回这张快照，
 *     绝不把用户的在制品留在半恢复状态；连回滚都失败才抛 AggregateError 让人知道。
 *  2) 拒绝在「分支已经往前走过」的仓库上恢复：reset --hard 会把那些提交悄无声息地
 *     推出分支，只留 reflog 能找到。宁可拒绝，也不要毁历史。
 *  3) `git clean -fd` 只在快照确实拍了未跟踪文件（第三父在）时才跑：没有第三父的
 *     旧快照还原不了未跟踪文件，删了就是不可恢复的数据丢失。
 *  4) HEAD 的移动用 `update-ref <ref> <new> <old>` 做 git 原生的比较交换，关掉
 *     「校验完到 reset 之间」的竞态窗口。
 */
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CHECKPOINT_STASH_MESSAGE_PREFIX, restoreMirror, readCheckpointHistory } from './checkpoint.mjs';

const execFileP = promisify(execFile);
const defaultExec = (cmd, args, opts) => execFileP(cmd, args, { windowsHide: true, ...opts });

async function git(workspace, args, exec) {
  const r = await exec('git', ['-C', workspace, ...args]);
  return { stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() };
}

async function resolveOptionalGitRef(workspace, ref, exec) {
  try { return (await git(workspace, ['rev-parse', '--verify', '--quiet', ref], exec)).stdout || undefined; } catch { return undefined; }
}

/**
 * 恢复前的「当前状态」快照事务。
 * `git stash create` 不含未跟踪文件，而恢复会跑 `git clean -fd`——所以用一次性的
 * `stash push --include-untracked` 把当前状态连未跟踪文件一起收进私有 ref，
 * 再从用户可见的 stash 列表摘掉。私有 ref 只活到 commit / rollback。
 */
export async function beginWorktreeRestoreTransaction(workspace, exec = defaultExec) {
  if ((await git(workspace, ['rev-parse', '--is-inside-work-tree'], exec)).stdout !== 'true') {
    throw new Error(`${workspace} 不是 git 仓库，无法走 git 恢复事务`);
  }
  const originalHead = (await git(workspace, ['rev-parse', '--verify', 'HEAD'], exec)).stdout;
  const previousStashRef = await resolveOptionalGitRef(workspace, 'refs/stash', exec);
  const transactionId = randomUUID();
  const privateRef = `refs/auroraagent/restore-transactions/${transactionId}`;

  await git(workspace, ['stash', 'push', '--include-untracked', '--message', `auroraagent restore transaction ${transactionId}`], exec);
  const capturedRef = await resolveOptionalGitRef(workspace, 'refs/stash', exec);
  const hasSnapshot = capturedRef !== undefined && capturedRef !== previousStashRef;
  if (hasSnapshot) {
    try {
      await git(workspace, ['update-ref', privateRef, capturedRef], exec);
      await git(workspace, ['stash', 'drop', 'stash@{0}'], exec);
    } catch (captureError) {
      // 收不进私有 ref：把工作区还原回原样再抛，别把用户的在制品丢了
      try {
        await git(workspace, ['reset', '--hard', originalHead], exec);
        await git(workspace, ['clean', '-fd'], exec);
        await git(workspace, ['stash', 'apply', '--index', capturedRef], exec);
      } catch (rollbackError) {
        throw new AggregateError([captureError, rollbackError], '工作区快照与回滚都失败了');
      }
      throw captureError;
    }
  }

  let completed = false;
  return {
    async commit() {
      if (completed) return;
      completed = true;
      // 删不掉也没关系：私有 ref 无害，还留着恢复对象可救
      if (hasSnapshot) await git(workspace, ['update-ref', '-d', privateRef], exec).catch(() => undefined);
    },
    async rollback() {
      if (completed) return;
      await git(workspace, ['reset', '--hard', originalHead], exec);
      await git(workspace, ['clean', '-fd'], exec);
      if (hasSnapshot) {
        await git(workspace, ['stash', 'apply', '--index', privateRef], exec);
        await git(workspace, ['update-ref', '-d', privateRef], exec).catch(() => undefined);
      }
      completed = true;
    },
  };
}

/** 提交形状判定：stash（可 apply）/ commit（只能 reset）。老快照没记 kind 时靠消息+父数认 */
async function resolveCheckpointKind(workspace, ref, exec) {
  const r = await exec('git', ['-C', workspace, 'show', '-s', '--format=%P%x00%B', ref]);
  const stdout = String(r.stdout || '');
  const sep = stdout.indexOf('\0');
  const parents = sep < 0 ? [] : stdout.slice(0, sep).trim().split(/\s+/).filter(Boolean);
  const message = sep < 0 ? '' : stdout.slice(sep + 1);
  return parents.length >= 2 && message.includes(CHECKPOINT_STASH_MESSAGE_PREFIX) ? 'stash' : 'commit';
}

/** ref 是否连未跟踪文件一起拍了（第三父在）——只有这种快照配跑 git clean -fd */
async function checkpointCapturedUntracked(workspace, ref, exec) {
  try {
    await exec('git', ['-C', workspace, 'cat-file', '-e', `${ref}^3^{commit}`]);
    return true;
  } catch { return false; }
}

async function countCommitsBetween(workspace, from, to, exec) {
  try {
    const n = Number((await git(workspace, ['rev-list', '--count', `${from}..${to}`], exec)).stdout);
    return Number.isFinite(n) ? n : undefined;
  } catch { return undefined; }
}

/**
 * 把工作区恢复到某个检查点。
 * @param {string} workspace 工作目录
 * @param {{ turnIndex: number, kind: 'git'|'mirror', ref: string }} entry 检查点
 * @param {{ dataDir: string, exec?: Function, log?: Function }} opts
 */
export async function applyCheckpointToWorktree(workspace, entry, opts = {}) {
  const exec = opts.exec || defaultExec;
  const log = opts.log || (() => {});
  if (!entry || !Number.isInteger(entry.turnIndex)) throw new Error('检查点条目不完整（缺 turnIndex）');
  if (entry.kind === 'mirror') {
    const r = restoreMirror(opts.dataDir, opts.sessionId, entry.turnIndex, workspace);
    log('info', '已按内容镜像回滚工作区', { turnIndex: entry.turnIndex, ...r });
    return { kind: 'mirror', ...r };
  }
  if (!entry.ref) throw new Error('git 检查点缺 ref，无法恢复');

  if ((await git(workspace, ['rev-parse', '--is-inside-work-tree'], exec)).stdout !== 'true') {
    throw new Error(`${workspace} 不是 git 仓库，无法恢复 git 检查点`);
  }
  await exec('git', ['-C', workspace, 'cat-file', '-e', `${entry.ref}^{commit}`]);
  const kind = await resolveCheckpointKind(workspace, entry.ref, exec);
  const restoreBase = kind === 'commit' ? entry.ref : `${entry.ref}^1`;
  const restoreBaseSha = (await git(workspace, ['rev-parse', '--verify', `${restoreBase}^{commit}`], exec)).stdout;
  const currentHead = (await git(workspace, ['rev-parse', '--verify', 'HEAD'], exec)).stdout;
  if (currentHead !== restoreBaseSha) {
    const after = await countCommitsBetween(workspace, restoreBaseSha, currentHead, exec);
    const reason = after && after > 0
      ? `这个检查点之后当前分支又多了 ${after} 个提交，恢复会把它们从分支上摘掉`
      : '当前分支已经不在这个检查点创建时的提交上（可能 rebase 或切过分支）';
    throw new Error(`不能恢复工作区：${reason}。可以只回滚对话，或先把分支手动移回 ${restoreBaseSha.slice(0, 12)}`);
  }
  if (kind === 'stash') {
    try { await exec('git', ['-C', workspace, 'cat-file', '-e', `${entry.ref}^2^{commit}`]); }
    catch { throw new Error('这个检查点不是完整的 git stash 快照（缺 index 父提交），无法恢复'); }
  }
  const capturedUntracked = await checkpointCapturedUntracked(workspace, entry.ref, exec);
  // update-ref <ref> <new> <old> 是 git 原生的 CAS：只有 HEAD 仍指向上面校验过的提交时才移动，
  // 关掉「校验完到 reset 之间」的竞态。随后的裸 reset --hard 只是把 index 与工作区同步到
  // 已经移动好的 HEAD，不再动分支指针
  await git(workspace, ['update-ref', '-m', 'auroraagent: checkpoint restore', 'HEAD', restoreBaseSha, currentHead], exec);
  await git(workspace, ['reset', '--hard'], exec);
  // 只有拍了未跟踪文件的快照才清未跟踪文件：接下来的 stash apply 会从 ^3 把它们逐个还原，
  // 检查点之后新建的文件本该被回滚掉。git clean -fd 不动 .gitignored（构建产物 / node_modules /
  // .env），先清再 apply 也避免 "already exists" 冲突
  if (capturedUntracked) await git(workspace, ['clean', '-fd'], exec);
  if (kind === 'commit') return { kind: 'commit', ref: entry.ref };
  await git(workspace, ['stash', 'apply', entry.ref], exec);
  return { kind: 'stash', ref: entry.ref };
}

/**
 * 带事务的完整恢复：先给当前工作区拍私有快照，再恢复；失败 rollback，双失败抛 AggregateError。
 * @returns {Promise<{ rolledBack?: boolean }>} 恢复成功时无 rolledBack
 */
export async function restoreCheckpoint(workspace, entry, opts = {}) {
  const exec = opts.exec || defaultExec;
  const log = opts.log || (() => {});
  if (entry.kind !== 'mirror') {
    const tx = await beginWorktreeRestoreTransaction(workspace, exec);
    try {
      const r = await applyCheckpointToWorktree(workspace, entry, { ...opts, exec });
      await tx.commit();
      return r;
    } catch (e) {
      log('warn', '检查点恢复失败，回滚到恢复前的工作区', { turnIndex: entry.turnIndex, error: String(e?.message || e) });
      try {
        await tx.rollback();
      } catch (rollbackError) {
        // 连回滚都失败：两件事都得让人知道，别把恢复失败悄无声息地吞掉
        throw new AggregateError([e, rollbackError], '恢复失败，且回滚到恢复前的工作区也失败了');
      }
      const err = new Error(`恢复失败，已回滚到恢复前的工作区：${e?.message || e}`);
      err.rolledBack = true;
      err.cause = e;
      throw err;
    }
  }
  return applyCheckpointToWorktree(workspace, entry, { ...opts, exec });
}

// ——————————————————————————————— 转录裁剪 ———————————————————————————————

/**
 * 转录记录 → 用户轮边界表：第 n 项是「第 n 个用户轮的首条记录下标」。
 * 压缩产生的 summary 记录算在它所折叠的最后那一轮里（不新开一轮）。
 */
export function userTurnBoundaries(records) {
  const bounds = [];
  for (let i = 0; i < records.length; i += 1) {
    if (records[i]?.t === 'user') bounds.push(i);
  }
  return bounds;
}

/**
 * 把转录裁到某个用户轮为止：保留该轮的用户消息，删掉它之后的全部记录。
 * 找不到那一轮（轮次号越界）时原样返回——调用方据此给中文原因，而不是裁出错东西。
 * @returns {{ records: Array, trimmed: number }}
 */
export function trimRecordsToTurn(records, turnIndex) {
  const bounds = userTurnBoundaries(records);
  const idx = turnIndex - 1;
  if (!Number.isInteger(idx) || idx < 0 || idx >= bounds.length) return { records: records.slice(), trimmed: 0 };
  return { records: records.slice(0, bounds[idx] + 1), trimmed: records.length - (bounds[idx] + 1) };
}

/** 找出第 n 个用户轮之后被删掉的工具工作涉及的文件（给 diff 预览与恢复说明用） */
export function filesTouchedAfter(records, turnIndex) {
  const { records: kept } = trimRecordsToTurn(records, turnIndex);
  const keptIds = new Set(kept.filter((r) => r.t === 'tool_call').map((r) => r.id));
  const files = new Set();
  for (const r of records) {
    if (r.t !== 'tool_call') continue;
    if (keptIds.has(r.id)) continue;
    const p = r.args?.path;
    if (typeof p === 'string' && p) files.add(p);
  }
  return [...files];
}
