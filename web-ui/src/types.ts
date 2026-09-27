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
  | { type: 'turn_completed'; sessionId: string; turnId: string; totalRounds: number; totalTools: number; durationMs: number; finishReason: string }
  | { type: 'turn_cancelled'; sessionId: string; turnId: string }
  | { type: 'turn_failed'; sessionId: string; turnId: string; error: string; round?: number };

export type Harness = { id: string; label: string; summary: string; tools: string[]; maxRounds: number };

export type SessionMeta = {
  id: string; name: string; model: string; provider: string; harness: string; workspace: string;
  createdAt: string; updatedAt: string; turns: number;
  rules: { action: string; resource: string; effect: string }[];
  todos?: TodoItem[];
  permissionMode?: string;
  planMode?: boolean;
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

/** 历史投影：一条 assistant 视图可带思考、工具列表与用量脚注 */
export type TodoItem = { text: string; done: boolean };
export type DiffLine = { type: 'context' | 'add' | 'del' | 'meta'; lineNo: number; text: string };
export type SubAgentResult = { task: string; ok: boolean; text: string; sessionId: string; rounds: number; tools: number };
export type ToolExtra = { diff?: DiffLine[]; todos?: TodoItem[]; path?: string; children?: SubAgentResult[] };
export type ToolView = { id: string; name: string; params: unknown; phase: 'running' | 'ask' | 'rejected' | 'done' | 'failed'; output: string; requestId?: string; extra?: ToolExtra; subAgent?: boolean; subTask?: string };
export type MsgView =
  | { kind: 'user'; key: string; text: string; at?: string }
  | { kind: 'assistant'; key: string; text: string; thinking: string; tools: ToolView[]; usage: { inputTokens: number; outputTokens: number; cost: number } | null; at?: string }
  | { kind: 'system'; key: string; text: string };

/** 进行中的 turn（流式渲染，与历史投影共用 ToolCard） */
export type PlanView = { text: string; decided: 'pending' | 'approved' | 'rejected' };
export type LiveTurn = {
  turnId: string; text: string; thinking: string; tools: ToolView[];
  usage: { inputTokens: number; outputTokens: number; cost: number } | null;
  compression: string | null;
  plan: PlanView | null;
  round: number; startedAt: number;
};
