/**
 * Goal 工具定义（名字与 schema 对齐 codex / minimax-code：create_goal / update_goal / get_goal，
 * 模型对这套工具有先验，零学习成本）。schema 刻意最小：无 metadata、不经 update_goal 改目标文本。
 *
 * update_goal 有两个刻意分开的模式：
 *   - status：宿主结算的终态提案（complete / blocked + 可选 summary）
 *   - token_budget：仅用户显式要求时的预算变更，必须带新鲜 get_goal 快照的期望纪元
 * create_goal 的可选 token_budget 在 tokensUsed >= 预算时由运行时自动迁到 budget_limited。
 */

/** create_goal：仅在用户或系统/开发者指令明确要求时创建，不从普通任务里推断目标 */
export const CREATE_GOAL_DEF = {
  name: 'create_goal',
  description:
    'Create a goal only when explicitly requested by the user or system/developer instructions; do not infer goals from ordinary tasks. '
    + 'Fails if an unfinished goal exists; use update_goal for terminal proposals or an explicitly requested token-budget change.',
  parameters: {
    type: 'object',
    properties: {
      objective: {
        type: 'string',
        description: 'Required. The concrete objective to start pursuing. This starts a new active goal when no goal exists or replaces the current goal when it is complete.',
      },
      token_budget: {
        type: 'integer',
        minimum: 1,
        description:
          'Optional positive token budget for the goal. Omit unless the user explicitly asked for a cap. '
          + 'When set, the runtime automatically marks the goal as budget_limited and stops auto-continuation the moment cumulative model tokens reach this value.',
      },
    },
    required: ['objective'],
  },
};

/** update_goal：一次调用只做一个操作，另一模式的字段一律忽略 */
export const UPDATE_GOAL_DEF = {
  name: 'update_goal',
  description:
    'Propose a terminal status for the existing goal, or—only when explicitly requested by the user—update its token budget. '
    + 'Always set `mode` to choose exactly one operation per call; fields belonging to the other mode are ignored.\n'
    + 'Terminal mode (`mode: "status"`): pass `status` and optional `summary`; follow the rules documented on the `status` field. The host settles the proposal after this turn, and an accepted proposal ends the turn.\n'
    + 'Budget mode (`mode: "token_budget"`): call `get_goal` immediately before `update_goal`, then pass only `token_budget`, `expected_goal_id`, and `expected_updated_at`. Use a positive integer token count, or `null` to clear the cap. A successful update does not end the turn and may reactivate a token-limited goal.\n'
    + 'Do not combine the two modes. This tool cannot directly pause, resume, or edit the objective.',
  parameters: {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['status', 'token_budget'],
        description:
          'Which single operation this call performs. Always set this field. '
          + '`status`: propose a terminal status; every field other than `status` and `summary` is ignored. '
          + '`token_budget`: update the token budget; every field other than `token_budget`, `expected_goal_id`, and `expected_updated_at` is ignored.',
      },
      status: {
        type: 'string',
        enum: ['complete', 'blocked'],
        description:
          'Terminal mode only. Set to `complete` only when the objective is achieved and no required work remains. '
          + "When all executable work is finished and only a passive wait for the user's next arbitrary message remains, treat the wait as a stop condition and set `complete`. "
          + 'An explicit safety or policy refusal may be set to `blocked` immediately and does not require the three-turn threshold. '
          + 'For every other blocker, set to `blocked` only after the same blocking condition has recurred for at least three consecutive goal turns and the agent is at an impasse.',
      },
      summary: {
        type: 'string',
        maxLength: 2000,
        description:
          'Recommended when status is `complete`: briefly state what was accomplished and where the evidence lives. The host passes this claim to an independent verifier as untrusted data.',
      },
      token_budget: {
        type: ['integer', 'null'],
        minimum: 1,
        description:
          'Budget mode only. New positive integer token cap. Convert the explicit user request to an integer before calling; use null to clear the cap.',
      },
      expected_goal_id: {
        type: 'string',
        minLength: 1,
        description: 'Budget mode only. Exact goalId returned by the immediately preceding get_goal call.',
      },
      expected_updated_at: {
        type: 'integer',
        minimum: 0,
        description: 'Budget mode only. Exact updatedAt returned by the immediately preceding get_goal call.',
      },
    },
  },
};

/** get_goal：读当前目标（状态 / 时间戳 / 用量 / 预算），无目标返回空结果 */
export const GET_GOAL_DEF = {
  name: 'get_goal',
  description:
    'Get the current goal for this thread, including status, timestamps, token usage, and token budget. Returns an empty result if no goal is set.',
  parameters: { type: 'object', properties: {} },
};

export const GOAL_TOOL_NAMES = ['create_goal', 'update_goal', 'get_goal'];

/**
 * 载荷是否意图走「持久 token 预算」模式（语义与 MiniMax tool-defs.ts 字节级一致）。
 * 部分提供方的工具调用适配器会把省略的可空字段物化成 null：豁免仅限「终态提案在场」——
 * 那种兼容填充不能把 complete / blocked 提案变成预算变更；数字预算与 status 同现则是
 * 真实的（且非法的）混合模式。孤立 null（无 status 在场）是明确的清预算意图，交由
 * 纪元校验要求新鲜 get_goal 快照（缺快照返回纠正性错误，与 MiniMax 同路径）。
 */
export function hasUpdateGoalTokenBudgetIntent(input) {
  const raw = input || {};
  if (!Object.hasOwn(raw, 'token_budget')) return false;
  return raw.status === undefined || raw.token_budget !== null;
}

export function resolveUpdateGoalMode(input) {
  const raw = input || {};
  if (raw.mode === 'status') return 'status';
  if (raw.mode === 'token_budget') return 'token_budget';
  const hasBudget = hasUpdateGoalTokenBudgetIntent(raw);
  const hasStatus = raw.status !== undefined;
  if (hasBudget && hasStatus) return 'mixed';
  if (hasBudget) return 'token_budget';
  if (hasStatus) return 'status';
  return 'none';
}
