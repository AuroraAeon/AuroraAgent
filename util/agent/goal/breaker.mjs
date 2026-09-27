/**
 * Goal 熔断器：两个独立计数器，共享一个配置上限但从不相加——
 *   noProgressStreak  归一化回复指纹连续相同（模型在原地打转）
 *   noToolStreak      连续多个 goal 轮正常结束却一个工具都没提交（光说不练）
 * 工具信号缺失或不可信时 noToolStreak 重置为 0，不把「不可信的零」计成零。
 * 阶梯（对齐 MiniMax decideAction）：第 1 次观察只记录、第 2 次起注入纠正提醒
 * （nudge）、第 limit 次才转 paused(no_progress)——给模型纠偏机会再断闸。
 * 无可用回复文本（纯工具轮）不携带指纹证据：指纹与连胜原样保持，既不清零也不
 * 累加——杜绝「交替空轮 + 复读」绕过熔断（对齐 MiniMax scoresReply 语义）。
 * 任一计数器触顶 → paused(no_progress)。指纹算法与 MiniMax 逐字节同语义：
 * 模型改一个内部空格都算新回复（展示性重排不赦免），杜绝「换皮复读」漏网。
 */
import { createHash } from 'node:crypto';


/** 归一化回复指纹：仅行尾形态与首尾空白算展示差异，内部内容原样参与哈希
 * （语义对齐 MiniMax fingerprintThreadGoalReply：行尾归一化 + trim + sha256 全文） */
export function replyFingerprint(text) {
  const normalized = String(text ?? '').replace(/\r\n?|\n/gu, '\n').trim();
  if (!normalized) return '';
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * 用一轮结果推进熔断状态，返回新状态（纯函数）。
 * @param goal 当前目标行
 * @param round { replyText, toolCommitted, toolSignalTrustworthy }
 */
export function advanceBreakers(goal, round = {}) {
  const limit = Math.max(2, Math.floor(round.limit ?? 3));
  const next = { ...goal };
  let replyTripped = false;
  let replyNudge = false;
  const fp = replyFingerprint(round.replyText);
  if (fp) {
    if (fp === goal.replyFingerprint) next.noProgressStreak = goal.noProgressStreak + 1;
    else { next.replyFingerprint = fp; next.noProgressStreak = 1; }
    replyTripped = next.noProgressStreak >= limit;
    replyNudge = !replyTripped && next.noProgressStreak >= 2;
  }
  // 空回复（无指纹证据）：replyFingerprint 与 noProgressStreak 原样保持
  let toolTripped = false;
  let toolNudge = false;
  if (round.toolSignalTrustworthy === false || round.toolCommitted) {
    next.noToolStreak = 0;
  } else {
    next.noToolStreak = goal.noToolStreak + 1;
    toolTripped = next.noToolStreak >= limit;
    toolNudge = !toolTripped && next.noToolStreak >= 2;
  }
  const tripped = replyTripped || toolTripped;
  const nudge = [];
  if (!tripped) {
    if (replyNudge) nudge.push('reply');
    if (toolNudge) nudge.push('no_tool');
  }
  return { goal: next, tripped, by: replyTripped ? 'reply' : toolTripped ? 'no_tool' : null, nudge };
}
