/**
 * Goal 预算：token / 主轮 / 活跃时间三维记账与触顶迁移（语义对齐 minimax-code
 * accounting.rs：token  bump 与状态翻转原子完成）。三个维度互相独立，
 * 任一触顶即把 active 迁到对应 budget_limited 原因；graceSteps 是触顶后的宽限轮数
 * （默认 1，封顶 3）——给模型一轮收尾空间，避免「还差一句话说完」被硬切。
 */

/** 把一轮用量并进目标，返回新状态（纯函数；是否落盘由调用方决定） */
export function applyUsage(goal, { tokens = 0, turnSeconds = 0, isGoalTurn = true }) {
  const next = { ...goal };
  next.tokensUsed = goal.tokensUsed + Math.max(0, Math.floor(tokens || 0));
  next.timeUsedSeconds = goal.timeUsedSeconds + Math.max(0, Math.floor(turnSeconds || 0));
  if (isGoalTurn) next.turnsUsed = goal.turnsUsed + 1;
  return next;
}

/**
 * 检查预算触顶。返回 null 表示仍在预算内；否则返回 { reason, budget } 描述触顶维度。
 * graceSteps > 0 时：turnsUsed 已超过「上限 + 宽限」才真正判负（宽限轮内不拦）。
 */
export function budgetBreach(goal, limits = {}) {
  if (goal.status !== 'active') return null;
  const grace = Math.max(0, Math.floor(limits.graceSteps ?? 1));
  if (goal.tokenBudget != null && goal.tokensUsed >= goal.tokenBudget) {
    return { reason: 'budget_limited(token)', budget: goal.tokenBudget };
  }
  if (Number.isFinite(limits.mainTurns) && limits.mainTurns > 0 && goal.turnsUsed > limits.mainTurns + grace) {
    return { reason: 'budget_limited(main_turn)', budget: limits.mainTurns };
  }
  if (Number.isFinite(limits.activeSeconds) && limits.activeSeconds > 0 && goal.timeUsedSeconds > limits.activeSeconds + grace) {
    return { reason: 'budget_limited(active_time)', budget: limits.activeSeconds };
  }
  return null;
}

/**
 * 受守卫的 token 预算变更：仅抬高到已用额度之上、或清零，才能把
 * budget_limited(token) 重新武装回 active。主轮与活跃时间耗尽不能靠改 token 预算恢复。
 */
export function rearmAfterBudgetRaise(goal, tokenBudget) {
  const cleared = tokenBudget === null;
  const raised = Number.isInteger(tokenBudget) && tokenBudget > goal.tokensUsed;
  // 仅 token 触顶可经「抬高到已用之上 / 清零」重新武装；主轮与活跃时间耗尽不认 token 预算
  const tokenLimited = goal.status === 'budget_limited' && goal.statusReason === 'budget_limited(token)';
  if (tokenLimited && (cleared || raised)) {
    return { ...goal, status: 'active', statusReason: null, tokenBudget: cleared ? null : tokenBudget };
  }
  return { ...goal, tokenBudget: cleared ? null : Number.isInteger(tokenBudget) && tokenBudget > 0 ? tokenBudget : goal.tokenBudget };
}

/** footer / banner 共用的用量摘要：'12.5K · 2m' 形态；无预算时刻度只显示已用与时长 */
export function goalUsageChip(goal, { now = Date.now() } = {}) {
  const tokens = goal.tokensUsed >= 1000 ? `${(goal.tokensUsed / 1000).toFixed(1)}K` : String(goal.tokensUsed);
  const mins = Math.floor(goal.timeUsedSeconds / 60);
  const secs = goal.timeUsedSeconds % 60;
  const time = mins > 0 ? `${mins}m${secs > 0 ? `${secs}s` : ''}` : `${secs}s`;
  const cap = goal.tokenBudget != null
    ? ` / ${goal.tokenBudget >= 1000 ? `${(goal.tokenBudget / 1000).toFixed(1)}K` : goal.tokenBudget}`
    : '';
  return `${tokens}${cap} · ${time}`;
}
