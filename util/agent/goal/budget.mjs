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
 * 返回**增量**（status / statusReason / tokenBudget 中实际变化的项），调用方与目标文本等
 * 其他字段变更复合时不会被旧值覆盖：{ ...goal, ...rearmAfterBudgetRaise(goal, tb) }。
 */
export function rearmAfterBudgetRaise(goal, tokenBudget) {
  const cleared = tokenBudget === null;
  const raised = Number.isInteger(tokenBudget) && tokenBudget > goal.tokensUsed;
  // 仅 token 触顶可经「抬高到已用之上 / 清零」重新武装；主轮与活跃时间耗尽不认 token 预算
  const tokenLimited = goal.status === 'budget_limited' && goal.statusReason === 'budget_limited(token)';
  const nextBudget = cleared ? null : Number.isInteger(tokenBudget) && tokenBudget > 0 ? tokenBudget : goal.tokenBudget;
  if (tokenLimited && (cleared || raised)) {
    return { status: 'active', statusReason: null, tokenBudget: nextBudget };
  }
  return { tokenBudget: nextBudget };
}

/** 紧凑计数：>=10 或整数取整，否则保留一位小数（对齐 MiniMax formatCompactCount：12.5→13、1.2→1.2、20→20） */
function formatCompactCount(value) {
  return value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
}

/** token 紧凑计数：<1K 原样、<1M 记 K、其余记 M（对齐 MiniMax formatGoalCount） */
export function formatGoalCount(rawValue) {
  const value = Math.max(0, Math.floor(Number(rawValue) || 0));
  if (value < 1000) return String(value);
  if (value < 1000000) return `${formatCompactCount(value / 1000)}K`;
  return `${formatCompactCount(value / 1000000)}M`;
}

/** 时长格式：<60s 记 s、<60min 记 min+s、其余记 h+min+s，秒位不省略（对齐 MiniMax formatTuiDuration：2h9min30s） */
export function formatGoalDuration(rawSeconds) {
  const totalSeconds = Number.isFinite(rawSeconds) ? Math.max(0, Math.floor(rawSeconds)) : 0;
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}min${seconds}s`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h${totalMinutes % 60}min${seconds}s`;
}

/** 用量芯片：tokens[ / 预算] · 时长（终端 footer / 状态变更行与网页 GoalBar 共用同一套格式化） */
export function goalUsageChip(goal) {
  const cap = goal.tokenBudget != null ? ` / ${formatGoalCount(goal.tokenBudget)}` : '';
  return `${formatGoalCount(goal.tokensUsed)}${cap} · ${formatGoalDuration(goal.timeUsedSeconds)}`;
}
