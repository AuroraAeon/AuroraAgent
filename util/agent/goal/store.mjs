/**
 * Goal 存储：<数据目录>/goals/<sessionId>.json，一会话一个文件、临时文件 + rename 原子落盘。
 * updatedAt 兼作「决策纪元」：任何写操作都可带 expectedUpdatedAt 做 CAS，
 * 并发用户改写在结算前重新校验——用户改写的优先级永远高于模型提案。
 * 每次 update 都严格推进纪元（同毫秒也 +1），陈旧快照必然失配。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createGoalState, normalizeGoalState } from './types.mjs';

export class GoalConflictError extends Error {
  constructor(message, code = 'GOAL_STATUS_CONFLICT') {
    super(message);
    this.code = code;
  }
}

export class GoalStore {
  constructor(dataDir, { warn = () => {} } = {}) {
    this.dir = join(dataDir, 'goals');
    this.warn = warn;
    try { mkdirSync(this.dir, { recursive: true }); } catch (e) { this.warn('goals 目录创建失败', { error: String(e) }); }
  }

  #path(sessionId) { return join(this.dir, `${String(sessionId || '')}.json`); }

  /** 读目标；不存在返回 null（坏 JSON 按不存在处理并告警） */
  get(sessionId) {
    try {
      const raw = JSON.parse(readFileSync(this.#path(sessionId), 'utf8'));
      return normalizeGoalState(raw);
    } catch { return null; }
  }

  /** 新建或替换：仅当没有未完成目标（不存在或已 complete）时才允许 */
  create(sessionId, { objective, tokenBudget = null }) {
    const cur = this.get(sessionId);
    if (cur && cur.status !== 'complete') {
      throw new GoalConflictError(`已有未完成的目标（${cur.status}）：请先完成、暂停或停止它，再创建新目标`, 'GOAL_STATUS_CONFLICT');
    }
    const next = createGoalState({ sessionId, objective, tokenBudget });
    this.#write(next);
    return next;
  }

  /**
   * 应用一次变更。mutate(goal) 返回新状态对象（或 null 表示不变）。
   * expectedUpdatedAt 传入时做纪元校验，不符抛 GOAL_STALE——调用方应重新读快照再来。
   */
  update(sessionId, mutate, { expectedUpdatedAt } = {}) {
    const cur = this.get(sessionId);
    if (!cur) throw new GoalConflictError('当前会话没有目标', 'GOAL_NOT_FOUND');
    if (expectedUpdatedAt !== undefined && Number(expectedUpdatedAt) !== cur.updatedAt) {
      throw new GoalConflictError('目标已被其他操作修改，请重新读取最新状态后再试', 'GOAL_STALE');
    }
    const next = mutate(cur);
    if (!next) return cur;
    // 纪元随每次写操作严格推进（同毫秒内也 +1）：陈旧快照的 expectedUpdatedAt 必然失配
    this.#write(normalizeGoalState({ ...next, updatedAt: Math.max(Date.now(), cur.updatedAt + 1) }));
    return this.get(sessionId);
  }

  remove(sessionId) {
    const p = this.#path(sessionId);
    if (!existsSync(p)) return false;
    try { renameSync(p, `${p}.removed`); return true; } catch (e) { this.warn('goal 删除失败', { error: String(e) }); return false; }
  }

  #write(goal) {
    try {
      const p = this.#path(goal.sessionId);
      writeFileSync(`${p}.tmp`, JSON.stringify(goal, null, 2));
      renameSync(`${p}.tmp`, p);
    } catch (e) { this.warn('goal 写入失败', { sessionId: goal.sessionId, error: String(e) }); }
  }
}
