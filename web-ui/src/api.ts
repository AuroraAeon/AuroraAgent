/** API 客户端：全部走 web.mjs 的同源 /api/*；turn 用 fetch 读 SSE（EventSource 不支持 POST） */
import type { AgentEvent, GoalState, Harness, McpServerRow, ModelInfo, ProviderRow, SessionMeta, SessionRecord, SettingsInfo, SkillRow, TuiSettings } from './types';

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((j as { error?: { message?: string } }).error?.message || `HTTP ${resp.status}`);
  return j as T;
}

export const listSessions = () => api<{ sessions: SessionMeta[] }>('/api/agent/sessions').then((r) => r.sessions);
export const createSession = (body: { name?: string; model?: string; harness?: string; workspace?: string }) =>
  api<{ session: SessionMeta }>('/api/agent/sessions', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.session);
export const getSession = (id: string) => api<{ meta: SessionMeta; records: SessionRecord[] }>(`/api/agent/sessions/${id}`);
export const deleteSession = (id: string) => api<{ deleted: boolean }>(`/api/agent/sessions/${id}`, { method: 'DELETE' });
export const patchSession = (id: string, body: { harness?: string; name?: string; model?: string; provider?: string; permissionMode?: string; planMode?: boolean; titleMode?: string }) =>
  api<{ meta: SessionMeta }>(`/api/agent/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(body) }).then((r) => r.meta);
export const forkSession = (id: string) =>
  api<{ session: SessionMeta }>(`/api/agent/sessions/${id}/fork`, { method: 'POST' }).then((r) => r.session);
export const listSkills = () => api<{ skills: SkillRow[] }>('/api/agent/skills').then((r) => r.skills);
export const listHarnesses = () => api<{ harnesses: Harness[]; default: string }>('/api/agent/harnesses');
export const listModels = () => api<{ models: ModelInfo[]; status: string }>('/api/models');
export const getSettings = () => api<SettingsInfo>('/api/settings');
export const setAutostart = (autostart: boolean) => api<{ ok: boolean }>('/api/settings', { method: 'POST', body: JSON.stringify({ autostart }) });
export const getAgentProxy = () => api<{ ok: boolean; agentProxy: string }>('/api/settings/proxy');
export const setAgentProxy = (agentProxy: string) =>
  api<{ ok: boolean; agentProxy: string }>('/api/settings/proxy', { method: 'POST', body: JSON.stringify({ agentProxy }) });
export const getTuiSettings = () => api<TuiSettings>('/api/settings/tui');
export const saveTuiSettings = (body: { terminalTitle?: string[]; notifications?: { when?: string; method?: string; events?: string[] } }) =>
  api<{ ok: boolean; tui: TuiSettings['tui'] }>('/api/settings/tui', { method: 'POST', body: JSON.stringify(body) });
export const listProviders = () => api<{ ok: boolean; protocols: { id: string; label: string }[]; providers: ProviderRow[] }>('/api/providers');
export const createProvider = (draft: unknown) => api<{ ok: boolean; provider: ProviderRow; providers: ProviderRow[] }>('/api/providers', { method: 'POST', body: JSON.stringify(draft) });
export const updateProvider = (id: string, draft: unknown) => api<{ ok: boolean; provider: ProviderRow; providers: ProviderRow[] }>(`/api/providers/${id}`, { method: 'PUT', body: JSON.stringify(draft) });
export const deleteProvider = (id: string) => api<{ ok: boolean; providers: ProviderRow[] }>(`/api/providers/${id}`, { method: 'DELETE' });
export const discoverModels = (draft: { baseUrl: string; protocol: string; apiKey?: string; pathPrefix?: string }) =>
  api<{ ok: boolean; url: string; models: { id: string; name?: string; contextWindow?: number; maxTokens?: number }[] }>('/api/providers/discover', { method: 'POST', body: JSON.stringify(draft) });
export const listMcpServers = () => api<{ servers: McpServerRow[] }>('/api/mcp/servers').then((r) => r.servers);
export const createMcpServer = (draft: { id: string; name?: string; transport: string; command?: string; args?: string[]; url?: string }) =>
  api<{ ok: boolean; server: McpServerRow; servers: McpServerRow[] }>('/api/mcp/servers', { method: 'POST', body: JSON.stringify(draft) });
export const deleteMcpServer = (id: string) => api<{ ok: boolean; removed: number; servers: McpServerRow[] }>(`/api/mcp/servers/${id}`, { method: 'DELETE' });
export const probeMcpServer = (id: string) => api<{ ok: boolean; serverInfo?: unknown; tools?: string[]; error?: string }>(`/api/mcp/servers/${id}/probe`, { method: 'POST' });
export const respondPermission = (requestId: string, decision: 'allow' | 'deny' | 'always') =>
  api<{ ok: boolean }>('/api/agent/permission', { method: 'POST', body: JSON.stringify({ requestId, decision }) });
export const respondPlan = (sessionId: string, decision: 'approve' | 'reject') =>
  api<{ ok: boolean }>('/api/agent/plan', { method: 'POST', body: JSON.stringify({ sessionId, decision }) });
export const abortTurn = (sessionId: string) => api<{ aborted: boolean }>('/api/agent/abort', { method: 'POST', body: JSON.stringify({ sessionId }) });
export const getGoal = (sessionId: string) => api<{ goal: GoalState | null }>(`/api/agent/goal/${sessionId}`);
export const searchFiles = (sessionId: string, q: string) =>
  api<{ files: string[] }>(`/api/files/search?sessionId=${encodeURIComponent(sessionId)}&q=${encodeURIComponent(q)}`);
export const goalAction = (sessionId: string, action: 'pause' | 'resume' | 'stop') =>
  api<{ goal: GoalState }>(`/api/agent/goal/${action}`, { method: 'POST', body: JSON.stringify({ sessionId }) });

/** 跑一个 turn：逐事件回调，流结束即 resolve */
export async function runTurn(body: { sessionId: string; input: string; thinking?: boolean; model?: string; provider?: string }, onEvent: (ev: AgentEvent) => void): Promise<void> {
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
