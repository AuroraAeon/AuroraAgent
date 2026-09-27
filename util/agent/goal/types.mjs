/**
 * Thread Goal：跨轮次存续的会话级目标（语义对齐 MiniMax-code packages/agent-modules/goal，
 * 按本地单用户场景零依赖落地）。状态语义由「宿主」拥有，三方权限刻意不对称：
 *
 *   - 模型（update_goal）只能提案 complete / blocked，或在用户显式要求的轮次里
 *     带着新鲜 get_goal 快照改 token 预算；持久结算与变更策略归宿主。
 *   - 用户（/goal/* REST 面与终端 /goal）拥有除「预算或工作量已耗尽的目标重新
 *回到 active」之外的全部迁移：可暂停 active、任意状态停止、恢复 paused/blocked/
 *     usage_limited；对 complete / budget_limited 恢复 active 一律 409 拒绝。
 *   - 系统（记账绑定）在 tokensUsed >= tokenBudget 时把 active 自动迁到 budget_limited。
 *
 * 存储形态对齐 codex thread_goals：一会话至多一个目标，仅当旧目标 complete 时才允许替换。
 * 时间戳一律 Unix 毫秒（存储与 API 不带 ISO 字符串，展示层自行转换）。
 */

export const THREAD_GOAL_STATUSES = ['active', 'paused', 'blocked', 'complete', 'budget_limited', 'usage_limited'];

export const THREAD_GOAL_STATUS_REASONS = [
  'complete(worker_proposal)',
  'complete(verifier_met)',
  'complete(user_requested)',
  'paused(user_requested)',
  'paused(retracted)',
  'paused(no_progress)',
  'paused(verifier_unavailable)',
  'paused(verifier_protocol)',
  'paused(verifier_timeout)',
  'paused(verifier_aborted)',
  'paused(infra_retryable)',
  'blocked(worker_reported)',
  'blocked(safety_policy)',
  'blocked(verifier_impossible)',
  'budget_limited(token)',
  'budget_limited(main_turn)',
  'budget_limited(active_time)',
  'usage_limited(provider_quota)',
  'usage_limited(rate_limit)',
];

/** 进入这些状态即停止自动续跑；能否恢复是另一回事（见 TERMINAL_STATUSES 注释） */
export const TERMINAL_STATUSES = ['complete', 'blocked', 'budget_limited', 'usage_limited'];

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(String(status || ''));
}

/** active 目标当前为何没在跑（null = 没有等待）；仅 active 有意义，读路径对其他状态强制 null */
export const THREAD_GOAL_WAIT_REASONS = ['permission', 'plan', 'verification', 'unknown'];

export const GOAL_VERIFICATIONS = ['none', 'evaluator', 'subagent'];

/** 生成稳定不透明 id（tg_ 前缀 + 随机段；不暴露会话 id） */
export function newGoalId() {
  return `tg_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * 新建目标行。tokensUsed / turnsUsed / timeUsedSeconds 均为单调非负整数，0 = 还没干活。
 * tokenBudget 为 null 表示不设上限（跑到用户或模型喊停为止）。
 */
export function createGoalState({ sessionId, objective, tokenBudget = null, now = Date.now() }) {
  return {
    goalId: newGoalId(),
    sessionId: String(sessionId || ''),
    objective: String(objective || '').slice(0, 2000),
    status: 'active',
    createdAt: now,
    updatedAt: now,
    tokensUsed: 0,
    turnsUsed: 0,
    timeUsedSeconds: 0,
    tokenBudget: Number.isInteger(tokenBudget) && tokenBudget > 0 ? tokenBudget : null,
    noProgressStreak: 0,
    noToolStreak: 0,
    replyFingerprint: null,
    lastVerification: null,
    lastWorkerProposal: null,
    statusReason: null,
    executionWait: null,
  };
}

/**
 * 读路径归一化：坏字段一律回退安全值（与会话投影容错同构），
 * executionWait 仅 active 保留——陈旧等待不能让已暂停/已结束的目标看起来还在等。
 */
export function normalizeGoalState(raw) {
  const g = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d = 0) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  const status = THREAD_GOAL_STATUSES.includes(g.status) ? g.status : 'active';
  return {
    goalId: String(g.goalId || ''),
    sessionId: String(g.sessionId || ''),
    objective: String(g.objective || ''),
    status,
    createdAt: num(g.createdAt, Date.now()),
    updatedAt: num(g.updatedAt, Date.now()),
    tokensUsed: num(g.tokensUsed),
    turnsUsed: num(g.turnsUsed),
    timeUsedSeconds: num(g.timeUsedSeconds),
    tokenBudget: Number.isInteger(g.tokenBudget) && g.tokenBudget > 0 ? g.tokenBudget : null,
    noProgressStreak: num(g.noProgressStreak),
    noToolStreak: num(g.noToolStreak),
    replyFingerprint: typeof g.replyFingerprint === 'string' ? g.replyFingerprint : null,
    lastVerification: g.lastVerification && typeof g.lastVerification === 'object' ? g.lastVerification : null,
    lastWorkerProposal: g.lastWorkerProposal && typeof g.lastWorkerProposal === 'object' ? g.lastWorkerProposal : null,
    statusReason: THREAD_GOAL_STATUS_REASONS.includes(g.statusReason) ? g.statusReason : null,
    executionWait: status === 'active' && g.executionWait && THREAD_GOAL_WAIT_REASONS.includes(g.executionWait.reason)
      ? { reason: g.executionWait.reason, sinceMs: num(g.executionWait.sinceMs, Date.now()) }
      : null,
  };
}

/** 用户面文案：等待原因 → 中文标签（终端 / 网页同源；goal_wait_changed 的 reason 用） */
export const GOAL_WAIT_LABELS = {
  permission: '等待授权',
  plan: '等待计划批准',
  verification: '独立验证中',
  unknown: '等待中',
};

/** 用户面文案：状态 → 中文标签（终端 / 网页同源） */
export const GOAL_STATUS_LABELS = {
  active: '进行中',
  paused: '已暂停',
  blocked: '受阻',
  complete: '已完成',
  budget_limited: '预算耗尽',
  usage_limited: '用量受限',
};

/** 状态迁移合法性（用户面）：仅列「允许」的迁移，其余一律拒绝 */
export function canTransition(from, to) {
  const f = String(from || '');
  const t = String(to || '');
  if (f === t) return true;
  if (f === 'complete') return false; // complete 是终态中的终态，任何迁移都不允许
  if (t === 'active') return f === 'paused' || f === 'blocked' || f === 'usage_limited';
  if (t === 'paused') return f === 'active';
  return true; // blocked / complete / budget_limited / usage_limited 可从任意非 complete 状态进入
}
