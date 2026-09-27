/**
 * Goal 运行时编排：loop.mjs 的唯一 goal 交互面。
 * 工具执行、用量入账、熔断推进、预算检查、终态提案结算（含独立验证）、
 * 自动续跑决策、执行等待全部收敛在本文件；loop.mjs 只保留钩子调用。
 * 无目标会话的钩子是一次廉价读文件后原样返回，不改变正常 turn 的任何行为。
 *
 * 与 loop 的协作约定：
 *   - beginTurn()  turn 开始时定格目标是否 active（决定本 turn 是否受 goal 管辖）；
 *   - afterRound() 有工具调用的模型轮结束后调用，返回 undefined / 'finish' / 'wrapup / 'updated'；
 *     'updated' = 用户在 turn 内改写了目标文本，经 consumeNote() 取走【目标已更新】提醒注入下一轮；
 *   - onIdle()    无工具调用的模型轮结束后调用（含入账），返回 finish / wrapup / continue；
 *   - wait(reason) 权限 / 计划 / 验证等待期间设置 executionWait（供两端渲染「等待中」）；
 *   - finish()     turn 正常结束或上游失败时调用，结算待定的终态提案。
 */
import { GoalConflictError } from './store.mjs';
import { CREATE_GOAL_DEF, UPDATE_GOAL_DEF, GET_GOAL_DEF, resolveUpdateGoalMode } from './tools.mjs';
import { applyUsage, budgetBreach, rearmAfterBudgetRaise } from './budget.mjs';
import { advanceBreakers } from './breaker.mjs';
import { goalLimits, parseGoalConfig } from './config.mjs';
import { GOAL_WRAPUP_NOTE, goalContinuationNote, goalObjectiveUpdatedNote, goalVerifierFeedbackNote } from './continuation.mjs';
import { verifyGoalProposal, sameMissingSet } from './verification.mjs';

export { GOAL_WRAPUP_NOTE };

/** goal 簿记工具：本身不算「干了活」（熔断的 noToolStreak 不因它们重置） */
const BOOKKEEPING_TOOLS = new Set(['get_goal', 'update_goal']);

/** 事件与 UI 用的公开投影（存储形状已归一化，直接浅拷贝） */
export function publicGoal(goal) {
  return goal ? { ...goal } : null;
}

/**
 * @param goalStore  GoalStore 实例（一会话一个目标文件）
 * @param sessionId  当前会话
 * @param config     parseGoalConfig 的产物
 * @param harnessTools 当前 harness 收录的工具名（goal 三项仅 standard/ultimate 收录）
 * @param emit       AgentEvent 出口
 * @param store      会话存储（transcript 证据用）
 * @param provider   提供方（evaluator 同路由验证用）
 * @param signal     turn 级 AbortSignal（验证请求可被中止）
 * @param onExtraUsage (usage, ms, purpose) 验证等附加请求的账本记账回调
 */
export function createGoalRuntime({
  goalStore, sessionId, config, harnessTools = [], emit, log = () => {},
  store = null, provider = null, signal = null, onExtraUsage = null,
}) {
  const cfg = config || parseGoalConfig(null);
  const limits = goalLimits(cfg);
  let spawn = null;               // 子代理派发器（loop 创建后经 bindSpawn 注入）
  let pendingProposal = null;     // 本 turn 的终态提案 { status, summary }
  let createdThisTurn = false;    // 本 turn 内经 create_goal 武装
  let goalActiveAtStart = false;  // turn 开始时目标是否 active
  let seenObjective = null;      // turn 开始（或 create_goal）时定格的目标文本：用户中途改写即失配
  let updatedNote = null;        // afterRound 检出改写时暂存的【目标已更新】提醒（loop 经 consumeNote 取走）

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
          seenObjective = goal.objective;
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
            return 'expected_goal_id 与当前目标不符：请先调用 get_goal 获取最新快照，再原样带回它的 goalId 与 updatedAt。';
          }
          if (!Number.isInteger(args.expected_updated_at)) {
            return '预算变更必须带 get_goal 返回的 expected_updated_at（决策纪元）：请先调用 get_goal。';
          }
          const tb = args.token_budget === null ? null : args.token_budget;
          try {
            const next = goalStore.update(sessionId, (g) => ({ ...g, ...rearmAfterBudgetRaise(g, tb) }), { expectedUpdatedAt: args.expected_updated_at });
            emitStatus(next);
            const resumed = cur.status !== 'active' && next.status === 'active';
            return `token 预算已更新为 ${next.tokenBudget == null ? '无上限' : next.tokenBudget}${resumed ? '，目标已恢复进行中' : ''}。本次更新不结束当前轮。`;
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
    seenObjective = goalActiveAtStart ? cur.objective : null;
  };

  /**
   * 一轮的用量入账 + 熔断推进 + 预算检查（一次原子落盘）。
   * @returns null（本 turn 不受 goal 管辖）或 { goal, directive }
   */
  const account = ({ replyText = '', toolCalls = [], usage = null, roundMs = 0 }) => {
    const cur = goalStore.get(sessionId);
    if (!cur || !inPlay()) return null;
    const tokens = (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
    const turnSeconds = Math.max(0, Math.round(roundMs / 1000));
    if (cur.status !== 'active') {
      // 目标在本 turn 内被停下（用户操作）或已终态：用量照记，熔断与预算不再推进
      return { goal: goalStore.update(sessionId, (g) => applyUsage(g, { tokens, turnSeconds })), directive: 'finish' };
    }
    // 提案轮也算「接了 goal 协议」：noToolStreak 不因提案累加，验证连胜才是提案打转的后备闸
    const toolCommitted = toolCalls.some((c) => !BOOKKEEPING_TOOLS.has(c.name)) || Boolean(pendingProposal);
    let directive;
    const next = goalStore.update(sessionId, (g) => {
      let n = applyUsage(g, { tokens, turnSeconds });
      const br = advanceBreakers(n, { replyText, toolCommitted, limit: cfg.repeatedReplyLimit });
      n = br.goal;
      if (pendingProposal) {
        directive = 'proposal'; // 提案已成立：结束轮次循环，转 settleProposal 结算（可能带反馈续跑）
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
    return { goal: next, directive };
  };

  /** 有工具调用的模型轮结束后：入账 + 熔断 + 预算，返回 undefined / 'finish' / 'wrapup' */
  const afterRound = (args) => {
    const r = account(args);
    if (!r) return undefined;
    if (r.directive) emitStatus(r.goal);
    emitUsage(r.goal);
    if (!r.directive && r.goal.objective !== seenObjective) {
      // 用户在 turn 进行中改写了目标文本（REST edit / 网页 Composer）：在飞模型下一轮
      // 必须看到新目标（对齐 MiniMax objective-updated 与 binding-stale 的失配取消语义）
      seenObjective = r.goal.objective;
      updatedNote = goalObjectiveUpdatedNote(r.goal);
      emitStatus(r.goal); // 状态未变但目标文本变了：让两端刷新展示
      return 'updated';
    }
    return r.directive;
  };

  /** 取走并清空【目标已更新】提醒（afterRound 返回 'updated' 后由 loop 注入下一轮） */
  const consumeNote = () => { const note = updatedNote; updatedNote = null; return note; };

  /** 结算一次终态提案；allowContinue 决定验证未过（未到阈值）时是否带反馈续跑 */
  const settleProposal = async (goal, proposal, { allowContinue = false } = {}) => {
    pendingProposal = null; // 提案一旦进入结算即消费，避免重复结算
    const proposalRec = { status: proposal.status, summary: proposal.summary, at: Date.now() };
    if (proposal.status === 'blocked') {
      const next = goalStore.update(sessionId, (g) => ({
        ...g, status: 'blocked', statusReason: 'blocked(worker_reported)', lastWorkerProposal: proposalRec,
      }));
      emitStatus(next);
      return { action: 'finish' };
    }
    if (cfg.verification === 'none') {
      const next = goalStore.update(sessionId, (g) => ({
        ...g, status: 'complete', statusReason: 'complete(worker_proposal)', lastWorkerProposal: proposalRec,
      }));
      emitStatus(next);
      return { action: 'finish' };
    }
    // 验证档：先标「验证中」等待，裁决后无论成败都清等待
    wait('verification');
    const verifyT0 = Date.now();
    let result;
    try {
      result = await verifyGoalProposal({ store, sessionId, goal, proposal, config: cfg, provider, spawn, signal });
    } finally {
      wait(null);
    }
    if (result?.usage) {
      goalStore.update(sessionId, (g) => applyUsage(g, { tokens: (result.usage.prompt_tokens || 0) + (result.usage.completion_tokens || 0), isGoalTurn: false }));
      onExtraUsage?.(result.usage, Date.now() - verifyT0, 'goal-verify');
    }
    if (result && result.aborted) {
      // 验证随 turn 中止：不结算、不改目标状态（对齐 MiniMax paused(verifier_aborted) 的
      // 「宿主生命周期、非缺陷」语义——本地实现选择干脆不动，用户下一轮自然继续）
      return { action: 'finish' };
    }
    if (!result || result.available === false) {
      const reason = result?.code === 'timeout' ? 'paused(verifier_timeout)' : 'paused(verifier_unavailable)';
      const next = goalStore.update(sessionId, (g) => ({
        ...g, status: 'paused', statusReason: reason,
        lastVerification: { verdict: 'unavailable', at: Date.now(), evidence: String(result?.error || '验证器不可用').slice(0, 500) },
      }));
      emitStatus(next);
      return { action: 'finish' };
    }
    if (result.verdict === 'inconclusive') {
      // 对齐 MiniMax threadGoalInconclusiveTransition：无结论即暂停并按 code 归因
      // （schema_error → 协议层；其余 → 验证器不可用）；不并入 not_met 连击、不清帐放行
      const reason = result.code === 'schema_error' ? 'paused(verifier_protocol)' : 'paused(verifier_unavailable)';
      const next = goalStore.update(sessionId, (g) => ({
        ...g, status: 'paused', statusReason: reason, lastWorkerProposal: proposalRec,
        lastVerification: { verdict: 'inconclusive', at: Date.now(), evidence: result.evidence, missing: [], notMetStreak: 0 },
      }));
      emitStatus(next);
      return { action: 'finish' };
    }
    if (result.verdict === 'met') {
      const next = goalStore.update(sessionId, (g) => ({
        ...g, status: 'complete', statusReason: 'complete(verifier_met)', lastWorkerProposal: proposalRec,
        lastVerification: { verdict: 'met', at: Date.now(), evidence: result.evidence, notMetStreak: 0 },
      }));
      emitStatus(next);
      return { action: 'finish' };
    }
    if (result.verdict === 'impossible') {
      const next = goalStore.update(sessionId, (g) => ({
        ...g, status: 'blocked', statusReason: 'blocked(verifier_impossible)', lastWorkerProposal: proposalRec,
        lastVerification: { verdict: 'impossible', at: Date.now(), evidence: result.evidence },
      }));
      emitStatus(next);
      return { action: 'finish' };
    }
    // not_met：仅当缺口集合与上一轮完全相同时累加 streak（指纹语义，对齐 MiniMax
    // normalizeVerificationResult），否则重新计数；达到 repeatedNotMetLimit 时覆盖式转
    // paused(no_progress)（对齐 recordThreadGoalVerification 的 repeatedGap 决策）
    const prev = goal.lastVerification;
    const streak = prev && prev.verdict === 'not_met' && sameMissingSet(prev.missing, result.missing)
      ? Number(prev.notMetStreak || 0) + 1
      : 1;
    if (streak >= cfg.repeatedNotMetLimit) {
      const next = goalStore.update(sessionId, (g) => ({
        ...g, status: 'paused', statusReason: 'paused(no_progress)', lastWorkerProposal: proposalRec,
        lastVerification: { verdict: 'not_met', at: Date.now(), evidence: result.evidence, missing: result.missing || [], notMetStreak: streak },
      }));
      emitStatus(next);
      return { action: 'finish' };
    }
    const next = goalStore.update(sessionId, (g) => ({
      ...g, lastVerification: { verdict: result.verdict, at: Date.now(), evidence: result.evidence, missing: result.missing || [], notMetStreak: streak },
    }));
    emitStatus(next); // 状态未变但验证结论刷新（lastVerification 随事件透出）
    if (allowContinue) {
      // 续跑提醒（含目标重述）+ 验证反馈：对齐 MiniMax continuationBody = hint(+objective) + feedback
      return { action: 'continue', extraSystem: `${goalContinuationNote(goal)}\n\n${goalVerifierFeedbackNote(result, streak, cfg.repeatedNotMetLimit)}` };
    }
    return { action: 'finish' };
  };

  /**
   * 无工具调用的模型轮结束后：入账 + 提案结算 / 续跑决策。
   * @returns { action: 'finish' | 'wrapup' | 'continue', extraSystem? }
   */
  const onIdle = async (args) => {
    const r = account({ ...args, toolCalls: [] });
    if (!r) return { action: 'finish' };
    if (r.directive) emitStatus(r.goal);
    emitUsage(r.goal);
    if (r.directive === 'wrapup') return { action: 'wrapup' };
    if (r.directive === 'finish') return { action: 'finish' };
    return decideNext(r.goal);
  };

  /** 目标仍 active 时的下一步：有待定提案走结算（可带验证反馈续跑），否则注入续跑提醒 */
  const decideNext = async (goal) => {
    if (goal.objective !== seenObjective) {
      // 空转轮前用户改写了目标：同样以【目标已更新】续轮；针对旧目标的待定提案作废
      // （对齐 MiniMax 绑定失配即取消——旧提案回答了没人再问的问题）
      seenObjective = goal.objective;
      pendingProposal = null;
      return { action: 'continue', extraSystem: goalObjectiveUpdatedNote(goal) };
    }
    if (!pendingProposal) return { action: 'continue', extraSystem: goalContinuationNote(goal) };
    const d = await settleProposal(goal, pendingProposal, { allowContinue: true });
    const after = goalStore.get(sessionId);
    if (after) emitUsage(after);
    return d;
  };

  /** 提案轮（update_goal 单独成轮或与其他工具同轮）结束后的结算入口 */
  const onProposal = async () => {
    const cur = goalStore.get(sessionId);
    if (!cur || !pendingProposal) return { action: 'finish' };
    return decideNext(cur);
  };

  /** 设置 / 清除执行等待（permission / plan / verification）；仅 active 目标有意义 */
  const wait = (reason) => {
    const cur = goalStore.get(sessionId);
    if (!cur || cur.status !== 'active') return;
    if ((cur.executionWait?.reason || null) === (reason || null)) return;
    const next = goalStore.update(sessionId, (g) => ({ ...g, executionWait: reason ? { reason, sinceMs: Date.now() } : null }));
    emit('goal_wait_changed', { sessionId, goal: publicGoal(next), reason: reason || null });
  };

  /** turn 收尾：结算待定的终态提案（不允许续跑）并发出最终用量快照 */
  const finish = async () => {
    const cur = goalStore.get(sessionId);
    if (!cur) return;
    if (pendingProposal && cur.status === 'active') {
      try {
        await settleProposal(cur, pendingProposal, { allowContinue: false });
      } catch (e) { log('warn', 'goal 提案结算失败', { sessionId, error: String(e) }); }
    }
    pendingProposal = null;
    const after = goalStore.get(sessionId);
    if (after) emitUsage(after);
  };

  /** 读最新目标（/goal 命令与 footer 芯片用） */
  const current = () => goalStore.get(sessionId);

  return { tools, beginTurn, afterRound, onIdle, onProposal, finish, wait, current, consumeNote, bindSpawn: (s) => { spawn = s; } };
}
