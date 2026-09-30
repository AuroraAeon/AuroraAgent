/** API 客户端：全部走 web.mjs 的同源 /api/*；turn 用 fetch 读 SSE（EventSource 不支持 POST） */
import {
  normalizeCatalogProviders, normalizeDiscoveredModels, normalizeErrorLogPage, normalizeFailoverQueue, normalizeFailoverSettings,
  normalizeFileSearch, normalizeHarnesses, normalizeHealthRows, normalizeJobList, normalizeJobRows, normalizeModels, normalizeMcpServers, normalizeProviderList,
  normalizeProviderRows, normalizeQueueItems, normalizeSessionDetail, normalizeSessionMetaResult, normalizeSessionResult,
  normalizeSessions, normalizeSettingsInfo, normalizeSideSession, normalizeTuiSaveResult, normalizeTuiSettings,
  normalizeUsageSummary,
} from './api-shapes.mjs';
import { normalizeSkillRows } from './skill-rows.mjs';
import type { AgentEvent, CatalogProvider, ErrorLogEntry, FailoverQueue, FailoverSettings, GoalState, HookRow, UpdateInfo, Harness, JobItem, McpServerRow, ModelInfo, ProviderRow, QueueItem, SessionMeta, SessionRecord, SettingsInfo, SkillRow, TuiSettings, UsageSummary, WorkspaceInfo } from './types';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((j as { error?: { message?: string } }).error?.message || `HTTP ${resp.status}`);
  return j as T;
}

export const listSessions = () => api<{ sessions: SessionMeta[] }>('/api/agent/sessions').then(normalizeSessions);
export const createSession = (body: { name?: string; model?: string; harness?: string; workspace?: string }) =>
  api<{ session: SessionMeta }>('/api/agent/sessions', { method: 'POST', body: JSON.stringify(body) }).then(normalizeSessionResult).then((r) => r.session);
export const getSession = (id: string) => api<{ meta: SessionMeta; records: SessionRecord[] }>(`/api/agent/sessions/${id}`).then(normalizeSessionDetail);
export const deleteSession = (id: string) => api<{ deleted: boolean }>(`/api/agent/sessions/${id}`, { method: 'DELETE' });
export const patchSession = (id: string, body: { harness?: string; name?: string; model?: string; provider?: string; permissionMode?: string; planMode?: boolean; titleMode?: string; thinking?: boolean }) =>
  api<{ meta: SessionMeta }>(`/api/agent/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }).then(normalizeSessionMetaResult).then((r) => r.meta);
export const forkSession = (id: string) =>
  api<{ session: SessionMeta }>(`/api/agent/sessions/${id}/fork`, { method: 'POST' }).then(normalizeSessionResult).then((r) => r.session);
/** 用量汇总；默认带统计视图（近 30 天走势与构成），lite=1 只要汇总与最近记录 */
export const getUsage = (lite = false) => api<UsageSummary>(`/api/usage${lite ? '?lite=1' : ''}`).then(normalizeUsageSummary);
/** 版本更新检查（默认走 6 小时缓存；force=1 强制重查 GitHub Releases） */
export const checkUpdate = (force = false) => api<UpdateInfo>(`/api/update/check${force ? '?force=1' : ''}`);
export const getWorkspace = (path: string) => api<WorkspaceInfo>(`/api/workspace?path=${encodeURIComponent(path)}`);
/** 错误日志：查看最近 N 条 / 清空 */
export const listErrorLogs = (limit = 50) => api<{ ok: boolean; entries: ErrorLogEntry[]; total: number }>(`/api/logs/errors?limit=${limit}`).then(normalizeErrorLogPage);
export const clearErrorLogs = () => api<{ ok: boolean; cleared: number }>('/api/logs/errors', { method: 'DELETE' });
export const reportErrorLog = (body: { kind: string; message: string; detail?: string }) =>
  api<{ ok: boolean; deduped?: boolean }>('/api/logs/errors', { method: 'POST', body: JSON.stringify(body) });
// 响应形状可能在版本错配（后端进程旧于前端产物）或字段演进中漂移：边界归一化，缺字段走安全默认值
export const listSkills = () => api<{ skills: SkillRow[] }>('/api/agent/skills').then((r) => normalizeSkillRows(r.skills));
/** 提供方预设目录（只读；数据见 util/provider-catalog.mjs，协议门控在后端） */
export const getProviderCatalog = () => api<{ providers: CatalogProvider[] }>('/api/providers/catalog').then((r) => normalizeCatalogProviders(r.providers));
export const listHarnesses = () => api<{ harnesses: Harness[]; default: string }>('/api/agent/harnesses').then(normalizeHarnesses);
export const listModels = () => api<{ models: ModelInfo[]; status: string }>('/api/models').then(normalizeModels);
export const getSettings = () => api<SettingsInfo>('/api/settings').then(normalizeSettingsInfo);
export const setAutostart = (autostart: boolean) => api<{ ok: boolean }>('/api/settings', { method: 'POST', body: JSON.stringify({ autostart }) });
export const getAgentProxy = () => api<{ ok: boolean; agentProxy: string }>('/api/settings/proxy');
export const setAgentProxy = (agentProxy: string) =>
  api<{ ok: boolean; agentProxy: string }>('/api/settings/proxy', { method: 'POST', body: JSON.stringify({ agentProxy }) });
/** 生成参数（全局）：温度与单次最大输出；改后下一轮模型请求即时生效 */
export const getGeneration = () => api<{ ok: boolean; temperature: number; maxTokens: number }>('/api/settings/generation');
export const saveGeneration = (body: { temperature?: number; maxTokens?: number }) =>
  api<{ ok: boolean; temperature: number; maxTokens: number }>('/api/settings/generation', { method: 'POST', body: JSON.stringify(body) });
/** API Key：GET 只回 hasKey（永不回传 Key 本身）；POST 写入并持久化到本机配置 */
export const getKeyState = () => api<{ ok: boolean; hasKey: boolean }>('/api/settings/key');
export const saveApiKey = (apiKey: string) =>
  api<{ ok: boolean; hasKey: boolean }>('/api/settings/key', { method: 'POST', body: JSON.stringify({ apiKey }) });
/** 故障转移设置 + 熔断健康视图 + 当前队列（设置页「故障转移」面板一次拉全） */
export const getFailoverSettings = () => api<FailoverSettings>('/api/settings/failover').then(normalizeFailoverSettings);
export const saveFailoverSettings = (body: {
  providerFailover?: boolean; providerFailoverMaxAttempts?: number;
  failover?: { firstByteMs?: number; idleMs?: number; nonStreamMs?: number; prefTtlHours?: number; circuit?: Record<string, number> };
}) => api<FailoverSettings>('/api/settings/failover', { method: 'POST', body: JSON.stringify(body) }).then(normalizeFailoverSettings);
/** 手动恢复：providerId 缺省重置全部熔断器并清空热切换偏好 */
export const resetFailoverState = (providerId?: string) =>
  api<{ ok: boolean; health: FailoverSettings['health'] }>('/api/settings/failover/reset', { method: 'POST', body: JSON.stringify(providerId ? { providerId } : {}) })
    .then((r) => ({ ...r, health: normalizeHealthRows(r.health) }));
/** 故障转移队列（用户编排的优先级）：读队列 + 提供方列表 */
export const getFailoverQueue = () => api<FailoverQueue>('/api/providers/failover-queue').then(normalizeFailoverQueue);
/** 写队列：整队列替换（queue）/ 追加（add）/ 移除（remove）/ 上移下移（move.delta） */
export const saveFailoverQueue = (body: { queue?: string[]; add?: string; remove?: string; move?: { id: string; delta: number } }) =>
  api<FailoverQueue>('/api/providers/failover-queue', { method: 'POST', body: JSON.stringify(body) }).then(normalizeFailoverQueue);
export const getTuiSettings = () => api<TuiSettings>('/api/settings/tui').then(normalizeTuiSettings);
export const saveTuiSettings = (body: { terminalTitle?: string[]; notifications?: { when?: string; method?: string; events?: string[] } }) =>
  api<{ ok: boolean; tui: TuiSettings['tui'] }>('/api/settings/tui', { method: 'POST', body: JSON.stringify(body) }).then(normalizeTuiSaveResult);
export const listProviders = () => api<{ ok: boolean; protocols: { id: string; label: string }[]; providers: ProviderRow[] }>('/api/providers').then(normalizeProviderList);
export const createProvider = (draft: unknown) => api<{ ok: boolean; provider: ProviderRow; providers: ProviderRow[] }>('/api/providers', { method: 'POST', body: JSON.stringify(draft) }).then((r) => ({ ...r, providers: normalizeProviderRows(r.providers) }));
export const updateProvider = (id: string, draft: unknown) => api<{ ok: boolean; provider: ProviderRow; providers: ProviderRow[] }>(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify(draft) }).then((r) => ({ ...r, providers: normalizeProviderRows(r.providers) }));
export const deleteProvider = (id: string) => api<{ ok: boolean; providers: ProviderRow[] }>(`/api/providers/${id}`, { method: 'DELETE' }).then((r) => ({ ...r, providers: normalizeProviderRows(r.providers) }));
export const discoverModels = (draft: { baseUrl: string; protocol: string; apiKey?: string; pathPrefix?: string }) =>
  api<{ ok: boolean; url: string; models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[] }>('/api/providers/discover', { method: 'POST', body: JSON.stringify(draft) }).then(normalizeDiscoveredModels);
export const listMcpServers = () => api<{ servers: McpServerRow[] }>('/api/mcp/servers').then(normalizeMcpServers);
export const listHooks = (workspace?: string) =>
  api<{ enabled: boolean; hooks: HookRow[]; events: string[] }>(`/api/agent/hooks${workspace ? `?workspace=${encodeURIComponent(workspace)}` : ''}`);
export const createMcpServer = (draft: { id: string; name?: string; transport: string; command?: string; args?: string[]; url?: string }) =>
  api<{ ok: boolean; server: McpServerRow; servers: McpServerRow[] }>('/api/mcp/servers', { method: 'POST', body: JSON.stringify(draft) });
export const deleteMcpServer = (id: string) => api<{ ok: boolean; removed: number; servers: McpServerRow[] }>(`/api/mcp/servers/${id}`, { method: 'DELETE' });
export const probeMcpServer = (id: string) => api<{ ok: boolean; serverInfo?: unknown; tools?: string[]; error?: string }>(`/api/mcp/servers/${id}/probe`, { method: 'POST' });
export const setMcpServerEnabled = (id: string, enabled: boolean) =>
  api<{ ok: boolean; server: McpServerRow; servers: McpServerRow[] }>(`/api/mcp/servers/${id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) });
export const respondPermission = (requestId: string, decision: 'allow' | 'deny' | 'always') =>
  api<{ ok: boolean }>('/api/agent/permission', { method: 'POST', body: JSON.stringify({ requestId, decision }) });
export const respondPlan = (sessionId: string, decision: 'approve' | 'reject') =>
  api<{ ok: boolean }>('/api/agent/plan', { method: 'POST', body: JSON.stringify({ sessionId, decision }) });
export const abortTurn = (sessionId: string) => api<{ aborted: boolean }>('/api/agent/abort', { method: 'POST', body: JSON.stringify({ sessionId }) });
/** 侧边对话（/btw）：按主会话 id 查转录 / 丢弃 */
export const getSideSession = (id: string) => api<{ records: SessionRecord[] }>(`/api/agent/side/${id}`).then(normalizeSideSession);
export const discardSide = (sessionId: string) =>
  api<{ ok: boolean; discarded: boolean }>('/api/agent/side/discard', { method: 'POST', body: JSON.stringify({ sessionId }) });
export const getGoal = (sessionId: string) => api<{ goal: GoalState | null }>(`/api/agent/goal/${sessionId}`);
export const searchFiles = (sessionId: string, q: string) =>
  api<{ files: string[] }>(`/api/files/search?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(q)}`).then(normalizeFileSearch);
/** 设立目标（未完成目标存在时服务端 409 GOAL_STATUS_CONFLICT，由调用方先选 edit） */
export const createGoal = (sessionId: string, objective: string, tokenBudget?: number | null) =>
  api<{ goal: GoalState }>('/api/agent/goal', {
    method: 'POST',
    body: JSON.stringify({ sessionId, objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) }),
  });
/**
 * 改写未完成目标的目标文本（空白 400 GOAL_BAD_OBJECTIVE / 已完成 409）。
 * 随文携带 tokenBudget 时一并改预算（epoch 不符 409 GOAL_STALE，与 budget 路由同规约）。
 */
export const editGoal = (sessionId: string, objective: string, tokenBudget?: number | null, epoch?: { expectedGoalId: string; expectedUpdatedAt: number }) =>
  api<{ goal: GoalState }>('/api/agent/goal/edit', {
    method: 'POST',
    body: JSON.stringify({
      sessionId, objective,
      ...(tokenBudget === undefined ? {} : { tokenBudget }),
      ...(epoch || {}),
    }),
  });
/** 移除目标（幂等：没有目标也回 200，cleared=false） */
export const clearGoal = (sessionId: string) =>
  api<{ cleared: boolean }>('/api/agent/goal/clear', { method: 'POST', body: JSON.stringify({ sessionId }) });
/** 用户面目标动作；budget 需带新鲜快照的 expectedGoalId + expectedUpdatedAt（纪元不符 409 GOAL_STALE） */
export const goalAction = (sessionId: string, action: 'pause' | 'resume' | 'stop' | 'budget' | 'edit', extra: {
  tokenBudget?: number | null; expectedGoalId?: string; expectedUpdatedAt?: number; objective?: string;
} = {}) =>
  api<{ goal: GoalState }>(`/api/agent/goal/${action}`, { method: 'POST', body: JSON.stringify({ sessionId, ...extra }) });

/** 定时任务（util/jobs/*，本地化 #3149）：列表 / 新建 / 删除 / 立即跑 / 启停开关 */
export const listJobs = () => api<{ jobs: JobItem[] }>('/api/jobs').then((r) => normalizeJobList(r).jobs);
export const createJob = (body: { name: string; sessionId: string; prompt: string; schedule: JobItem['schedule']; enabled?: boolean }) =>
  api<{ job: JobItem }>('/api/jobs', { method: 'POST', body: JSON.stringify(body) }).then((r) => normalizeJobRows([r.job])[0]);
export const deleteJob = (id: string) => api<{ removed: boolean }>(`/api/jobs/${id}`, { method: 'DELETE' });
export const runJobNow = (id: string) => api<{ ok: boolean }>(`/api/jobs/${id}/run`, { method: 'POST' });
export const toggleJob = (id: string, enabled: boolean) =>
  api<{ job: JobItem }>(`/api/jobs/${id}/toggle`, { method: 'POST', body: JSON.stringify({ enabled }) }).then((r) => normalizeJobRows([r.job])[0]);

export const getAgentQueue = (sessionId: string) =>
  api<{ sessionId: string; items: QueueItem[] }>(`/api/agent/queue/${sessionId}`).then((r) => ({ sessionId: String(r.sessionId || ''), items: normalizeQueueItems(r.items) }));
export const promoteQueueItem = (sessionId: string, opId: string) =>
  api<{ ok: boolean }>('/api/agent/queue/promote', { method: 'POST', body: JSON.stringify({ sessionId, opId }) });
export const removeQueueItem = (sessionId: string, opId: string) =>
  api<{ ok: boolean }>('/api/agent/queue/remove', { method: 'POST', body: JSON.stringify({ sessionId, opId }) });
/** 跑一个 turn：逐事件回调，流结束即 resolve */
export async function runTurn(body: { sessionId: string; input: string; opId?: string; thinking?: boolean; model?: string; provider?: string; side?: boolean }, onEvent: (ev: AgentEvent) => void): Promise<void> {
  const resp = await fetch('/api/agent/turn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok || !resp.body) {
    const j = await resp.json().catch(() => ({}));
    throw new Error((j as { error?: { message?: string } }).error?.message || `HTTP ${resp.status}`);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const m = /^event: (.+)\ndata: (.*)$/s.exec(raw);
      if (!m) continue;
      try { onEvent(JSON.parse(m[2]) as AgentEvent); } catch { /* 坏帧跳过 */ }
    }
  }
}
