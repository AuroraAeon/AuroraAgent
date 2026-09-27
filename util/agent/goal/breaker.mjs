/**
 * Goal 熔断器：两个独立计数器，共享一个配置上限但从不相加——
 *   noProgressStreak  归一化回复指纹连续相同（模型在原地打转）
 *   noToolStreak      连续多个 goal 轮正常结束却一个工具都没提交（光说不练）
 * 工具信号缺失或不可信时 noToolStreak 重置为 0，不把「不可信的零」计成零。
 * 任一计数器触顶 → paused(no_progress)。
 */

/** 归一化回复指纹：去空白、截断，取稳定哈希（零依赖，FNV-1a 变体） */
export function replyFingerprint(text) {
  const norm = String(text || '').replace(/\s+/g, '').slice(0, 512);
  if (!norm) return '';
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(36);
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
