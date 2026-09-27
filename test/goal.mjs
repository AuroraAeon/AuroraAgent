/**
 * Goal 模式单测（util/agent/goal/*）：六态状态机与迁移、归一化容错、
 * update_goal 模式解析（显式 mode / 混合拒绝 / null 填充豁免）、配置单叶容错与钳制、
 * 预算触顶与宽限、熔断双计数器、GoalStore 冲突与 CAS 纪元、运行时工具与钩子。
 */
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  THREAD_GOAL_STATUSES, THREAD_GOAL_STATUS_REASONS, TERMINAL_STATUSES, isTerminalStatus,
  createGoalState, normalizeGoalState, canTransition, GOAL_STATUS_LABELS,
} from '../util/agent/goal/types.mjs';
import { GoalStore, GoalConflictError } from '../util/agent/goal/store.mjs';
import { applyUserGoalAction, setUserGoalObjective, clearUserGoal, GOAL_BAD_INPUT_CODES } from '../util/agent/goal/actions.mjs';
import { parseGoalCommand, parseGoalBudgetValue, goalActionHint, formatGoalSummary, formatGoalReceipt, GOAL_COMMAND_HELP } from '../util/agent/goal/command.mjs';
import { resolveUpdateGoalMode, hasUpdateGoalTokenBudgetIntent } from '../util/agent/goal/tools.mjs';
import { parseGoalConfig, GOAL_CONFIG_DEFAULTS, goalLimits } from '../util/agent/goal/config.mjs';
import { applyUsage, budgetBreach, rearmAfterBudgetRaise, goalUsageChip, formatGoalCount, formatGoalDuration } from '../util/agent/goal/budget.mjs';
import { replyFingerprint, advanceBreakers } from '../util/agent/goal/breaker.mjs';
import { createGoalRuntime } from '../util/agent/goal/runtime.mjs';
import { parseVerdict } from '../util/agent/goal/verification.mjs';
import { GOAL_AUDIT_INTERVAL, GOAL_CONTINUATION_NOTE, GOAL_WRAPUP_NOTE, goalContinuationNote, goalObjectiveUpdatedNote, goalTurnStartNote, goalVerifierFeedbackNote } from '../util/agent/goal/continuation.mjs';

export async function runGoalTests(test, assert, eq) {
  console.log('\nGoal 模式单测');

  await test('goal: 六状态机与 TERMINAL_STATUSES', () => {
    eq(THREAD_GOAL_STATUSES.length, 6);
    eq(TERMINAL_STATUSES.join(','), 'complete,blocked,budget_limited,usage_limited');
    eq(isTerminalStatus('active'), false);
    eq(isTerminalStatus('budget_limited'), true);
    assert(THREAD_GOAL_STATUS_REASONS.includes('budget_limited(token)'), '应含 token 触顶原因');
    assert(THREAD_GOAL_STATUS_REASONS.includes('paused(no_progress)'), '应含熔断原因');
    assert(GOAL_STATUS_LABELS.complete === '已完成', '应有中文状态标签');
  });

  await test('goal: 用户面迁移规则——complete 是终态中的终态，预算耗尽不能自行恢复', () => {
    eq(canTransition('active', 'paused'), true);
    eq(canTransition('paused', 'active'), true);
    eq(canTransition('blocked', 'active'), true);
    eq(canTransition('usage_limited', 'active'), true);
    eq(canTransition('budget_limited', 'active'), false, '预算耗尽恢复 active 一律拒绝（靠抬高预算重新武装）');
    eq(canTransition('complete', 'active'), false);
    eq(canTransition('complete', 'paused'), false, 'complete 不接受任何迁移');
    eq(canTransition('active', 'complete'), true);
    eq(canTransition('active', 'usage_limited'), true);
    eq(canTransition('paused', 'paused'), true, '同态允许（幂等设置）');
  });

  await test('goal: createGoalState 校验 tokenBudget 并初始化计数器', () => {
    const g = createGoalState({ sessionId: 's1', objective: '目标甲', now: 1000 });
    eq(g.status, 'active');
    eq(g.tokensUsed, 0);
    eq(g.tokenBudget, null);
    assert(g.goalId.startsWith('tg_'), 'goalId 应带 tg_ 前缀');
    eq(createGoalState({ sessionId: 's', objective: 'x', tokenBudget: 0 }).tokenBudget, null, '0 预算按无上限处理');
    eq(createGoalState({ sessionId: 's', objective: 'x', tokenBudget: 100 }).tokenBudget, 100);
    eq(createGoalState({ sessionId: 's', objective: 'x', objective: 'y' }).objective.length >= 0, true);
  });

  await test('goal: normalizeGoalState 坏字段回退，executionWait 仅 active 保留', () => {
    const n = normalizeGoalState({
      goalId: 'tg_x', sessionId: 's', status: '不存在的状态', tokensUsed: -5, tokenBudget: 'abc',
      statusReason: 'paused(no_progress)', executionWait: { reason: 'permission', sinceMs: 1 },
    });
    eq(n.status, 'active', '坏状态回退 active');
    eq(n.tokensUsed, 0, '负用量归零');
    eq(n.tokenBudget, null, '坏预算按无上限处理');
    eq(n.executionWait.reason, 'permission', 'active 目标保留等待原因');
    const paused = normalizeGoalState({ status: 'paused', executionWait: { reason: 'plan', sinceMs: 1 } });
    eq(paused.executionWait, null, '非 active 目标的陈旧等待必须清除');
    const badWait = normalizeGoalState({ status: 'active', executionWait: { reason: '胡扯' } });
    eq(badWait.executionWait, null, '等待原因必须在 closed-set 内');
  });

  await test('goal: resolveUpdateGoalMode——显式 mode 优先、混合拒绝、null 填充豁免', () => {
    eq(resolveUpdateGoalMode({ mode: 'status', status: 'complete' }), 'status');
    eq(resolveUpdateGoalMode({ mode: 'token_budget', token_budget: 100 }), 'token_budget');
    eq(resolveUpdateGoalMode({ status: 'complete', token_budget: 100 }), 'mixed', '数字预算与 status 同现是真实混合模式');
    eq(resolveUpdateGoalMode({ status: 'complete', token_budget: null }), 'status', '省略字段被物化成 null 不能把提案变成预算变更');
    eq(resolveUpdateGoalMode({ token_budget: 100 }), 'token_budget');
    eq(resolveUpdateGoalMode({ token_budget: null }), 'token_budget', '孤立 null（无 status 在场）是明确的清预算意图——对齐 MiniMax，缺纪元快照时由运行时返回纠正性错误');
    eq(resolveUpdateGoalMode({}), 'none');
    eq(resolveUpdateGoalMode({ mode: 'status', token_budget: 100 }), 'status', '显式 mode 优先，另一模式字段被忽略');
    eq(hasUpdateGoalTokenBudgetIntent({ token_budget: null }), true, '孤立 null 即清预算意图（对齐 MiniMax）');
    eq(hasUpdateGoalTokenBudgetIntent({ token_budget: 50 }), true);
    eq(hasUpdateGoalTokenBudgetIntent({ status: 'complete', token_budget: null }), false, '提案在场的 null 只是兼容填充，不构成预算意图');
    eq(hasUpdateGoalTokenBudgetIntent({ status: 'complete', token_budget: 50 }), true, '数字预算与 status 同现是真实混合模式');
    eq(hasUpdateGoalTokenBudgetIntent({}), false);
  });

  await test('goal: parseGoalConfig 默认值、evaluatorModel 推导与降级', () => {
    const d = parseGoalConfig(undefined);
    eq(d.verification, 'none');
    eq(d.evidence, 'brief');
    eq(d.graceSteps, GOAL_CONFIG_DEFAULTS.graceSteps);
    eq(d.repeatedReplyLimit, 3);
    eq(d.repeatedNotMetLimit, 5);
    eq(d.evaluator.maxTokens, 4096);
    eq(d.evaluator.timeoutSeconds, 60);
    eq(d.evaluator.maxRetries, 1);
    const ev = parseGoalConfig({ evaluatorModel: 'LongCat-2.0' });
    eq(ev.verification, 'evaluator', '显式配置 evaluatorModel 才走 evaluator');
    eq(parseGoalConfig({ verification: 'subagent' }).verification, 'subagent');
    const warn = [];
    const down = parseGoalConfig({ verification: 'evaluator' }, { warn: (m, e) => warn.push([m, e]) });
    eq(down.verification, 'none', 'evaluator 缺模型名降级 none');
    eq(warn.length, 1, '降级应告警');
  });

  await test('goal: parseGoalConfig 单叶损坏独立回退并钳制', () => {
    const warn = [];
    const c = parseGoalConfig({
      verification: '胡扯', evidence: '胡扯', graceSteps: 99, mainTurns: -3, activeSeconds: 1.5,
      repeatedReplyLimit: 0, repeatedNotMetLimit: 999, evaluator: { maxTokens: 1, timeoutSeconds: 9999, maxRetries: 9 },
    }, { warn: (m, e) => warn.push(e.leaf) });
    eq(c.verification, 'none', '坏 verification 回退缺省');
    eq(c.evidence, 'brief', '坏 evidence 回退缺省');
    eq(c.graceSteps, 3, 'graceSteps 钳到上限 3');
    eq(c.mainTurns, 0, '负主轮回退 0（不限制）');
    eq(c.activeSeconds, 0, '非整秒回退 0');
    eq(c.repeatedReplyLimit, 2, '低于下限钳到 2（对齐 MiniMax：首次观察只记录，不会一上来就熔断）');
    eq(c.repeatedNotMetLimit, 10, '高于上限钳到 10');
    eq(c.evaluator.maxTokens, 256, 'evaluator maxTokens 钳到下限');
    eq(c.evaluator.timeoutSeconds, 300, 'timeoutSeconds 钳到上限');
    eq(c.evaluator.maxRetries, 1, 'maxRetries 封顶 1');
    eq(warn.length >= 8, true, '每个坏叶都应独立告警');
    const limits = goalLimits(c);
    eq(limits.graceSteps, 3);
    eq(limits.mainTurns, 0);
  });

  await test('goal: applyUsage 累加且单调非负', () => {
    const g = createGoalState({ sessionId: 's', objective: 'x' });
    const n = applyUsage(g, { tokens: 35, turnSeconds: 2 });
    eq(n.tokensUsed, 35);
    eq(n.turnsUsed, 1);
    eq(n.timeUsedSeconds, 2);
    const n2 = applyUsage(n, { tokens: -10, turnSeconds: -1 });
    eq(n2.tokensUsed, 35, '负增量不计');
    eq(n2.timeUsedSeconds, 2);
  });

  await test('goal: budgetBreach 三触顶维度与 graceSteps 宽限', () => {
    const base = createGoalState({ sessionId: 's', objective: 'x', tokenBudget: 100 });
    eq(budgetBreach(base, { graceSteps: 1 }), null);
    const hit = budgetBreach(applyUsage(base, { tokens: 100 }), { graceSteps: 1 });
    eq(hit.reason, 'budget_limited(token)');
    eq(budgetBreach({ ...base, status: 'paused', tokensUsed: 999 }, {}), null, '非 active 不检查预算');
    const turnBase = { ...base, tokenBudget: null };
    eq(budgetBreach(applyUsage(turnBase, { tokens: 5 }), { graceSteps: 1, mainTurns: 1 }), null, '第 1 轮在宽限内');
    const two = applyUsage(applyUsage(turnBase, { tokens: 5 }), { tokens: 5 });
    eq(budgetBreach(two, { graceSteps: 1, mainTurns: 1 }), null, '第 2 轮仍在宽限内');
    const three = applyUsage(two, { tokens: 5 });
    eq(budgetBreach(three, { graceSteps: 1, mainTurns: 1 }).reason, 'budget_limited(main_turn)', '超过上限+宽限才判负');
    const slow = applyUsage(turnBase, { tokens: 5, turnSeconds: 100 });
    eq(budgetBreach(slow, { graceSteps: 0, activeSeconds: 10 }).reason, 'budget_limited(active_time)');
    const mid = applyUsage(turnBase, { tokens: 5, turnSeconds: 12 });
    eq(budgetBreach(mid, { graceSteps: 5, activeSeconds: 10 }), null, '宽限额度内不拦');
  });

  await test('goal: rearmAfterBudgetRaise 仅抬高到已用之上或清零才重新武装', () => {
    const limited = { ...createGoalState({ sessionId: 's', objective: 'x', tokenBudget: 100 }), status: 'budget_limited', statusReason: 'budget_limited(token)', tokensUsed: 150 };
    const raised = rearmAfterBudgetRaise(limited, 200);
    eq(raised.status, 'active', '抬高的预算重新武装');
    eq(raised.tokenBudget, 200);
    eq(raised.statusReason, null);
    const cleared = rearmAfterBudgetRaise(limited, null);
    eq(cleared.status, 'active');
    eq(cleared.tokenBudget, null, '清零同样重新武装');
    const tooLow = { ...limited, ...rearmAfterBudgetRaise(limited, 100) };
    eq(tooLow.status, 'budget_limited', '压低到已用额度之下不重新武装');
    eq(tooLow.tokenBudget, 100, '预算值仍被记录（只是不解除触顶）');
    const turnOut = { ...limited, statusReason: 'budget_limited(main_turn)' };
    eq({ ...turnOut, ...rearmAfterBudgetRaise(turnOut, 999) }.status, 'budget_limited', '主轮耗尽不能靠改 token 预算恢复');
    const active = createGoalState({ sessionId: 's', objective: 'x' });
    eq(rearmAfterBudgetRaise(active, 50).tokenBudget, 50, 'active 目标正常改预算');
    // 增量返回：不夹带旧 goal 字段，与目标文本等其他变更复合时不会覆盖
    eq(raised.objective, undefined, '增量不应夹带旧 objective');
    eq(Object.keys(raised).sort().join(','), 'status,statusReason,tokenBudget', '重新武装增量仅三字段');
  });

  await test('goal: goalUsageChip 形态（K/M 缩写 · min 时分秒，对齐 MiniMax）', () => {
    const g = { ...createGoalState({ sessionId: 's', objective: 'x', tokenBudget: 20000 }), tokensUsed: 12500, timeUsedSeconds: 125 };
    eq(goalUsageChip(g), '13K / 20K · 2min5s', '>=10 的 K 值取整、时长记 min+秒');
    const noCap = { ...g, tokenBudget: null, tokensUsed: 800, timeUsedSeconds: 45 };
    eq(goalUsageChip(noCap), '800 · 45s', '无预算时只显示已用与时长');
    // 时长：<60s 记 s、整分不省略 0s、>=1h 记 h+min+s（对齐 MiniMax formatTuiDuration）
    eq(formatGoalDuration(8), '8s');
    eq(formatGoalDuration(62), '1min2s');
    eq(formatGoalDuration(120), '2min0s', '整分也保留秒位');
    eq(formatGoalDuration(7320), '2h2min0s');
    eq(formatGoalDuration(7770), '2h9min30s');
    // 计数：<10 非整数保留一位小数，>=10 取整，>=1M 记 M（对齐 MiniMax formatGoalCount）
    eq(formatGoalCount(1200), '1.2K');
    eq(formatGoalCount(12500), '13K');
    eq(formatGoalCount(20000), '20K');
    eq(formatGoalCount(999), '999');
    eq(formatGoalCount(2500000), '2.5M');
  });

  await test('goal: replyFingerprint 仅行尾与首尾空白算展示差异（对齐 MiniMax fingerprintThreadGoalReply）', () => {
    assert(replyFingerprint('你好  世界') !== replyFingerprint('你好 世界'), '内部空白是语义的一部分：改一个空格算新回复');
    eq(replyFingerprint('a\r\nb'), replyFingerprint('a\nb'), '行尾形态是展示差异');
    eq(replyFingerprint('  a  '), replyFingerprint('a'), '首尾空白是展示差异');
    assert(replyFingerprint('a') !== replyFingerprint('b'));
    eq(replyFingerprint('   '), '', '纯空白按空回复处理');
  });

  await test('goal: advanceBreakers 阶梯——首观察记录、二次 nudge、limit 次熔断；空轮不重置（对齐 MiniMax decideAction/scoresReply）', () => {
    const g = createGoalState({ sessionId: 's', objective: 'x' });
    // 回复指纹阶梯：第 1 次只记录、第 2 次注入纠正提醒、第 3 次（limit）熔断
    const first = advanceBreakers(g, { replyText: '同样的话', toolCommitted: true, limit: 3 });
    eq(first.goal.noProgressStreak, 1, '首次观察只记录');
    eq(first.nudge.length, 0, '首次不提醒');
    eq(first.tripped, false);
    const second = advanceBreakers(first.goal, { replyText: '同样的话', toolCommitted: true, limit: 3 });
    eq(second.goal.noProgressStreak, 2);
    eq(second.tripped, false, '第二次不断闸');
    eq(second.nudge.join('+'), 'reply', '第二次注入复读纠正提醒');
    const third = advanceBreakers(second.goal, { replyText: '同样的话', toolCommitted: true, limit: 3 });
    eq(third.tripped, true, '第 3 次相同回复触发');
    eq(third.by, 'reply');
    eq(third.nudge.length, 0, '触顶轮不再提醒');
    // 无工具阶梯（回复各异，只累 noToolStreak）
    const t1 = advanceBreakers(g, { replyText: '第1句', toolCommitted: false, limit: 3 });
    eq(t1.nudge.length, 0);
    const t2 = advanceBreakers(t1.goal, { replyText: '第2句', toolCommitted: false, limit: 3 });
    eq(t2.goal.noToolStreak, 2, '无工具轮累加');
    eq(t2.nudge.join('+'), 'no_tool', '第二次无工具注入纠正提醒');
    const t3 = advanceBreakers(t2.goal, { replyText: '第3句', toolCommitted: false, limit: 3 });
    eq(t3.tripped, true);
    eq(t3.by, 'no_tool');
    // 双计数器同时到第 2 阶：合并注入
    const both = advanceBreakers(advanceBreakers(g, { replyText: '复读', toolCommitted: false, limit: 3 }).goal, { replyText: '复读', toolCommitted: false, limit: 3 });
    eq(both.nudge.join('+'), 'reply+no_tool', '两个计数器同时中招应合并提醒');
    const reset = advanceBreakers(t3.goal, { replyText: '第4句', toolCommitted: false, toolSignalTrustworthy: false });
    eq(reset.goal.noToolStreak, 0, '工具信号不可信时重置，不把不可信的零计成零');
    // 空回复不携带指纹证据：连胜与指纹原样保持（杜绝「交替空轮 + 复读」绕过熔断）
    const mid = advanceBreakers(advanceBreakers(g, { replyText: '同样的话', toolCommitted: true, limit: 3 }).goal, { replyText: '同样的话', toolCommitted: true, limit: 3 });
    const empty = advanceBreakers(mid.goal, { replyText: '  ', toolCommitted: true, limit: 3 });
    eq(empty.goal.noProgressStreak, 2, '空回复不重置连胜');
    eq(empty.goal.replyFingerprint, mid.goal.replyFingerprint, '空回复不清除指纹');
    eq(advanceBreakers(empty.goal, { replyText: '同样的话', toolCommitted: true, limit: 3 }).tripped, true, '空轮之后的复读继续累加');
    // 下限 2：limit=1 按 2 处理（对齐 MiniMax max(2, limit)）
    eq(advanceBreakers(g, { replyText: 'x', toolCommitted: true, limit: 1 }).tripped, false, 'limit=1 被钳到 2：首次观察不熔断');
  });

  await test('goal: 运行时——熔断第 2 阶注入无进展纠正提醒（afterRound nudge / onIdle 续跑+nudge）', async () => {
    const usage = { prompt_tokens: 10, completion_tokens: 5 };
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt-nudge-'));
    const store = new GoalStore(dir);
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rtnudge', config: parseGoalConfig({ repeatedReplyLimit: 3 }),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: () => {},
    });
    rt.tools[0].run({ objective: 'nudge 测试' });
    rt.beginTurn();
    eq(rt.afterRound({ replyText: '复读内容', toolCalls: [{ name: 'read_file' }], usage, roundMs: 50 }), undefined, '首观察只记录');
    eq(rt.afterRound({ replyText: '复读内容', toolCalls: [{ name: 'read_file' }], usage, roundMs: 50 }), 'nudge', '第二次相同回复应转 nudge 而非直接熔断');
    const note = rt.consumeNote();
    assert(note.includes('【无进展提醒】') && note.includes('不要重复'), '纠正提醒应带复读守卫');
    eq(rt.consumeNote(), null, '提醒一次性消费');
    eq(rt.afterRound({ replyText: '复读内容', toolCalls: [{ name: 'read_file' }], usage, roundMs: 50 }), 'finish', '第三次相同回复熔断');
    eq(store.get('rtnudge').statusReason, 'paused(no_progress)');
    // onIdle 路径：续跑提醒 + nudge 合并（对齐 MiniMax renderNudgePrompt = continuationBody + nudgeGuard）
    const dir2 = mkdtempSync(join(tmpdir(), 'goal-rt-nudge2-'));
    const store2 = new GoalStore(dir2);
    const rt2 = createGoalRuntime({
      goalStore: store2, sessionId: 'rtnudge2', config: parseGoalConfig({ repeatedReplyLimit: 3 }),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: () => {},
    });
    rt2.tools[0].run({ objective: 'nudge 测试 2' });
    rt2.beginTurn();
    const d1 = await rt2.onIdle({ replyText: '空转甲', toolCalls: [], usage, roundMs: 50 });
    eq(d1.action, 'continue');
    assert(d1.extraSystem.includes('【目标续跑】') && !d1.extraSystem.includes('【无进展提醒】'), '首轮空转只带续跑提醒');
    const d2 = await rt2.onIdle({ replyText: '空转甲', toolCalls: [], usage, roundMs: 50 });
    eq(d2.action, 'continue', '第二次不断闸');
    assert(d2.extraSystem.includes('【目标续跑】') && d2.extraSystem.includes('【无进展提醒】'), '续跑提醒与纠正提醒合并（对齐 renderNudgePrompt）');
    eq(store2.get('rtnudge2').status, 'active', '第二次空转不熔断');
  });

  await test('goal: GoalStore 一会话一目标、未完成冲突与 complete 后可替换', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-store-'));
    const store = new GoalStore(dir);
    const g1 = store.create('s1', { objective: '甲' });
    assert(g1.goalId, '创建应返回目标');
    let conflict = null;
    try { store.create('s1', { objective: '乙' }); } catch (e) { conflict = e; }
    assert(conflict instanceof GoalConflictError, '未完成目标再创建应抛冲突');
    eq(conflict.code, 'GOAL_STATUS_CONFLICT');
    store.update('s1', (g) => ({ ...g, status: 'complete', statusReason: 'complete(worker_proposal)' }));
    const g2 = store.create('s1', { objective: '乙' });
    assert(g2.goalId !== g1.goalId, 'complete 后允许替换');
    eq(store.get('s1').objective, '乙');
    eq(store.get('不存在'), null, '坏路径按不存在处理');
    eq(store.remove('s1'), true);
    eq(store.get('s1'), null, '删除后读不到');
  });

  await test('goal: GoalStore CAS 纪元——expectedUpdatedAt 不符抛 GOAL_STALE', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-cas-'));
    const store = new GoalStore(dir);
    const g = store.create('s2', { objective: '甲' });
    let stale = null;
    try { store.update('s2', (x) => ({ ...x, tokensUsed: 1 }), { expectedUpdatedAt: g.updatedAt + 999 }); } catch (e) { stale = e; }
    assert(stale instanceof GoalConflictError);
    eq(stale.code, 'GOAL_STALE');
    const ok = store.update('s2', (x) => ({ ...x, tokensUsed: 1 }), { expectedUpdatedAt: g.updatedAt });
    eq(ok.tokensUsed, 1);
    let nf = null;
    try { store.update('s3', (x) => x); } catch (e) { nf = e; }
    eq(nf.code, 'GOAL_NOT_FOUND');
  });

  await test('goal: GoalStore 原子落盘（tmp + rename）且 JSON 可回读', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-atomic-'));
    const store = new GoalStore(dir);
    store.create('s4', { objective: '原子性' });
    const raw = JSON.parse(readFileSync(join(dir, 'goals', 's4.json'), 'utf8'));
    eq(raw.objective, '原子性');
    eq(existsSync(join(dir, 'goals', 's4.json.tmp')), false, '不应残留临时文件');
  });

  await test('goal: applyUserGoalAction——REST 与终端共用的用户面迁移与拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-actions-'));
    const store = new GoalStore(dir);
    store.create('sA', { objective: '用户面操作' });
    const paused = applyUserGoalAction(store, 'sA', 'pause');
    eq(paused.status, 'paused');
    eq(paused.statusReason, 'paused(user_requested)');
    eq(paused.executionWait, null, '暂停应清除陈旧等待');
    const resumed = applyUserGoalAction(store, 'sA', 'resume');
    eq(resumed.status, 'active');
    const stopped = applyUserGoalAction(store, 'sA', 'stop');
    eq(stopped.status, 'complete');
    eq(stopped.statusReason, 'complete(user_requested)');
    for (const act of ['pause', 'resume', 'stop']) {
      let err = null;
      try { applyUserGoalAction(store, 'sA', act); } catch (e) { err = e; }
      assert(err instanceof GoalConflictError, `${act} 对 complete 应抛冲突`);
      eq(err.code, 'GOAL_STATUS_CONFLICT');
    }
    // 无目标：GOAL_NOT_FOUND
    let nf = null;
    try { applyUserGoalAction(store, 'sB', 'pause'); } catch (e) { nf = e; }
    eq(nf.code, 'GOAL_NOT_FOUND');
    // 坏预算入参：GOAL_BAD_BUDGET（上层映射 400）
    let bad = null;
    try { applyUserGoalAction(store, 'sA', 'budget', { tokenBudget: -1 }); } catch (e) { bad = e; }
    eq(bad.code, 'GOAL_BAD_BUDGET');
    assert(GOAL_BAD_INPUT_CODES.includes(bad.code), '坏入参 code 应登记在案');
  });

  await test('goal: applyUserGoalAction budget——纪元 CAS 与重新武装', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-actions-budget-'));
    const store = new GoalStore(dir);
    store.create('sC', { objective: '预算操作', tokenBudget: 10 });
    // 手工模拟触顶：直接改文件比跑真实轮次便宜（状态迁移逻辑由 e2e 覆盖）
    const g = store.get('sC');
    store.update('sC', (x) => ({ ...x, tokensUsed: 50, status: 'budget_limited', statusReason: 'budget_limited(token)' }));
    let stale = null;
    try { applyUserGoalAction(store, 'sC', 'budget', { tokenBudget: 100, expectedUpdatedAt: g.updatedAt }); } catch (e) { stale = e; }
    eq(stale.code, 'GOAL_STALE', '纪元不符应抛 GOAL_STALE');
    const cur = store.get('sC');
    const raised = applyUserGoalAction(store, 'sC', 'budget', { tokenBudget: 100, expectedUpdatedAt: cur.updatedAt });
    eq(raised.status, 'active', '抬高到已用之上应重新武装');
    eq(raised.tokenBudget, 100);
    const cleared = applyUserGoalAction(store, 'sC', 'budget', { tokenBudget: null, expectedUpdatedAt: raised.updatedAt });
    eq(cleared.tokenBudget, null, '清零应移除上限');
    eq(cleared.status, 'active');
    // 未知操作：GOAL_BAD_ACTION
    let unknown = null;
    try { applyUserGoalAction(store, 'sC', 'destroy'); } catch (e) { unknown = e; }
    eq(unknown.code, 'GOAL_BAD_ACTION');
  });

  await test('goal: 运行时工具——创建 / 提案 / 快照与混合模式拒绝', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rt1', config: parseGoalConfig(undefined),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
    });
    const [create, update, get] = rt.tools;
    eq(create.name, 'create_goal');
    eq(update.name, 'update_goal');
    eq(get.name, 'get_goal');
    eq(String(get.run({})), '当前会话没有目标。');
    const created = String(create.run({ objective: '跑通目标模式' }));
    assert(created.includes('目标已创建'), '创建应回执');
    eq(events.at(-1).t, 'goal_created');
    const again = String(create.run({ objective: '第二个' }));
    assert(again.includes('创建失败') && again.includes('未完成的目标'), '冲突应以文本回给模型而非抛异常');
    const ignored = String(update.run({ mode: 'status', status: 'complete', token_budget: 100 }));
    assert(ignored.includes('已记录完成提案'), '显式 mode 优先，另一模式字段被忽略');
    const mixed = String(update.run({ status: 'complete', token_budget: 100 }));
    assert(mixed.includes('一次只能做一个操作'), '无 mode 时双意图同现应判混合模式并拒绝');
    const loneNull = String(update.run({ token_budget: null }));
    assert(loneNull.includes('get_goal'), '孤立 null（无 mode / 无 status）应判清预算意图并要求新鲜快照（对齐 MiniMax tool-defs）');
    const noGoal = String(update.run({ mode: 'status', status: 'complete' }));
    assert(noGoal.includes('提案'), '提案应被记录');
    const snap = JSON.parse(get.run({}));
    eq(snap.status, 'active');
    assert(snap.goalId && Number.isInteger(snap.updatedAt), '快照应带纪元字段供预算变更');
  });

  await test('goal: 运行时预算变更——纪元不符拒绝、抬高后重新武装', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt2-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rt2', config: parseGoalConfig(undefined),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
    });
    const [create, update, get] = rt.tools;
    create.run({ objective: '预算测试', token_budget: 10 });
    const snap = JSON.parse(get.run({}));
    const stale = String(update.run({ mode: 'token_budget', token_budget: 500, expected_goal_id: snap.goalId, expected_updated_at: snap.updatedAt + 999 }));
    assert(stale.includes('纪元不符'), '纪元不符应提示重新取快照');
    const missingEpoch = String(update.run({ mode: 'token_budget', token_budget: 500, expected_goal_id: snap.goalId }));
    assert(missingEpoch.includes('expected_updated_at'), '缺纪元应要求先 get_goal');
    const ok = String(update.run({ mode: 'token_budget', token_budget: 500, expected_goal_id: snap.goalId, expected_updated_at: snap.updatedAt }));
    assert(ok.includes('500'), '合法预算变更应生效');
    eq(store.get('rt2').tokenBudget, 500);
    const events2 = [];
    const rt2 = createGoalRuntime({
      goalStore: store, sessionId: 'rt2', config: parseGoalConfig(undefined),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events2.push({ t, p }),
    });
    // 预算触顶后经「新鲜快照 + 抬高」重新武装
    store.update('rt2', (g) => ({ ...g, status: 'budget_limited', statusReason: 'budget_limited(token)', tokensUsed: 600 }));
    const snap2 = JSON.parse(rt2.tools[2].run({}));
    const rearm = String(rt2.tools[1].run({ mode: 'token_budget', token_budget: 900, expected_goal_id: snap2.goalId, expected_updated_at: snap2.updatedAt }));
    assert(rearm.includes('恢复进行中'), '抬高的预算应把 budget_limited(token) 重新武装');
    eq(store.get('rt2').status, 'active');
  });

  await test('goal: 运行时 afterRound 入账与熔断转 paused(no_progress)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt3-'));
    const store = new GoalStore(dir);
    const events = [];
    const cfg = parseGoalConfig({ repeatedReplyLimit: 2 });
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rt3', config: cfg,
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
    });
    rt.tools[0].run({ objective: '熔断测试' });
    rt.beginTurn();
    const usage = { prompt_tokens: 20, completion_tokens: 15 };
    eq(rt.afterRound({ replyText: '第一句', toolCalls: [{ name: 'read_file' }], usage, roundMs: 2000 }), undefined);
    let g = store.get('rt3');
    eq(g.tokensUsed, 35);
    eq(g.turnsUsed, 1);
    eq(g.timeUsedSeconds, 2);
    eq(rt.afterRound({ replyText: '第一句', toolCalls: [], usage, roundMs: 1000 }), 'finish', '连续相同回复触发熔断');
    g = store.get('rt3');
    eq(g.status, 'paused');
    eq(g.statusReason, 'paused(no_progress)');
    assert(events.some((e) => e.t === 'goal_status_changed' && e.p.goal.status === 'paused'), '应发状态变更事件');
    assert(events.some((e) => e.t === 'goal_usage_updated'), '应发用量事件');
  });

  await test('goal: 运行时 afterRound 预算触顶转 budget_limited(token) 并要求收尾', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt4-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rt4', config: parseGoalConfig(undefined),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
    });
    rt.tools[0].run({ objective: '预算触顶', token_budget: 10 });
    rt.beginTurn();
    eq(rt.afterRound({ replyText: '开工', toolCalls: [{ name: 'read_file' }], usage: { prompt_tokens: 20, completion_tokens: 15 }, roundMs: 500 }), 'wrapup');
    const g = store.get('rt4');
    eq(g.status, 'budget_limited');
    eq(g.statusReason, 'budget_limited(token)');
    eq(g.tokensUsed, 35, '触顶轮的用量照记');
  });

  await test('goal: 运行时——turn 内改写目标文本，工具轮下一轮收到【目标已更新】且只提醒一次', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt-edit-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rtedit', config: parseGoalConfig(undefined),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
    });
    rt.tools[0].run({ objective: 'GOAL_EDIT_OLD 把 README 安装章节改写' });
    rt.beginTurn();
    const usage = { prompt_tokens: 20, completion_tokens: 15 };
    eq(rt.afterRound({ replyText: '开工', toolCalls: [{ name: 'read_file' }], usage, roundMs: 100 }), undefined);
    // 用户在 turn 进行中经网页 /goal edit 改写目标文本（REST 落盘）
    store.update('rtedit', (g) => ({ ...g, objective: 'GOAL_EDIT_NEW 把发布笔记章节改写' }));
    eq(rt.afterRound({ replyText: '继续', toolCalls: [{ name: 'read_file' }], usage, roundMs: 100 }), 'updated', '工具轮检出目标改写应转 updated');
    const note = rt.consumeNote();
    assert(note.includes('【目标已更新】') && note.includes('GOAL_EDIT_NEW'), '提醒应带新目标文本');
    eq(rt.consumeNote(), null, '提醒一次性消费');
    eq(rt.afterRound({ replyText: '再继续', toolCalls: [{ name: 'read_file' }], usage, roundMs: 100 }), undefined, '同一改写只提醒一次');
    assert(events.some((e) => e.t === 'goal_status_changed' && e.p.goal.objective.includes('GOAL_EDIT_NEW')), '改写应触发状态事件让两端刷新文本');
  });

  await test('goal: 运行时——空转轮前改写目标走【目标已更新】，针对旧目标的提案作废', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt-edit2-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rtedit2', config: parseGoalConfig(undefined),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
    });
    rt.tools[0].run({ objective: 'GOAL_EDIT_OLD 把 README 安装章节改写' });
    rt.beginTurn();
    const usage = { prompt_tokens: 20, completion_tokens: 15 };
    eq(rt.afterRound({ replyText: '开工', toolCalls: [{ name: 'read_file' }], usage, roundMs: 100 }), undefined);
    store.update('rtedit2', (g) => ({ ...g, objective: 'GOAL_EDIT_NEW 把发布笔记章节改写' }));
    // 模型不知情，仍按旧目标提案完成
    rt.tools[1].run({ mode: 'status', status: 'complete', summary: '旧目标已搞定' });
    eq(rt.afterRound({ replyText: '', toolCalls: [{ name: 'update_goal' }], usage, roundMs: 100 }), 'proposal');
    const d = await rt.onProposal();
    eq(d.action, 'continue', '旧提案作废：改带【目标已更新】续轮而非直接结算');
    assert(d.extraSystem.includes('【目标已更新】') && d.extraSystem.includes('GOAL_EDIT_NEW'), '续轮提醒应带新目标');
    eq(store.get('rtedit2').status, 'active', '旧目标的完成提案不得把新目标标记完成');
    assert(!events.some((e) => e.t === 'goal_status_changed' && e.p.goal.status !== 'active'), '不应发生任何状态迁移');
  });

  await test('goal: 运行时——目标不在管辖（暂停）时改写文本不产生提醒', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt-edit3-'));
    const store = new GoalStore(dir);
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rtedit3', config: parseGoalConfig(undefined),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: () => {},
    });
    rt.tools[0].run({ objective: '旧目标' });
    store.update('rtedit3', (g) => ({ ...g, status: 'paused', statusReason: 'paused(user_requested)' }));
    rt.beginTurn();
    store.update('rtedit3', (g) => ({ ...g, objective: '新目标' }));
    eq(rt.afterRound({ replyText: 'x', toolCalls: [{ name: 'read_file' }], usage: { prompt_tokens: 1, completion_tokens: 1 }, roundMs: 10 }), undefined);
    eq(rt.consumeNote(), null, '非管辖目标不注入提醒');
  });

  await test('goal: 运行时 onProposal 结算完成提案为 complete(worker_proposal)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt5-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rt5', config: parseGoalConfig(undefined),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
    });
    rt.tools[0].run({ objective: '提案结算' });
    rt.beginTurn();
    rt.tools[1].run({ mode: 'status', status: 'complete', summary: '已搞定' });
    eq(rt.afterRound({ replyText: '', toolCalls: [{ name: 'update_goal' }], usage: { prompt_tokens: 20, completion_tokens: 15 }, roundMs: 100 }), 'proposal', '提案轮应转结算而非直接收尾');
    const d = await rt.onProposal();
    eq(d.action, 'finish', 'none 档验证直接采信提案');
    const g = store.get('rt5');
    eq(g.status, 'complete');
    eq(g.statusReason, 'complete(worker_proposal)');
    eq(g.lastWorkerProposal.summary, '已搞定');
    const done = events.filter((e) => e.t === 'goal_status_changed' && e.p.goal.status === 'complete');
    eq(done.length, 1, '应恰好发一次完成事件');
  });

  await test('goal: 运行时 finish 兜底结算（maxRounds 触顶时提案不丢）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt7-'));
    const store = new GoalStore(dir);
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rt7', config: parseGoalConfig(undefined),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: () => {},
    });
    rt.tools[0].run({ objective: '兜底结算' });
    rt.beginTurn();
    rt.tools[1].run({ mode: 'status', status: 'blocked', summary: '外部依赖缺失' });
    await rt.finish();
    const g = store.get('rt7');
    eq(g.status, 'blocked');
    eq(g.statusReason, 'blocked(worker_reported)');
  });

  await test('goal: onIdle 无目标照旧结束，有目标注入续跑提醒', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt8-'));
    const store = new GoalStore(dir);
    const events = [];
    const mk = (sid) => createGoalRuntime({
      goalStore: store, sessionId: sid, config: parseGoalConfig(undefined),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
    });
    const none = mk('rt8-none');
    none.beginTurn();
    eq((await none.onIdle({ replyText: '普通回答', usage: { prompt_tokens: 1, completion_tokens: 1 } })).action, 'finish', '无目标不应续跑');
    const active = mk('rt8');
    active.tools[0].run({ objective: '续跑测试' });
    active.beginTurn();
    const d = await active.onIdle({ replyText: '我先想想', usage: { prompt_tokens: 20, completion_tokens: 15 }, roundMs: 1000 });
    eq(d.action, 'continue', 'active 目标空转应续跑');
    assert(d.extraSystem.includes('【目标续跑】'), '续跑提醒应带标记');
    const g = store.get('rt8');
    eq(g.turnsUsed, 1, '空转轮也计入 goal 轮');
    eq(g.timeUsedSeconds, 1);
  });

  await test('goal: wait 设置/清除 executionWait 并发 goal_wait_changed，非 active 无效', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt9-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rt9', config: parseGoalConfig(undefined),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
    });
    rt.tools[0].run({ objective: '等待测试' });
    rt.beginTurn();
    rt.wait('permission');
    eq(store.get('rt9').executionWait.reason, 'permission');
    rt.wait('permission');
    eq(events.filter((e) => e.t === 'goal_wait_changed').length, 1, '同因不重复发事件');
    rt.wait(null);
    eq(store.get('rt9').executionWait, null);
    store.update('rt9', (g) => ({ ...g, status: 'paused' }));
    rt.wait('verification');
    eq(store.get('rt9').executionWait, null, '非 active 目标不记录等待');
    eq(events.filter((e) => e.t === 'goal_wait_changed').length, 2, '非 active 的 wait 不应发事件');
  });

  await test('goal: parseVerdict 只认 JSON 裁决，失败按 inconclusive', () => {
    eq(parseVerdict('{"verdict":"met","evidence":"ok"}').verdict, 'met');
    eq(parseVerdict('{"verdict":"not_met","evidence":"缺口","missing":["缺口一"]}').verdict, 'not_met');
    eq(parseVerdict('前缀 {"verdict":"impossible","evidence":"x"} 后缀').verdict, 'impossible');
    eq(parseVerdict('我觉得大概完成了').verdict, 'inconclusive', '非 JSON 不能悄悄放行');
    eq(parseVerdict('{"verdict":"maybe"}').verdict, 'inconclusive', '非法裁决值按 inconclusive');
    eq(parseVerdict('').verdict, 'inconclusive');
    // missing 缺口清单解析（对齐 MiniMax evaluator schema：not_met 逐条缺口）
    const nm = parseVerdict('{"verdict":"not_met","evidence":"e","missing":["缺 A","缺 B","缺 C"]}');
    assert(Array.isArray(nm.missing) && nm.missing.length === 3 && nm.missing.includes('缺 A') && nm.missing.includes('缺 C'), 'not_met 应解析出 missing 数组');
    eq(parseVerdict('{"verdict":"met","evidence":"ok"}').missing.length, 0, 'met 无 missing 时回退空数组');
    const trunc = parseVerdict(`{"verdict":"not_met","evidence":"e","missing":["${'x'.repeat(1200)}","  ","ok"]}`);
    eq(trunc.missing.length, 2, '空串项被剔除、非字符串项被过滤');
    assert(trunc.missing.some((m) => m.length === 1000) && trunc.missing.includes('ok'), '单条缺口截断到 1000 字符（归一化排序后位置不固定）');
    const capped = parseVerdict(`{"verdict":"not_met","evidence":"e","missing":${JSON.stringify(Array.from({ length: 60 }, (_, i) => `g${i}`))}}`);
    eq(capped.missing.length, 50, 'missing 上限 50 条');
  });

  await test('goal: parseVerdict 结构性校验——载荷不完整降级 inconclusive(schema_error)（对齐 MiniMax）', () => {
    const noMissing = parseVerdict('{"verdict":"not_met","evidence":"e"}');
    eq(noMissing.verdict, 'inconclusive', 'not_met 缺 missing 不能算数：降级而非放行');
    eq(noMissing.code, 'schema_error', '降级应带协议层归因');
    const noEvidence = parseVerdict('{"verdict":"met"}');
    eq(noEvidence.verdict, 'inconclusive', 'met 无依据不能放行');
    eq(noEvidence.code, 'schema_error');
    eq(parseVerdict('{"verdict":"impossible"}').verdict, 'inconclusive', 'impossible 无依据同样降级');
    const withCode = parseVerdict('{"verdict":"inconclusive","evidence":"证据不足","code":"timeout"}');
    eq(withCode.verdict, 'inconclusive');
    eq(withCode.code, 'timeout', '模型自带 code 原样透出供宿主归因');
    const deduped = parseVerdict('{"verdict":"not_met","evidence":"e","missing":["a  b","a b","c","c"]}');
    eq(deduped.missing.join('|'), 'a b|c', 'missing 归一化：空白折叠 + 去重 + 排序（对齐 MiniMax normalizeMissing）');
  });

  await test('goal: 续跑提醒每轮重述目标——上下文压缩失忆防护（对齐 MiniMax continuationBody）', () => {
    const note = goalContinuationNote({ objective: '把 README 安装章节改写' });
    assert(note.includes('【目标续跑】'), '提醒本体在场');
    assert(note.includes('<objective>') && note.includes('把 README 安装章节改写'), '目标文本随每轮提醒重述');
    const escaped = goalContinuationNote({ objective: 'a<b>&c' });
    assert(escaped.includes('a&lt;b&gt;&amp;c'), '目标按不可信数据 XML 转义（对齐 escapeXmlText）');
    assert(!goalContinuationNote({}).includes('<objective>'), '无目标文本时不加空 objective 块');
    assert(!goalContinuationNote({ objective: 'x'.repeat(2500) }).includes('x'.repeat(2001)), '超长目标截断到 2000 字符');
  });

  await test('goal: 目标已更新提醒——不可信包裹 + 预算快照（对齐 MiniMax renderObjectiveUpdatedPrompt）', () => {
    const note = goalObjectiveUpdatedNote({ objective: 'a<b>&c', tokensUsed: 1200, tokenBudget: 5000 });
    assert(note.includes('【目标已更新】'), '应带标记');
    assert(note.includes('<untrusted_objective>') && note.includes('a&lt;b&gt;&amp;c'), '新目标按不可信数据 XML 转义包裹');
    assert(note.includes('已用 1200') && note.includes('上限 5000') && note.includes('剩余 3800'), '应附预算快照');
    assert(note.includes('不要继续') && note.includes('不要因此调用 update_goal'), '应提示调整方向且不借此提案完成');
    const unlimited = goalObjectiveUpdatedNote({ objective: 'x', tokensUsed: 10, tokenBudget: null });
    assert(unlimited.includes('上限 unlimited') && unlimited.includes('剩余 unlimited'), '无预算记 unlimited（对齐 codex parity）');
    assert(!goalObjectiveUpdatedNote({}).includes('<untrusted_objective>'), '无目标文本时不加空包裹块');
  });

  await test('goal: 轮首重述提醒——目标文本 + 每 5 轮状态审计（对齐 MiniMax reminder-policy）', () => {
    const note = goalTurnStartNote({ objective: 'a<b>&c', turnsUsed: 3 });
    assert(note.includes('【进行中的目标】'), '应带标记');
    assert(note.includes('<objective>') && note.includes('a&lt;b&gt;&amp;c'), '应按不可信数据包裹重述目标');
    assert(!note.includes('【目标状态审计】'), '未到审计间隔不应出现审计段');
    eq(goalTurnStartNote({ turnsUsed: 4 }).includes('【目标状态审计】'), false, '第 4 轮不审计');
    assert(goalTurnStartNote({ turnsUsed: 5 }).includes('【目标状态审计】'), '第 5 轮应审计');
    assert(goalTurnStartNote({ turnsUsed: 10 }).includes('【目标状态审计】'), '第 10 轮应审计');
    eq(goalTurnStartNote({ turnsUsed: 0 }).includes('【目标状态审计】'), false, '第 0 轮不审计');
    assert(!goalTurnStartNote({}).includes('<objective>'), '无目标文本时不加空包裹块');
    eq(GOAL_AUDIT_INTERVAL, 5);
  });

  await test('goal: 运行时 beginTurn——active 目标返回轮首重述，暂停 / 无目标返回 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt-start-'));
    const store = new GoalStore(dir);
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rtstart', config: parseGoalConfig(undefined),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: () => {},
    });
    eq(rt.beginTurn(), null, '无目标时返回 null');
    rt.tools[0].run({ objective: '轮首重述测试' });
    const note = rt.beginTurn();
    assert(note && note.includes('【进行中的目标】') && note.includes('轮首重述测试'), 'active 目标应返回带目标文本的重述');
    store.update('rtstart', (g) => ({ ...g, status: 'paused', statusReason: 'paused(user_requested)' }));
    eq(rt.beginTurn(), null, '暂停目标不重述');
  });

  await test('goal: 续跑/收尾/验证反馈提醒文案单一事实源', () => {
    assert(GOAL_CONTINUATION_NOTE.includes('【目标续跑】'), '续跑提醒应带标记（mock 与测试依赖）');
    assert(GOAL_WRAPUP_NOTE.includes('【目标预算收尾】'), '收尾提醒应带标记');
    assert(GOAL_WRAPUP_NOTE.includes('不要调用任何工具'), '收尾轮禁工具');
    const note = goalVerifierFeedbackNote({ evidence: 'README 未改' }, 2, 5);
    assert(note.includes('第 2/5 次') && note.includes('README 未改'), '反馈提醒应带连胜与证据');
    const many = Array.from({ length: 12 }, (_, i) => `缺 ${String.fromCharCode(65 + i)}`);
    const withMissing = goalVerifierFeedbackNote({ evidence: 'e', missing: many }, 3, 5);
    assert(withMissing.includes('缺 A') && withMissing.includes('缺 J'), '反馈提醒应带前 10 条缺口（对齐 MAX_FEEDBACK_ITEMS）');
    assert(withMissing.includes('另有 2 条缺口从简略提示中省略'), '超出 10 条应记省略数');
    const longGap = goalVerifierFeedbackNote({ evidence: 'e', missing: ['x'.repeat(300)] }, 1, 5);
    assert(!longGap.includes('x'.repeat(241)) && longGap.includes('…'), '单条缺口截断到 240 字符（对齐 MAX_FEEDBACK_ITEM_CHARS）');
    assert(!goalVerifierFeedbackNote({ evidence: 'e' }, 1, 5).includes('尚未满足的缺口'), '无 missing 不渲染缺口块');
  });

  await test('goal: evaluator 档验证器不可用转 paused(verifier_unavailable)，不静默放行', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt10-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rt10', config: parseGoalConfig({ verification: 'evaluator', evaluatorModel: 'LongCat-2.0' }),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
      provider: { id: 'fake', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'x', builtin: false },
    });
    rt.tools[0].run({ objective: '验证不可用' });
    rt.beginTurn();
    rt.tools[1].run({ mode: 'status', status: 'complete', summary: '自称完成' });
    const d = await rt.onProposal();
    eq(d.action, 'finish', '验证器不可用应收尾并暂停，不放行');
    const g = store.get('rt10');
    eq(g.status, 'paused');
    eq(g.statusReason, 'paused(verifier_unavailable)');
    eq(g.lastVerification.verdict, 'unavailable');
  });

  await test('goal: subagent 档 not_met 的 missing 缺口清单透出到 lastVerification 并要求续跑', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt11-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rt11', config: parseGoalConfig({ verification: 'subagent' }),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
      provider: { id: 'fake', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'x', builtin: false },
    });
    rt.bindSpawn(async () => ({ output: '{"verdict":"not_met","evidence":"README 未改","missing":["缺 A","缺 B","缺 C"]}' }));
    rt.tools[0].run({ objective: '改写 README' });
    rt.beginTurn();
    rt.tools[1].run({ mode: 'status', status: 'complete', summary: '自称改完' });
    const d = await rt.onProposal();
    eq(d.action, 'continue', '未到受阻阈值应带着缺口续跑');
    assert(String(d.extraSystem).includes('缺 A') && String(d.extraSystem).includes('缺 C'), '续跑提醒应带上 missing 缺口');
    const g = store.get('rt11');
    eq(g.status, 'active', 'not_met 未连击不改状态');
    eq(g.lastVerification.verdict, 'not_met');
    assert(Array.isArray(g.lastVerification.missing) && g.lastVerification.missing.length === 3, 'missing 应透出到 lastVerification');
    eq(g.lastVerification.notMetStreak, 1);
  });

  await test('goal: not_met streak 指纹语义——同一批缺口才累加，达到阈值转 paused(no_progress)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt12-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rt12', config: parseGoalConfig({ verification: 'subagent' }),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
      provider: { id: 'fake', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'x', builtin: false },
    });
    rt.bindSpawn(async () => ({ output: '{"verdict":"not_met","evidence":"README 未改","missing":["缺 A","缺 B"]}' }));
    rt.tools[0].run({ objective: '改写 README' });
    rt.beginTurn();
    for (let i = 1; i <= 5; i++) {
      rt.tools[1].run({ mode: 'status', status: 'complete', summary: `第 ${i} 次自称改完` });
      const d = await rt.onProposal();
      if (i < 5) {
        eq(d.action, 'continue', `第 ${i} 次未达到阈值应带反馈续跑`);
        eq(store.get('rt12').lastVerification.notMetStreak, i, '同一批缺口应逐轮累加 streak');
      } else {
        eq(d.action, 'finish', '达到 repeatedNotMetLimit 应收尾（对齐 MiniMax repeatedGap 覆盖式决策）');
      }
    }
    const g = store.get('rt12');
    eq(g.status, 'paused');
    eq(g.statusReason, 'paused(no_progress)');
    eq(g.lastVerification.notMetStreak, 5);
  });

  await test('goal: not_met 缺口变化则重新计数，不到阈值不暂停', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt13-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rt13', config: parseGoalConfig({ verification: 'subagent' }),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
      provider: { id: 'fake', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'x', builtin: false },
    });
    let round = 0;
    rt.bindSpawn(async () => {
      round += 1;
      return { output: JSON.stringify({ verdict: 'not_met', evidence: `第 ${round} 批缺口`, missing: [`缺口 ${round}`] }) };
    });
    rt.tools[0].run({ objective: '改写 README' });
    rt.beginTurn();
    for (let i = 1; i <= 4; i++) {
      rt.tools[1].run({ mode: 'status', status: 'complete', summary: `第 ${i} 次自称改完` });
      const d = await rt.onProposal();
      eq(d.action, 'continue', '缺口每轮都变：streak 始终为 1，不该暂停');
      eq(store.get('rt13').lastVerification.notMetStreak, 1, '缺口集合不同应重新计数（指纹语义）');
    }
    eq(store.get('rt13').status, 'active');
  });

  await test('goal: inconclusive 按 code 归因暂停——schema_error → verifier_protocol，不累加 not_met 连胜', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt14-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'rt14', config: parseGoalConfig({ verification: 'subagent' }),
      harnessTools: ['create_goal', 'update_goal', 'get_goal'], emit: (t, p) => events.push({ t, p }),
      provider: { id: 'fake', protocol: 'openai', baseUrl: 'http://127.0.0.1:1', apiKey: 'x', builtin: false },
    });
    rt.bindSpawn(async () => ({ output: '{"verdict":"not_met","evidence":"缺 missing 的残缺载荷"}' }));
    rt.tools[0].run({ objective: '改写 README' });
    rt.beginTurn();
    rt.tools[1].run({ mode: 'status', status: 'complete', summary: '自称改完' });
    const d = await rt.onProposal();
    eq(d.action, 'finish', 'inconclusive 应收尾不续跑（对齐 MiniMax threadGoalInconclusiveTransition）');
    const g = store.get('rt14');
    eq(g.status, 'paused');
    eq(g.statusReason, 'paused(verifier_protocol)');
    eq(g.lastVerification.verdict, 'inconclusive');
    eq(g.lastVerification.notMetStreak, 0, 'inconclusive 不累加 not_met 连胜');
  });

  await test('goal: 无目标会话的钩子是廉价空操作', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-rt6-'));
    const store = new GoalStore(dir);
    const events = [];
    const rt = createGoalRuntime({
      goalStore: store, sessionId: 'none', config: parseGoalConfig(undefined),
      harnessTools: [], emit: (t, p) => events.push({ t, p }),
    });
    rt.beginTurn();
    eq(rt.afterRound({ replyText: '普通回答', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), undefined);
    eq(rt.current(), null);
    eq(events.length, 0, '无目标不应发任何 goal 事件');
    // harness 未收录时工具拒绝执行
    eq(String(rt.tools[0].run({ objective: 'x' })), '当前模式不提供 create_goal 工具。');
  });

  await test('goal: /goal 命令解析（查看 / 创建 / 预算形态 / 旧式空格 / 动作 / 帮助 / 错误）', () => {
    // 查看与创建
    eq(parseGoalCommand('').kind, 'view');
    eq(parseGoalCommand('   ').kind, 'view');
    eq(parseGoalCommand('把 README 改写').kind, 'create');
    eq(parseGoalCommand('把 README 改写').objective, '把 README 改写');
    // 预算后缀与首部指令
    const trailing = parseGoalCommand('修复登录 bug budget=50K');
    eq(trailing.kind, 'create');
    eq(trailing.objective, '修复登录 bug');
    eq(trailing.tokenBudget, 50000);
    const leading = parseGoalCommand('budget=1.5M 压测大上下文');
    eq(leading.kind, 'create');
    eq(leading.objective, '压测大上下文');
    eq(leading.tokenBudget, 1500000);
    // 单独出现时只改预算（= 形态与旧式空格形态并存）
    eq(parseGoalCommand('budget=50K').kind, 'budget');
    eq(parseGoalCommand('budget=50K').tokenBudget, 50000);
    eq(parseGoalCommand('budget 50000').kind, 'budget');
    eq(parseGoalCommand('budget 50000').tokenBudget, 50000);
    // 清除同义词（裸 budget 除外——见下方错误分支）
    for (const raw of ['budget=clear', 'budget=null', 'budget=none', 'budget=off', 'budget=0', 'budget clear']) {
      eq(parseGoalCommand(raw).kind, 'budget', `${raw} 应解析为预算清除`);
      eq(parseGoalCommand(raw).tokenBudget, null, `${raw} 应清除上限`);
    }
    // 裸 /goal budget 无值一律报错：绝不明静默清除上限（对齐 MiniMax '/goal budget needs a value'）
    const bareBudget = parseGoalCommand('budget');
    eq(bareBudget.kind, 'error');
    assert(bareBudget.message.includes('budget=50K') && bareBudget.message.includes('budget=clear'), '报错文案应给出两种可操作写法');
    // 错误分支
    eq(parseGoalCommand('budget=abc').kind, 'error');
    eq(parseGoalCommand('budget -5').kind, 'error');
    eq(parseGoalCommand('budget=50K 修复 bug budget=1M').kind, 'error', '首尾各一个 budget= 应报错');
    const leftover = parseGoalCommand('修复 bug budget=50K budget=1M');
    eq(leftover.kind, 'create', '尾随之后的残留 budget= 属目标文本（与 MiniMax 一致）');
    eq(leftover.objective, '修复 bug budget=50K');
    eq(parseGoalCommand('pause 现在').kind, 'error');
    eq(parseGoalCommand('clear x').kind, 'error');
    // 动作与帮助
    eq(parseGoalCommand('pause').kind, 'pause');
    eq(parseGoalCommand('resume').kind, 'resume');
    eq(parseGoalCommand('stop').kind, 'stop');
    eq(parseGoalCommand('edit').kind, 'edit');
    eq(parseGoalCommand('clear').kind, 'clear');
    // cancel / delete 为 clear 同义别名（对齐 MiniMax thread-goal-command）
    eq(parseGoalCommand('cancel').kind, 'clear');
    eq(parseGoalCommand('delete').kind, 'clear');
    eq(parseGoalCommand('CANCEL').kind, 'clear', '别名大小写不敏感');
    eq(parseGoalCommand('cancel x').kind, 'error', '别名同样不接受参数');
    eq(parseGoalCommand('help').kind, 'help');
    // 动作大小写不敏感；目标文本里的动作词不做关键字
    eq(parseGoalCommand('PAUSE').kind, 'pause');
    eq(parseGoalCommand('暂停自动续跑').kind, 'create');
  });

  await test('goal: /goal 文案助手（提示 / 摘要 / 完成回执）', () => {
    assert(goalActionHint('active').includes('/goal pause'), '进行中应提示暂停');
    assert(goalActionHint('budget_limited').includes('抬高预算'), '预算耗尽应提示抬高预算');
    assert(goalActionHint('complete').includes('新目标'), '已完成应提示开新目标');
    assert(goalActionHint('complete').includes('/goal clear'), '已完成提示应补移除目标那半（对齐 MiniMax actionHint）');
    const g = { status: 'active', objective: '改写 README', tokensUsed: 12500, turnsUsed: 3, timeUsedSeconds: 120, tokenBudget: 50000, lastVerification: null };
    const summary = formatGoalSummary(g);
    assert(summary.includes('改写 README') && summary.includes('13K') && summary.includes('2min'), '摘要应含目标 / 用量 / 时长');
    assert(summary.includes('预算：50000 tokens'), '摘要应含预算');
    const withV = formatGoalSummary({ ...g, lastVerification: { verdict: 'not_met', notMetStreak: 2 } });
    assert(withV.includes('未达到') && withV.includes('连续 2 次'), '摘要应带验证结论与连击');
    const withMissing = formatGoalSummary({ ...g, lastVerification: { verdict: 'not_met', notMetStreak: 2, missing: ['缺 A', '缺 B', '缺 C'] } });
    assert(withMissing.includes('缺口：缺 A；缺 B') && withMissing.includes('+1'), 'not_met 摘要应展示前 2 条缺口并记 +N');
    const receipt = formatGoalReceipt({ ...g, status: 'complete' });
    assert(receipt.includes('2min') && receipt.includes('13K tokens') && receipt.includes('3 轮'), '回执应含时长 / token / 轮次（计数紧凑化）');
    assert(GOAL_COMMAND_HELP.includes('/goal edit'), '帮助应含 edit');
    assert(GOAL_COMMAND_HELP.includes('cancel / delete'), '帮助应说明 clear 别名');
  });

  await test('goal: setUserGoalObjective 创建 / 改写 / 完成拒绝 / 预算重武装', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-obj-'));
    const store = new GoalStore(dir);
    const created = setUserGoalObjective(store, 'obj1', '  第一个目标  ');
    eq(created.objective, '第一个目标');
    eq(created.status, 'active');
    eq(store.get('obj1').objective, '第一个目标');
    const edited = setUserGoalObjective(store, 'obj1', '改写后的目标');
    eq(edited.objective, '改写后的目标');
    eq(edited.goalId, created.goalId, '改写应保留同一 goalId');
    // 压低预算后用尽 → budget_limited；随文携带更大预算应重新武装
    const lowered = applyUserGoalAction(store, 'obj1', 'budget', { tokenBudget: 10, expectedUpdatedAt: edited.updatedAt });
    eq(lowered.tokenBudget, 10);
    store.update('obj1', (g) => {
      const n = applyUsage(g, { tokens: 18 });
      const br = budgetBreach(n);
      return br ? { ...n, status: 'budget_limited', statusReason: br.reason } : n;
    });
    eq(store.get('obj1').status, 'budget_limited', '用量超过新预算应触顶');
    const rearmed = setUserGoalObjective(store, 'obj1', '继续推进', 100);
    eq(rearmed.status, 'active', '抬高预算应重新武装');
    eq(rearmed.tokenBudget, 100);
    eq(rearmed.objective, '继续推进', '随文预算不得覆盖新目标文本（增量复合回归）');
    // 空白拒绝与已完成拒绝
    let blankErr = null;
    try { setUserGoalObjective(store, 'obj2', '  '); } catch (e) { blankErr = e; }
    assert(blankErr && blankErr.code === 'GOAL_BAD_OBJECTIVE', '空白目标应拒绝');
    applyUserGoalAction(store, 'obj1', 'stop');
    let editErr = null;
    try { applyUserGoalAction(store, 'obj1', 'edit', { objective: '又改' }); } catch (e) { editErr = e; }
    assert(editErr && editErr.code === 'GOAL_STATUS_CONFLICT', '已完成目标不能经 edit 改写');
    const fresh = setUserGoalObjective(store, 'obj1', '全新目标');
    eq(fresh.status, 'active', '已完成目标后 setUserGoalObjective 应创建新目标');
    assert(fresh.goalId !== created.goalId, '新目标应是新 goalId');
  });


  await test('goal: edit 动作随文携带 tokenBudget（含纪元校验与重新武装）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-editbud-'));
    const store = new GoalStore(dir);
    const g0 = store.create('eb1', { objective: '初版', tokenBudget: 100 });
    const edited = applyUserGoalAction(store, 'eb1', 'edit', { objective: '二版', tokenBudget: 200 });
    eq(edited.objective, '二版');
    eq(edited.tokenBudget, 200, 'edit 应一并应用预算');
    let stale = null;
    try { applyUserGoalAction(store, 'eb1', 'edit', { objective: '三版', tokenBudget: 300, expectedUpdatedAt: g0.updatedAt }); } catch (e) { stale = e; }
    assert(stale && stale.code === 'GOAL_STALE', 'edit 带预算应校验纪元');
    const ok = applyUserGoalAction(store, 'eb1', 'edit', { objective: '三版', tokenBudget: 300, expectedUpdatedAt: edited.updatedAt });
    eq(ok.objective, '三版');
    eq(ok.tokenBudget, 300);
    store.update('eb1', (g) => applyUsage(g, { tokens: 500 }));
    store.update('eb1', (g) => {
      const br = budgetBreach(g);
      return br ? { ...g, status: 'budget_limited', statusReason: br.reason } : g;
    });
    eq(store.get('eb1').status, 'budget_limited');
    const rearmed = applyUserGoalAction(store, 'eb1', 'edit', { objective: '四版', tokenBudget: 900 });
    eq(rearmed.status, 'active', 'edit 抬高预算应重新武装');
    eq(rearmed.objective, '四版', '重新武装不应丢目标文本');
    let bad = null;
    try { applyUserGoalAction(store, 'eb1', 'edit', { objective: '五版', tokenBudget: -1 }); } catch (e) { bad = e; }
    assert(bad && bad.code === 'GOAL_BAD_BUDGET', 'edit 坏预算应 400 类拒绝');
  });
  await test('goal: clearUserGoal 幂等移除', () => {
    const dir = mkdtempSync(join(tmpdir(), 'goal-clear-'));
    const store = new GoalStore(dir);
    eq(clearUserGoal(store, 'c1').cleared, false, '无目标时 cleared=false');
    store.create('c1', { objective: 'x' });
    eq(clearUserGoal(store, 'c1').cleared, true);
    eq(store.get('c1'), null, '移除后查询为 null');
    eq(clearUserGoal(store, 'c1').cleared, false, '再次移除幂等');
  });

}
