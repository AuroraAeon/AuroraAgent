/** Agent 事件协议（与 util/agent/events.mjs 的 EVENT_TYPES 一一对应） */
export type ToolPhase = 'started' | 'params_partial' | 'confirmation_needed' | 'confirmed' | 'rejected' | 'completed' | 'failed';

export type AgentEvent =
  | { type: 'session_renamed'; sessionId: string; name: string; mode?: 'local' | 'model' }
  | { type: 'turn_started'; sessionId: string; turnId: string; turnIndex: number; userInput: string; model: string; provider: string; harness: string }
  | { type: 'model_round_started'; sessionId: string; turnId: string; round: number }
  | { type: 'text_chunk'; sessionId: string; turnId: string; text: string }
  | { type: 'thinking_chunk'; sessionId: string; turnId: string; text: string }
  | { type: 'tool_event'; sessionId: string; turnId: string; phase: ToolPhase; toolId: string; toolName: string; params?: unknown; resource?: string; requestId?: string; output?: string; durationMs?: number; extra?: unknown; subAgent?: boolean; subTask?: string; subSessionId?: string }
  | { type: 'plan_proposed'; sessionId: string; turnId: string; plan: string }
  | { type: 'plan_approved'; sessionId: string; turnId: string; plan: string }
  | { type: 'plan_rejected'; sessionId: string; turnId: string; plan: string }
  | { type: 'token_usage_updated'; sessionId: string; turnId: string; model: string; inputTokens: number; outputTokens: number; cost: number }
  | { type: 'context_compression_started'; sessionId: string; turnId: string; headRecords: number }
  | { type: 'context_compression_completed'; sessionId: string; turnId: string; keptRecords: number }
  | { type: 'context_compression_failed'; sessionId: string; turnId: string; error: string }
  | { type: 'goal_created'; sessionId: string; goal: GoalState }
  | { type: 'goal_status_changed'; sessionId: string; goal: GoalState; statusReason: string | null; lastVerification: GoalVerification | null }
  | { type: 'goal_usage_updated'; sessionId: string; goal: GoalState }
  | { type: 'goal_wait_changed'; sessionId: string; goal: GoalState; reason: string | null }
  | { type: 'goal_cleared'; sessionId: string }
  | { type: 'turn_completed'; sessionId: string; turnId: string; totalRounds: number; totalTools: number; durationMs: number; finishReason: string }
  | { type: 'turn_cancelled'; sessionId: string; turnId: string }
  | { type: 'turn_failed'; sessionId: string; turnId: string; error: string; round?: number };

export type Harness = { id: string; label: string; summary: string; tools: string[]; maxRounds: number };


/** 会话目标（与 util/agent/goal/types.mjs 六态状态机一一对应） */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'budget_limited' | 'usage_limited';
export type GoalVerification = { verdict: 'met' | 'not_met' | 'impossible' | 'unavailable' | 'inconclusive'; at: number; evidence: string; notMetStreak?: number; missing?: string[] };
export type GoalState = {
  goalId: string; sessionId: string; objective: string; status: GoalStatus;
  createdAt: number; updatedAt: number;
  tokensUsed: number; turnsUsed: number; timeUsedSeconds: number; tokenBudget: number | null;
  noProgressStreak: number; noToolStreak: number; replyFingerprint: string | null;
  lastVerification: GoalVerification | null; lastWorkerProposal: { status?: string; summary?: string; at?: number } | null;
  statusReason: string | null;
  executionWait: { reason: 'permission' | 'plan' | 'verification' | 'unknown'; sinceMs: number } | null;
};

/** 状态 / 等待中文文案（后端单一事实源的前端镜像，用于展示） */
export const GOAL_STATUS_LABELS: Record<GoalStatus, string> = {
  active: '进行中', paused: '已暂停', blocked: '受阻', complete: '已完成', budget_limited: '预算耗尽', usage_limited: '用量受限',
};
export const GOAL_WAIT_LABELS: Record<string, string> = {
  permission: '等待授权', plan: '等待计划批准', verification: '独立验证中', unknown: '等待中',
};
/** 用户面目标动作全集（与 util/agent/goal/actions.mjs 的 action 参数一致；clear 走独立路由） */
export type GoalUserAction = 'pause' | 'resume' | 'stop' | 'budget' | 'edit';
/** 与后端 canTransition 同语义的用户面可用动作（complete / budget_limited 不给恢复入口） */
export function goalActionsFor(status: GoalStatus): ('pause' | 'resume' | 'stop')[] {
  if (status === 'active') return ['pause', 'stop'];
  if (status === 'paused' || status === 'blocked' || status === 'usage_limited') return ['resume', 'stop'];
  return [];
}

export type SessionMeta = {
  id: string; name: string; model: string; provider: string; harness: string; workspace: string;
  createdAt: string; updatedAt: string; turns: number;
  rules: { action: string; resource: string; effect: string }[];
  todos?: TodoItem[];
  permissionMode?: string;
  planMode?: boolean;
  titleMode?: 'local' | 'model';
  inputTokens: number; outputTokens: number; cost: number; preview?: string;
};

export type SessionRecord = {
  at?: string;
  t: 'user' | 'assistant' | 'thinking' | 'tool_call' | 'tool_result' | 'summary' | 'usage';
  text?: string; id?: string; name?: string; args?: unknown; ok?: boolean; output?: string; extra?: unknown;
  inputTokens?: number; outputTokens?: number; cost?: number;
};

export type ModelInfo = { id: string; name?: string; tag?: string; provider: string; providerName?: string; contextWindow?: number; maxTokens?: number };

export type ProviderRow = {
  id: string; name: string; protocol: string; baseUrl: string; pathPrefix?: string;
  builtin: boolean; hasKey: boolean; model: string; models: ModelInfo[]; price?: { input?: number; output?: number };
};

export type SkillRow = { name: string; description: string; source: string };

export type McpServerRow = {
  id: string; name: string; transport: 'stdio' | 'http';
  enabled: boolean; connected: boolean; error: string; tools: number;
  serverInfo: { name?: string; version?: string } | null;
};

export type SettingsInfo = {
  ok: boolean; version: string; autostart: boolean; managed: boolean;
  serviceRunning: boolean; servicePid: number | null; port: number; dataDir: string;
};

/** 终端 TUI 偏好（服务端配置，终端启动时读取一次；解析形态见 util/tui/config.mjs） */
export type TuiConfig = {
  terminalTitle: string[];
  notifications: { when: string; method: string; events: string[] };
};
export type TuiSettings = {
  ok: boolean; tui: TuiConfig;
  options: {
    terminalTitleItems: string[]; defaultTerminalTitle: string[];
    notificationWhen: string[]; notificationMethods: string[]; notificationEvents: string[];
    defaultNotifications: { when: string; method: string; events: string[] };
  };
};

/** 历史投影：一条 assistant 视图 = 一个用户轮的产出，parts 按时间线交错文本与工具 */
export type TodoItem = { text: string; done: boolean };
export type DiffLine = { type: 'context' | 'add' | 'del' | 'meta'; lineNo: number; text: string };
export type SubAgentResult = { task: string; ok: boolean; text: string; sessionId: string; rounds: number; tools: number };
export type ToolExtra = { diff?: DiffLine[]; todos?: TodoItem[]; path?: string; children?: SubAgentResult[] };
export type ToolView = { id: string; name: string; params: unknown; phase: 'running' | 'ask' | 'rejected' | 'done' | 'failed'; output: string; requestId?: string; extra?: ToolExtra; subAgent?: boolean; subTask?: string };
/** 时间线片段：文本段与工具卡交错（历史投影与流式 turn 同形态，切齐两端渲染） */
export type MsgPart = { kind: 'text'; text: string } | ({ kind: 'tool' } & ToolView);
export type MsgView =
  | { kind: 'user'; key: string; text: string; at?: string }
  | { kind: 'assistant'; key: string; parts: MsgPart[]; thinking: string; usage: { inputTokens: number; outputTokens: number; cost: number } | null; at?: string }
  | { kind: 'system'; key: string; text: string }
  | { kind: 'notice'; key: string; text: string };

/** 进行中的 turn（流式渲染，与历史投影共用 parts 时间线与 ToolCard） */
export type PlanView = { text: string; decided: 'pending' | 'approved' | 'rejected' };
export type LiveTurn = {
  turnId: string; parts: MsgPart[]; thinking: string;
  usage: { inputTokens: number; outputTokens: number; cost: number } | null;
  compression: string | null;
  plan: PlanView | null;
  round: number; startedAt: number;
};
