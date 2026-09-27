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
import { applyUsage, budgetBreach, rearmAfterBudgetRaise, goalUsageChip } from '../util/agent/goal/budget.mjs';
import { replyFingerprint, advanceBreakers } from '../util/agent/goal/breaker.mjs';
import { createGoalRuntime } from '../util/agent/goal/runtime.mjs';
import { parseVerdict } from '../util/agent/goal/verification.mjs';
import { GOAL_CONTINUATION_NOTE, GOAL_WRAPUP_NOTE, goalVerifierFeedbackNote } from '../util/agent/goal/continuation.mjs';

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
    eq(resolveUpdateGoalMode({ token_budget: null }), 'none', '单纯 null 填充不构成预算意图');
    eq(resolveUpdateGoalMode({}), 'none');
    eq(resolveUpdateGoalMode({ mode: 'status', token_budget: 100 }), 'status', '显式 mode 优先，另一模式字段被忽略');
    eq(hasUpdateGoalTokenBudgetIntent({ token_budget: null }), false);
    eq(hasUpdateGoalTokenBudgetIntent({ token_budget: 50 }), true);
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
    eq(c.repeatedReplyLimit, 1, '低于下限钳到 1');
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
    const tooLow = rearmAfterBudgetRaise(limited, 100);
    eq(tooLow.status, 'budget_limited', '压低到已用额度之下不重新武装');
    const turnOut = { ...limited, statusReason: 'budget_limited(main_turn)' };
    eq(rearmAfterBudgetRaise(turnOut, 999).status, 'budget_limited', '主轮耗尽不能靠改 token 预算恢复');
    const active = createGoalState({ sessionId: 's', objective: 'x' });
    eq(rearmAfterBudgetRaise(active, 50).tokenBudget, 50, 'active 目标正常改预算');
  });

  await test('goal: goalUsageChip 形态（K 缩写 · 时分秒）', () => {
    const g = { ...createGoalState({ sessionId: 's', objective: 'x', tokenBudget: 20000 }), tokensUsed: 12500, timeUsedSeconds: 125 };
    eq(goalUsageChip(g), '12.5K / 20.0K · 2m5s');
    const noCap = { ...g, tokenBudget: null, tokensUsed: 800, timeUsedSeconds: 45 };
    eq(goalUsageChip(noCap), '800 · 45s', '无预算时只显示已用与时长');
  });

  await test('goal: replyFingerprint 对空白不敏感，空回复不参与', () => {
    eq(replyFingerprint('你好  世界'), replyFingerprint('你好 世界'));
    assert(replyFingerprint('a') !== replyFingerprint('b'));
    eq(replyFingerprint('   '), '', '纯空白按空回复处理');
  });

  await test('goal: advanceBreakers 双计数器独立触顶，不可信信号不冤枉模型', () => {
    const g = createGoalState({ sessionId: 's', objective: 'x' });
    let cur = g;
    for (let i = 0; i < 2; i++) cur = advanceBreakers(cur, { replyText: '同样的话', toolCommitted: true, limit: 3 }).goal;
    eq(cur.noProgressStreak, 2);
    eq(advanceBreakers(cur, { replyText: '同样的话', toolCommitted: true, limit: 3 }).tripped, true, '第 3 次相同回复触发');
    eq(advanceBreakers(cur, { replyText: '同样的话', toolCommitted: true, limit: 3 }).by, 'reply');
    const spin = advanceBreakers(advanceBreakers(advanceBreakers(g, { replyText: `第${1}句`, toolCommitted: false }).goal, { replyText: `第${2}句`, toolCommitted: false }).goal, { replyText: '第3句', toolCommitted: false });
    eq(spin.goal.noToolStreak, 3, '无工具轮累加');
    eq(spin.tripped, true);
    eq(spin.by, 'no_tool');
    const reset = advanceBreakers(spin.goal, { replyText: '第4句', toolCommitted: false, toolSignalTrustworthy: false });
    eq(reset.goal.noToolStreak, 0, '工具信号不可信时重置，不把不可信的零计成零');
    const empty = advanceBreakers(g, { replyText: '  ', toolCommitted: false });
    eq(empty.goal.noProgressStreak, 0, '空回复中断指纹连胜');
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
    eq(parseVerdict('{"verdict":"not_met","evidence":"缺口"}').verdict, 'not_met');
    eq(parseVerdict('前缀 {"verdict":"impossible","evidence":"x"} 后缀').verdict, 'impossible');
    eq(parseVerdict('我觉得大概完成了').verdict, 'inconclusive', '非 JSON 不能悄悄放行');
    eq(parseVerdict('{"verdict":"maybe"}').verdict, 'inconclusive', '非法裁决值按 inconclusive');
    eq(parseVerdict('').verdict, 'inconclusive');
  });

  await test('goal: 续跑/收尾/验证反馈提醒文案单一事实源', () => {
    assert(GOAL_CONTINUATION_NOTE.includes('【目标续跑】'), '续跑提醒应带标记（mock 与测试依赖）');
    assert(GOAL_WRAPUP_NOTE.includes('【目标预算收尾】'), '收尾提醒应带标记');
    assert(GOAL_WRAPUP_NOTE.includes('不要调用任何工具'), '收尾轮禁工具');
    const note = goalVerifierFeedbackNote({ evidence: 'README 未改' }, 2, 5);
    assert(note.includes('第 2/5 次') && note.includes('README 未改'), '反馈提醒应带连胜与证据');
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
    // 清除同义词
    for (const raw of ['budget=clear', 'budget=null', 'budget=none', 'budget=off', 'budget=0', 'budget clear', 'budget']) {
      eq(parseGoalCommand(raw).kind, 'budget', `${raw} 应解析为预算清除`);
      eq(parseGoalCommand(raw).tokenBudget, null, `${raw} 应清除上限`);
    }
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
    eq(parseGoalCommand('help').kind, 'help');
    // 动作大小写不敏感；目标文本里的动作词不做关键字
    eq(parseGoalCommand('PAUSE').kind, 'pause');
    eq(parseGoalCommand('暂停自动续跑').kind, 'create');
  });

  await test('goal: /goal 文案助手（提示 / 摘要 / 完成回执）', () => {
    assert(goalActionHint('active').includes('/goal pause'), '进行中应提示暂停');
    assert(goalActionHint('budget_limited').includes('抬高预算'), '预算耗尽应提示抬高预算');
    assert(goalActionHint('complete').includes('新目标'), '已完成应提示开新目标');
    const g = { status: 'active', objective: '改写 README', tokensUsed: 12500, turnsUsed: 3, timeUsedSeconds: 120, tokenBudget: 50000, lastVerification: null };
    const summary = formatGoalSummary(g);
    assert(summary.includes('改写 README') && summary.includes('12.5K') && summary.includes('2m'), '摘要应含目标 / 用量 / 时长');
    assert(summary.includes('预算：50000 tokens'), '摘要应含预算');
    const withV = formatGoalSummary({ ...g, lastVerification: { verdict: 'not_met', notMetStreak: 2 } });
    assert(withV.includes('未达到') && withV.includes('连续 2 次'), '摘要应带验证结论与连击');
    const receipt = formatGoalReceipt({ ...g, status: 'complete' });
    assert(receipt.includes('2m') && receipt.includes('12500 tokens') && receipt.includes('3 轮'), '回执应含时长 / token / 轮次');
    assert(GOAL_COMMAND_HELP.includes('/goal edit'), '帮助应含 edit');
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
