/**
 * Goal 熔断器：两个独立计数器，共享一个配置上限但从不相加——
 *   noProgressStreak  归一化回复指纹连续相同（模型在原地打转）
 *   noToolStreak      连续多个 goal 轮正常结束却一个工具都没提交（光说不练）
 * 工具信号缺失或不可信时 noToolStreak 重置为 0，不把「不可信的零」计成零。
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
  const limit = Math.max(1, Math.floor(round.limit ?? 3));
  const next = { ...goal };
  const fp = replyFingerprint(round.replyText);
  // 空回复不参与指纹比较：视为「没有可比较的回复」，指纹清零、连胜中断
  if (!fp) { next.replyFingerprint = null; next.noProgressStreak = 0; }
  else if (fp === goal.replyFingerprint) { next.noProgressStreak = goal.noProgressStreak + 1; }
  else { next.replyFingerprint = fp; next.noProgressStreak = 1; }
  // 指纹相同从第二次起累加；repeatedReplyLimit=3 即第 3 次相同触发
  const replyTripped = next.noProgressStreak >= limit;
  if (round.toolSignalTrustworthy === false) next.noToolStreak = 0;
  else if (round.toolCommitted) next.noToolStreak = 0;
  else next.noToolStreak = goal.noToolStreak + 1;
  const toolTripped = next.noToolStreak >= limit;
  return { goal: next, tripped: replyTripped || toolTripped, by: replyTripped ? 'reply' : toolTripped ? 'no_tool' : null };
}
