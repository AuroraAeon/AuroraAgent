/**
 * 工具级 turn 断点（durable-lite，迁移 pi packages/durable 的「任务可恢复」语义最小集）。
 *
 * 我们要的那个能力很窄：进程在 turn 中途被杀（崩溃 / 强杀 / LaunchAgent 重启）后，
 * 同一 opId 重放时不必把已经跑过的工具再跑一遍。pi 用完整的文档存储 + 版本迁移 +
 * 检查点策略引擎做这件事；本地单用户工具不需要那套，落到最小可用形态：
 *
 *  - 一个 turn 一个 JSON 文件（<数据目录>/turns/<turnId>.json），原子落盘（util/atomic.mjs 0600）；
 *  - 内容是「本轮 assistant 想调哪些工具」+「哪些调用的结果已经写进转录」；
 *  - 恢复只补一件事：转录里既没有 tool_result、也没标记 settled 的调用，重新执行。
 *
 * 刻意不做（lite 边界，与 pi 的差距写在这里免得后人误读）：
 *  - 不记模型流式文本，不重放模型轮（重放模型轮意味着重花钱，且上游无幂等保证）；
 *  - 不做版本迁移（v 不匹配按无断点处理，退回全量重跑）；
 *  - 「工具已执行、进程死于标 settled 之前」的窄窗口会重跑该工具——read_file / grep 这类
 *    只读工具重跑无害，write_file / shell 可能重复副作用。lite 接受这个代价：窗口只有
 *    「store.append(tool_result) 返回」到「写断点文件」之间几毫秒，且需要恰好在此期间被杀；
 *  - 断点生命周期 = 进程级：turn 结束（含异常 / 中止）即删，不在 per-call 删。
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic.mjs';

/** 断点文件结构版本：不匹配按「没有断点」处理 */
const TURN_CHECKPOINT_VERSION = 1;
/** turnId 直接进文件名：只允许 URL / 文件名安全字符，长度封顶（防目录穿越） */
const TURN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** turnId 能否安全用作断点文件名（外部传入的 opId 必须过这道闸） */
export function isSafeTurnId(id) {
  return TURN_ID_PATTERN.test(String(id || ''));
}

/** 断点目录：<数据目录>/turns（与 sessions / workspace 平级） */
export function turnCheckpointDir(dataDir) {
  return join(String(dataDir || ''), 'turns');
}

export function turnCheckpointPath(dataDir, turnId) {
  return join(turnCheckpointDir(dataDir), `${turnId}.json`);
}

/** 写断点（原子 + 0600：turnId 泄露等于知道别人在跑什么，不该全局可读） */
export function writeTurnCheckpoint(dataDir, turnId, checkpoint) {
  try {
    mkdirSync(turnCheckpointDir(dataDir), { recursive: true });
    writeFileAtomic(turnCheckpointPath(dataDir, turnId), JSON.stringify({
      v: TURN_CHECKPOINT_VERSION,
      at: new Date().toISOString(),
      ...checkpoint,
    }));
  } catch { /* 断点是尽力而为：写失败不影响 turn 本身，退回无恢复 */ }
}

/** 读断点：结构不符 / 版本不符 / 文件损坏一律当没有（安静退回全量重跑） */
export function readTurnCheckpoint(dataDir, turnId) {
  if (!isSafeTurnId(turnId)) return null;
  const path = turnCheckpointPath(dataDir, turnId);
  if (!existsSync(path)) return null;
  try {
    const cp = JSON.parse(readFileSync(path, 'utf8'));
    if (!cp || typeof cp !== 'object') return null;
    if (cp.v !== TURN_CHECKPOINT_VERSION) return null;
    if (!Array.isArray(cp.assistant?.toolCalls) || !Array.isArray(cp.settled)) return null;
    return cp;
  } catch {
    return null;
  }
}

export function clearTurnCheckpoint(dataDir, turnId) {
  if (!isSafeTurnId(turnId)) return;
  try { rmSync(turnCheckpointPath(dataDir, turnId), { force: true }); } catch { /* 清不掉不抛：下次同 turnId 会被覆盖写 */ }
}

/**
 * 断点 → 恢复计划。
 *
 * 判定口径（与 context.mjs 的悬空 tool_call 补合成同一套 id 语义）：
 *  - 转录里已有该 id 的 tool_result → 已完成，跳过；
 *  - 断点 settled 里有该 id → 上一进程已经把它写进转录过（哪怕这次投照射不到），跳过；
 *  - 其余 → pending，需要重新执行。
 *
 * needsRecord 标记「转录里连 tool_call 记录都没有」（进程死于 beginCall 落盘之前）：
 * 恢复时必须先把 tool_call 记录补进去，否则投影出的消息序列里这次调用不存在，
 * 补出来的 tool_result 会成无配对结果被 context.mjs 丢掉。
 */
export function planTurnRecovery(checkpoint, records) {
  const calls = Array.isArray(checkpoint?.assistant?.toolCalls) ? checkpoint.assistant.toolCalls : [];
  const settled = new Set(Array.isArray(checkpoint?.settled) ? checkpoint.settled.map(String) : []);
  const answered = new Set();
  const recorded = new Set();
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || typeof r !== 'object') continue;
    if (r.t === 'tool_result') answered.add(String(r.id || ''));
    else if (r.t === 'tool_call') recorded.add(String(r.id || ''));
  }
  const pending = [];
  let skipped = 0;
  for (const c of calls) {
    const id = String(c?.id || '');
    if (!id) continue;
    if (answered.has(id) || settled.has(id)) { skipped += 1; continue; }
    pending.push({
      id,
      name: String(c.name || ''),
      args: c.args && typeof c.args === 'object' && !Array.isArray(c.args) ? c.args : {},
      needsRecord: !recorded.has(id),
    });
  }
  return { pending, skipped, round: Number.isInteger(checkpoint?.round) ? checkpoint.round : 0 };
}
