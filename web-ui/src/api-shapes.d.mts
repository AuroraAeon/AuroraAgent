/** api-shapes.mjs 的类型声明（实现是零依赖纯函数，Node 测试直接 import 同一份）。 */
import type {
  CatalogProvider, CircuitHealth, ErrorLogEntry, FailoverQueue, FailoverSettings, Harness, McpServerRow,
  JobItem, ModelInfo, ProviderRow, QueueItem, SessionMeta, SessionRecord, SettingsInfo, TuiSettings, UsageSummary,
} from './types';

/** 模型目录行（ModelInfo） */
export declare function normalizeModelRows(raw: unknown): ModelInfo[];

/** 提供方行（ProviderRow） */
export declare function normalizeProviderRows(raw: unknown): ProviderRow[];
export declare function normalizeCatalogProviders(raw: unknown): CatalogProvider[];

/** 消息队列行（QueueItem） */
export declare function normalizeQueueItems(raw: unknown): QueueItem[];

/** 会话行（SessionMeta） */
export declare function normalizeSessionRows(raw: unknown): SessionMeta[];

/** 会话列表：GET /api/agent/sessions */
export declare function normalizeSessions(raw: unknown): SessionMeta[];

/** 会话详情：GET /api/agent/sessions/:id */
export declare function normalizeSessionDetail(raw: unknown): { meta: SessionMeta; records: SessionRecord[] };

/** 创建 / 查会话回包：{ session } */
export declare function normalizeSessionResult(raw: unknown): { session: SessionMeta };

/** 改会话回包：{ meta } */
export declare function normalizeSessionMetaResult(raw: unknown): { meta: SessionMeta };

/** 侧边对话转录：GET /api/agent/side/:id */
export declare function normalizeSideSession(raw: unknown): { records: SessionRecord[] };

/** 模型目录：GET /api/models */
export declare function normalizeModels(raw: unknown): { models: ModelInfo[]; status: string };

/** 模式列表：GET /api/agent/harnesses */
export declare function normalizeHarnesses(raw: unknown): { harnesses: Harness[]; default: string };

/** 用量汇总：GET /api/usage */
export declare function normalizeUsageSummary(raw: unknown): UsageSummary;

/** 错误日志：GET /api/logs/errors */
export declare function normalizeErrorLogPage(raw: unknown): { ok: boolean; entries: ErrorLogEntry[]; total: number };

/** MCP 服务器列表：GET /api/mcp/servers */
export declare function normalizeMcpServers(raw: unknown): McpServerRow[];

/** 熔断健康行（CircuitHealth） */
export declare function normalizeHealthRows(raw: unknown): CircuitHealth[];

/** 故障转移设置：GET/POST /api/settings/failover */
export declare function normalizeFailoverSettings(raw: unknown): FailoverSettings;

/** 提供方列表：GET /api/providers */
export declare function normalizeProviderList(raw: unknown): { ok: boolean; protocols: { id: string; label: string }[]; providers: ProviderRow[] };

/** 故障转移队列：GET/POST /api/providers/failover-queue */
export declare function normalizeFailoverQueue(raw: unknown): FailoverQueue;

/** 终端偏好：GET /api/settings/tui */
export declare function normalizeTuiSettings(raw: unknown): TuiSettings;

/** 保存终端偏好回包：{ ok, tui } */
export declare function normalizeTuiSaveResult(raw: unknown): { ok: boolean; tui: TuiSettings['tui'] };

/** 定时任务行（JobItem） */
export declare function normalizeJobRows(raw: unknown): JobItem[];

/** 任务列表回包：GET /api/jobs */
export declare function normalizeJobList(raw: unknown): { jobs: JobItem[] };

/** 文件搜索：GET /api/files/search */
export declare function normalizeFileSearch(raw: unknown): { files: string[] };

/** 模型发现：POST /api/providers/discover */
export declare function normalizeDiscoveredModels(raw: unknown): { ok: boolean; url: string; models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[] };

/** 服务状态：GET /api/settings */
export declare function normalizeSettingsInfo(raw: unknown): SettingsInfo;
