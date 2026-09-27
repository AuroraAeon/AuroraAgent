/**
 * 用户面目标操作的单一事实源：REST 面（util/agent/http.mjs）与终端 /goal 共用。
 * 权限模型见 types.mjs 头注——用户可暂停 active、任意状态停止、恢复
 * paused/blocked/usage_limited；complete / budget_limited 恢复 active 一律拒绝；
 * 预算或工作量耗尽的目标只能靠「抬高 / 清除 token 预算」重新武装。
 * 另提供「设置目标文本」（create-or-edit，/goal <objective> 与网页 Composer 共用）
 * 与「移除目标」（clear，幂等）两个非状态迁移操作。
 * 所有拒绝都抛 GoalConflictError（message 说清原因 + code 供上层映射状态码）。
 */
import { canTransition, GOAL_STATUS_LABELS } from './types.mjs';
import { rearmAfterBudgetRaise } from './budget.mjs';
import { GoalConflictError } from './store.mjs';

/** 非状态冲突类拒绝（坏入参）的 code：上层映射 400 而非 409 */
export const GOAL_BAD_INPUT_CODES = ['GOAL_BAD_BUDGET', 'GOAL_BAD_ACTION', 'GOAL_BAD_OBJECTIVE'];

/**
 * 应用一次用户面目标操作。
 * @param action  pause | resume | stop | budget
 * @param opts.tokenBudget       budget 动作的新预算（正整数或 null=清除）
 * @param opts.expectedUpdatedAt budget 动作的 CAS 决策纪元（可选，不符抛 GOAL_STALE）
 * @returns 变更后的 goal
 */
export function applyUserGoalAction(store, sessionId, action, { tokenBudget, expectedUpdatedAt, objective } = {}) {
  const cur = store.get(sessionId);
  if (!cur) throw new GoalConflictError('当前会话没有目标', 'GOAL_NOT_FOUND');
  const conflict = (message) => { throw new GoalConflictError(message, 'GOAL_STATUS_CONFLICT'); };
  switch (String(action || '')) {
    case 'pause':
      if (!canTransition(cur.status, 'paused')) conflict(`当前状态（${GOAL_STATUS_LABELS[cur.status]}）不能暂停`);
      return store.update(sessionId, (g) => ({ ...g, status: 'paused', statusReason: 'paused(user_requested)', executionWait: null }));
    case 'resume':
      if (!canTransition(cur.status, 'active')) {
        conflict(cur.status === 'budget_limited' ? '预算耗尽的目标不能直接恢复：请先抬高或清除预算' : '已完成的目标不能恢复：请创建新目标');
      }
      return store.update(sessionId, (g) => ({ ...g, status: 'active', statusReason: null }));
    case 'stop':
      if (cur.status === 'complete') conflict('目标已完成，无需停止');
      return store.update(sessionId, (g) => ({ ...g, status: 'complete', statusReason: 'complete(user_requested)', executionWait: null }));
    case 'edit': {
      const text = String(objective || '').trim().slice(0, 2000);
      if (!text) throw new GoalConflictError('目标内容不能为空：/goal <你想达成的目标>', 'GOAL_BAD_OBJECTIVE');
      if (cur.status === 'complete') conflict('已完成的目标不能改写：请用 /goal <新目标内容> 创建新目标');
      return store.update(sessionId, (g) => ({ ...g, objective: text }));
    }
    case 'budget': {
      const tb = tokenBudget === undefined ? null : tokenBudget;
      if (tb !== null && (!Number.isInteger(tb) || tb <= 0)) {
        throw new GoalConflictError('tokenBudget 需为正整数或 null（清除上限）', 'GOAL_BAD_BUDGET');
      }
      return store.update(sessionId, (g) => rearmAfterBudgetRaise(g, tb), { expectedUpdatedAt });
    }
    default:
      throw new GoalConflictError(`未知操作：${action}`, 'GOAL_BAD_ACTION');
  }
}


/**
 * 设置目标文本（/goal <objective>，终端与网页 Composer 共用）：
 * 没有目标或旧目标已 complete → 创建新目标；否则改写未完成目标的 objective。
 * tokenBudget 传入（含 null）时一并走预算变更（保留重新武装语义）。
 * @returns 变更后的 goal
 */
export function setUserGoalObjective(store, sessionId, objective, tokenBudget) {
  const text = String(objective || '').trim().slice(0, 2000);
  if (!text) throw new GoalConflictError('目标内容不能为空：/goal <你想达成的目标>', 'GOAL_BAD_OBJECTIVE');
  const cur = store.get(sessionId);
  if (!cur || cur.status === 'complete') {
    return store.create(sessionId, { objective: text, tokenBudget: tokenBudget === undefined ? null : tokenBudget });
  }
  return store.update(sessionId, (g) => {
    const next = { ...g, objective: text };
    return tokenBudget === undefined ? next : { ...next, ...rearmAfterBudgetRaise(g, tokenBudget) };
  });
}

/** 移除目标（/goal clear）：幂等，没有目标时 cleared=false（不抛错） */
export function clearUserGoal(store, sessionId) {
  return { cleared: store.remove(sessionId) };
}
