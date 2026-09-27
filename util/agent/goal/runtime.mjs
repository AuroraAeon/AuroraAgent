/**
 * Goal 运行时编排：loop.mjs 的唯一 goal 交互面。
 * 工具执行、用量入账、熔断推进、预算检查、终态提案结算全部收敛在本文件；
 * loop.mjs 只保留钩子调用（beginTurn / afterRound / finish），无目标会话的钩子
 * 是一次廉价读文件后原样返回，不改变正常 turn 的任何行为。
 *
 * 与 loop 的协作约定：
 *   - beginTurn() 在 turn 开始时调用，记录目标当时是否 active（决定本 turn 是否受 goal 管辖）；
 *   - afterRound() 在每个模型轮（含其工具执行）结束后调用，返回 undefined（不干预）/
 *     'finish'（本 turn 收尾）/ 'wrapup'（需追加一个无工具预算收尾轮）；
 *   - finish() 在 turn 正常结束或上游失败时调用，结算待定的终态提案。
 */
import { GoalConflictError } from './store.mjs';
import { CREATE_GOAL_DEF, UPDATE_GOAL_DEF, GET_GOAL_DEF, resolveUpdateGoalMode } from './tools.mjs';
import { applyUsage, budgetBreach, rearmAfterBudgetRaise } from './budget.mjs';
import { advanceBreakers } from './breaker.mjs';
import { goalLimits, parseGoalConfig } from './config.mjs';

/** goal 簿记工具：它们本身不算「干了活」（熔断的 noToolStreak 不因它们重置） */
const BOOKKEEPING_TOOLS = new Set(['get_goal', 'update_goal']);

/** 预算触顶后追加的唯一收尾轮的系统提醒：只总结，不让继续干活 */
export const GOAL_WRAPUP_NOTE = [
  '【目标预算收尾】本会话的进行中目标已触及预算上限，自动续跑已停止。',
  '这一轮不要调用任何工具，用一段话向用户总结：已完成什么、未完成什么、为何在此停止。',
  '并告知用户：可以说「把目标预算提高到 N」或「清除预算上限」，经 update_goal 调整后继续跑。',
].join('\n');

/** 事件与 UI 用的公开投影（存储形状已归一化，直接浅拷贝） */
export function publicGoal(goal) {
  return goal ? { ...goal } : null;
}

/**
 * @param goalStore  GoalStore 实例（一会话一个目标文件）
 * @param sessionId  当前会话
 * @param config     parseGoalConfig 的产物
 * @param harnessTools 当前 harness 收录的工具名（goal 三项仅 standard/ultimate 有）
 * @param emit       AgentEvent 出口
 */
export function createGoalRuntime({ goalStore, sessionId, config, harnessTools = [], emit, log = () => {} }) {
  const cfg = config || parseGoalConfig(null);
  const limits = goalLimits(cfg);
  let pendingProposal = null;    // 本 turn 的终态提案 { status, summary }
  let createdThisTurn = false;   // 本 turn 内经 create_goal 武装
  let goalActiveAtStart = false; // turn 开始时目标是否 active

  const allowed = (name) => harnessTools.includes(name);
  const inPlay = () => goalActiveAtStart || createdThisTurn;

  const emitStatus = (goal) => emit('goal_status_changed', {
    sessionId, goal: publicGoal(goal), statusReason: goal.statusReason, lastVerification: goal.lastVerification,
  });
  const emitUsage = (goal) => emit('goal_usage_updated', { sessionId, goal: publicGoal(goal) });

  const tools = [
    {
      ...CREATE_GOAL_DEF,
      run: (args) => {
        if (!allowed('create_goal')) return '当前模式不提供 create_goal 工具。';
        const objective = String(args?.objective || '').trim();
        if (!objective) return 'create_goal 需要非空的 objective（要追求的具体目标）。';
        try {
          const goal = goalStore.create(sessionId, {
            objective,
            tokenBudget: Number.isInteger(args?.token_budget) && args.token_budget > 0 ? args.token_budget : null,
          });
          createdThisTurn = true;
          goalActiveAtStart = true;
          emit('goal_created', { sessionId, goal: publicGoal(goal) });
          const cap = goal.tokenBudget != null ? `，token 预算 ${goal.tokenBudget}` : '，无预算上限';
          return `目标已创建并开始追踪（goalId ${goal.goalId}，状态 active${cap}）。达成后用 update_goal 提案 complete，确实受阻时提案 blocked；进行中可用 get_goal 查看最新状态与用量。`;
        } catch (e) {
          if (e instanceof GoalConflictError) return `创建失败：${e.message}`;
          throw e;
        }
      },
    },
    {
      ...UPDATE_GOAL_DEF,
      run: (args) => {
        if (!allowed('update_goal')) return '当前模式不提供 update_goal 工具。';
        const mode = resolveUpdateGoalMode(args || {});
        if (mode === 'mixed') {
          return 'update_goal 一次只能做一个操作：请只传 status（终态提案），或只传 token_budget + expected_goal_id + expected_updated_at（预算变更），不要混合。';
        }
        if (mode === 'none') {
          return 'update_goal 需要 mode（status / token_budget），或至少传 status、token_budget 之一。暂停 / 恢复 / 停止由用户操作，本工具不做。';
        }
        const cur = goalStore.get(sessionId);
        if (!cur) return '当前会话没有目标：请先用 create_goal 创建。';
        if (mode === 'token_budget') {
          if (String(args.expected_goal_id || '') !== cur.goalId) {
            return 'expected_goal_id 与当前目标不符：请先调用 get_goal 获取最新快照，再原样带回 its goalId 与 updatedAt。';
          }
          if (!Number.isInteger(args.expected_updated_at)) {
            return '预算变更必须带 get_goal 返回的 expected_updated_at（决策纪元）：请先调用 get_goal。';
          }
          const tb = args.token_budget === null ? null : args.token_budget;
          try {
            const next = goalStore.update(sessionId, (g) => rearmAfterBudgetRaise(g, tb), { expectedUpdatedAt: args.expected_updated_at });
            emitStatus(next);
            const resumed = cur.status !== 'active' && next.status === 'active';
            return `token 预算已更新为 ${next.tokenBudget == null ? '无上限' : next.tokenBudget}${resumed ? '，目标已恢复进行中' : ''}。本次变更不结束当前回合。`;
          } catch (e) {
            if (e?.code === 'GOAL_STALE') return '目标刚被其他操作修改（纪元不符）：请重新调用 get_goal 获取最新快照后再改预算。';
            throw e;
          }
        }
        const status = args.status === 'complete' ? 'complete' : args.status === 'blocked' ? 'blocked' : null;
        if (!status) return 'status 仅支持 complete（目标已达成且无剩余必做工作）或 blocked（确实受阻）。';
        pendingProposal = { status, summary: String(args.summary || '').slice(0, 2000) };
        return `已记录${status === 'complete' ? '完成' : '受阻'}提案：本 turn 结束后由宿主独立结算，结算前请继续做你有把握的收尾工作，不要重复提案。`;
      },
    },
    {
      ...GET_GOAL_DEF,
      run: () => {
        if (!allowed('get_goal')) return '当前模式不提供 get_goal 工具。';
        const goal = goalStore.get(sessionId);
        if (!goal) return '当前会话没有目标。';
        return JSON.stringify(publicGoal(goal));
      },
    },
  ];

  /** turn 开始：定格目标当时是否 active；清空本轮提案痕迹 */
  const beginTurn = () => {
    const cur = goalStore.get(sessionId);
    goalActiveAtStart = Boolean(cur && cur.status === 'active');
    createdThisTurn = false;
    pendingProposal = null;
  };

  /**
   * 每个模型轮结束后：用量入账 + 熔断推进 + 预算检查（一次原子落盘）。
   * @returns undefined 不干预 / 'finish' 收尾本 turn / 'wrapup' 追加预算收尾轮
   */
  const afterRound = ({ replyText = '', toolCalls = [], usage = null, roundMs = 0 } = {}) => {
    const cur = goalStore.get(sessionId);
    if (!cur || !inPlay()) return undefined;
    const tokens = (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
    const turnSeconds = Math.max(0, Math.round(roundMs / 1000));
    if (cur.status !== 'active') {
      // 目标在本 turn 内被停下（用户操作）或已终态：用量照记，熔断与预算不再推进，turn 收尾
      const n = goalStore.update(sessionId, (g) => applyUsage(g, { tokens, turnSeconds }));
      emitUsage(n);
      return 'finish';
    }
    const toolCommitted = toolCalls.some((c) => !BOOKKEEPING_TOOLS.has(c.name));
    let directive;
    const next = goalStore.update(sessionId, (g) => {
      let n = applyUsage(g, { tokens, turnSeconds });
      const br = advanceBreakers(n, { replyText, toolCommitted, limit: cfg.repeatedReplyLimit });
      n = br.goal;
      if (pendingProposal) {
        directive = 'finish'; // 提案已成立：本 turn 收尾，finish() 统一结算
      } else {
        const breach = budgetBreach(n, limits);
        if (breach) {
          n = { ...n, status: 'budget_limited', statusReason: breach.reason };
          directive = 'wrapup';
        } else if (br.tripped) {
          n = { ...n, status: 'paused', statusReason: 'paused(no_progress)' };
          directive = 'finish';
        }
      }
      return n;
    });
    if (directive) emitStatus(next);
    emitUsage(next);
    return directive;
  };

  /** turn 收尾：结算待定的终态提案（P1 直接结算；验证档位随后续迭代接入） */
  const finish = async () => {
    const cur = goalStore.get(sessionId);
    if (!cur) return;
    if (pendingProposal && cur.status === 'active') {
      try {
        if (pendingProposal.status === 'blocked') {
          const next = goalStore.update(sessionId, (g) => ({
            ...g, status: 'blocked', statusReason: 'blocked(worker_reported)',
            lastWorkerProposal: { status: 'blocked', summary: pendingProposal.summary, at: Date.now() },
          }));
          emitStatus(next);
        } else {
          const next = goalStore.update(sessionId, (g) => ({
            ...g, status: 'complete', statusReason: 'complete(worker_proposal)',
            lastWorkerProposal: { status: 'complete', summary: pendingProposal.summary, at: Date.now() },
          }));
          emitStatus(next);
        }
      } catch (e) { log('warn', 'goal 提案结算失败', { sessionId, error: String(e) }); }
    }
    pendingProposal = null;
    const after = goalStore.get(sessionId);
    if (after) emitUsage(after);
  };

  /** 读最新目标（/goal 命令与 footer 芯片用） */
  const current = () => goalStore.get(sessionId);

  return { tools, beginTurn, afterRound, finish, current };
}
