/** budget.mjs 的类型声明（实现是零依赖纯函数，Node 测试、终端与网页 GoalBanner 共用同一份）。 */
export interface GoalBudgetState {
  tokensUsed: number;
  turnsUsed: number;
  timeUsedSeconds: number;
  tokenBudget: number | null;
  status?: string;
  statusReason?: string | null;
}
export function applyUsage(
  goal: GoalBudgetState,
  opts?: { tokens?: number; turnSeconds?: number; isGoalTurn?: boolean },
): GoalBudgetState;
export function budgetBreach(
  goal: GoalBudgetState,
  limits?: { graceSteps?: number; mainTurns?: number; activeSeconds?: number },
): { reason: string; budget: number | null } | null;
export function rearmAfterBudgetRaise(
  goal: GoalBudgetState,
  tokenBudget: number | null,
): { status?: string; statusReason?: string | null; tokenBudget: number | null };
export function formatGoalCount(rawValue: number): string;
export function formatGoalDuration(rawSeconds: number): string;
export function goalUsageChip(goal: GoalBudgetState): string;
