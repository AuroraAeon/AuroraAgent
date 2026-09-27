/** command.mjs 的类型声明（实现是零依赖纯函数，Node 测试、终端与网页 Composer 共用同一份）。 */
export type GoalCommandIntent =
  | { kind: 'view' }
  | { kind: 'create'; objective: string; tokenBudget: number | null }
  | { kind: 'budget'; tokenBudget: number | null }
  | { kind: 'clear' }
  | { kind: 'edit' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'stop' }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

export function parseGoalBudgetValue(raw: string): number | null | 'invalid';
export function parseGoalCommand(rawArgs: string): GoalCommandIntent;
export function goalActionHint(status: string): string;
export function formatGoalSummary(goal: {
  status: string; objective: string; tokenBudget: number | null;
  tokensUsed: number; turnsUsed: number; timeUsedSeconds: number;
  lastVerification: { verdict: string; notMetStreak?: number } | null;
}): string;
export function formatGoalReceipt(goal: { tokensUsed: number; turnsUsed: number; timeUsedSeconds: number }): string;
export const GOAL_COMMAND_HELP: string;
