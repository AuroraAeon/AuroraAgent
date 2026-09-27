/**
 * Goal 配置解析：auroraagent.config.json 的 goal 段（util/config.mjs 只做委派）。
 * 纪律：单叶损坏独立回退 + 钳制 + 启动告警——一个错值不让整个 goal 模式失效。
 * verification 缺省 none；显式配置 goal.evaluatorModel 才走 evaluator 路由
 * （本地工具不做隐式路由推导）；evaluator 档缺模型名时降级 none 并告警。
 */
import { GOAL_VERIFICATIONS } from './types.mjs';

export const GOAL_EVIDENCE_MODES = ['brief', 'transcript'];

/** 默认值单一出处：回退与钳制边界都以它为准 */
export const GOAL_CONFIG_DEFAULTS = {
  verification: 'none',
  evidence: 'brief',
  graceSteps: 1,
  mainTurns: 0,
  activeSeconds: 0,
  repeatedReplyLimit: 3,
  repeatedNotMetLimit: 5,
  evaluatorModel: '',
  evaluatorMaxTokens: 4096,
  evaluatorTimeoutSeconds: 60,
  evaluatorMaxRetries: 1,
};

/** 类型损坏（非整数）回退默认；超界整数钳到最近边界 */
const clampInt = (v, min, max, dflt) => (Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : dflt);

/**
 * 解析 goal 段。
 * @param raw   cfg.goal 原值（损坏或缺失均可）
 * @param warn  (msg, extra) 启动告警通道
 * @returns 归一化配置（evaluator 为嵌套对象）
 */
export function parseGoalConfig(raw, { warn = () => {} } = {}) {
  const g = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const D = GOAL_CONFIG_DEFAULTS;
  // leaf：解析值与原值不同即告警（回退与钳制都发声）；undefined 原值不告警
  const leaf = (name, rawValue, parsed) => {
    if (rawValue !== undefined && rawValue !== parsed) {
      warn('goal 配置项损坏或超界，已回退/钳制', { leaf: name, value: rawValue, fallback: parsed });
    }
    return parsed;
  };

  // verification：显式合法值优先；否则按 evaluatorModel 推导；evaluator 缺模型名降级 none
  let verification = D.verification;
  if (g.verification !== undefined) {
    if (GOAL_VERIFICATIONS.includes(g.verification)) verification = g.verification;
    else leaf('verification', g.verification, D.verification);
  }
  const evaluatorModel = typeof g.evaluatorModel === 'string' ? g.evaluatorModel.trim().slice(0, 120) : '';
  if (evaluatorModel && verification === 'none') verification = 'evaluator';
  if (verification === 'evaluator' && !evaluatorModel) {
    // 无条件告警：缺模型名是配置疏漏（原值 undefined 时 leaf 不发声）
    warn('goal 配置项损坏或超界，已回退/钳制', { leaf: 'evaluatorModel', value: g.evaluatorModel, fallback: '（evaluator 验证降级为 none）' });
    verification = 'none';
  }

  const evidence = leaf('evidence', g.evidence, GOAL_EVIDENCE_MODES.includes(g.evidence) ? g.evidence : D.evidence);

  const graceSteps = leaf('graceSteps', g.graceSteps, clampInt(g.graceSteps, 0, 3, D.graceSteps));
  const mainTurns = leaf('mainTurns', g.mainTurns, clampInt(g.mainTurns, 0, 100000, D.mainTurns));
  const activeSeconds = leaf('activeSeconds', g.activeSeconds, clampInt(g.activeSeconds, 0, 10000000, D.activeSeconds));
  const repeatedReplyLimit = leaf('repeatedReplyLimit', g.repeatedReplyLimit, clampInt(g.repeatedReplyLimit, 2, 10, D.repeatedReplyLimit));
  const repeatedNotMetLimit = leaf('repeatedNotMetLimit', g.repeatedNotMetLimit, clampInt(g.repeatedNotMetLimit, 1, 10, D.repeatedNotMetLimit));

  const ev = g.evaluator && typeof g.evaluator === 'object' && !Array.isArray(g.evaluator) ? g.evaluator : {};
  const evaluatorMaxTokens = leaf('evaluator.maxTokens', ev.maxTokens, clampInt(ev.maxTokens, 256, 32768, D.evaluatorMaxTokens));
  const evaluatorTimeoutSeconds = leaf('evaluator.timeoutSeconds', ev.timeoutSeconds, clampInt(ev.timeoutSeconds, 5, 300, D.evaluatorTimeoutSeconds));
  const evaluatorMaxRetries = leaf('evaluator.maxRetries', ev.maxRetries, clampInt(ev.maxRetries, 0, 1, D.evaluatorMaxRetries));

  return {
    verification,
    evidence,
    graceSteps,
    mainTurns,
    activeSeconds,
    repeatedReplyLimit,
    repeatedNotMetLimit,
    evaluatorModel,
    evaluator: { maxTokens: evaluatorMaxTokens, timeoutSeconds: evaluatorTimeoutSeconds, maxRetries: evaluatorMaxRetries },
  };
}

/** budgetBreach 的限额入参（0 = 不限制） */
export function goalLimits(config) {
  return { graceSteps: config.graceSteps, mainTurns: config.mainTurns, activeSeconds: config.activeSeconds };
}
