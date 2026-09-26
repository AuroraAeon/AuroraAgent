/**
 * AuroraAgent 工作台根组件：会话 / 消息 / 流式 turn / 模型 / 模式 / 设置的状态编排。
 * 发送时乐观插入用户消息并挂上 live turn，事件经函数式 setState 增量更新，结束后按服务端转录重投影。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { Composer } from './components/Composer';
import { SettingsDialog } from './components/SettingsDialog';
import { projectRecords } from './projection';
import {
  abortTurn, createSession, deleteSession, getSession, getSettings, listHarnesses, listModels,
  listProviders, listSessions, patchSession, respondPermission, runTurn,
} from './api';
import type { AgentEvent, Harness, LiveTurn, ModelInfo, MsgView, ProviderRow, SessionMeta, SettingsInfo } from './types';
import { IconAlert, IconClose } from './icons';

/** 工具事件 → live turn 的工具卡片状态机 */
function applyToolEvent(live: LiveTurn, ev: Extract<AgentEvent, { type: 'tool_event' }>): LiveTurn {
  const tools = live.tools.slice();
  const idx = tools.findIndex((t) => t.id === ev.toolId);
  const upsert = (view: LiveTurn['tools'][number]) => {
    if (idx >= 0) tools[idx] = view;
    else tools.push(view);
  };
  switch (ev.phase) {
    case 'started':
      upsert({ id: ev.toolId, name: ev.toolName, params: ev.params, phase: 'running', output: '' });
      break;
    case 'params_partial':
      if (idx >= 0) tools[idx] = { ...tools[idx], params: ev.params };
      else upsert({ id: ev.toolId, name: ev.toolName, params: ev.params, phase: 'running', output: '' });
      break;
    case 'confirmation_needed':
      upsert({ id: ev.toolId, name: ev.toolName, params: ev.params, phase: 'ask', output: '', requestId: ev.requestId });
      break;
    case 'confirmed':
      if (idx >= 0) tools[idx] = { ...tools[idx], phase: 'running' };
      break;
    case 'rejected':
      if (idx >= 0) tools[idx] = { ...tools[idx], phase: 'rejected' };
      break;
    case 'completed':
      if (idx >= 0) tools[idx] = { ...tools[idx], phase: 'done', output: ev.output || '' };
      break;
    case 'failed':
      if (idx >= 0) tools[idx] = { ...tools[idx], phase: 'failed', output: ev.output || '' };
      break;
  }
  return { ...live, tools };
}

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MsgView[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelStatus, setModelStatus] = useState('idle');
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [thinking, setThinking] = useState(true);
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const booted = useRef(false);

  const current = sessions.find((s) => s.id === currentId) || null;

  const refreshModels = useCallback(async () => {
    setModelStatus('loading');
    try {
      const r = await listModels();
      setModels(r.models);
      setModelStatus(r.status || 'ready');
    } catch {
      setModelStatus('error');
    }
  }, []);

  const openSession = useCallback(async (id: string) => {
    setCurrentId(id);
    setError('');
    setLive(null);
    try {
      const got = await getSession(id);
      setMessages(projectRecords(got.records));
    } catch {
      setMessages([]);
    }
  }, []);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    (async () => {
      const [hs, pv, st] = await Promise.all([
        listHarnesses().catch(() => ({ harnesses: [] as Harness[], default: 'standard' })),
        listProviders().catch(() => ({ providers: [] as ProviderRow[], protocols: [] })),
        getSettings().catch(() => null),
      ]);
      setHarnesses(hs.harnesses);
      setProviders(pv.providers);
      setSettings(st);
      refreshModels();
      let list: SessionMeta[] = [];
      try { list = await listSessions(); } catch { /* 列表失败不阻塞：仍可新建 */ }
      setSessions(list);
      if (list.length) { openSession(list[0].id); return; }
      try {
        const s = await createSession({});
        setSessions([s]);
        openSession(s.id);
      } catch (e) {
        setError(`初始化会话失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })();
  }, [openSession, refreshModels]);

  const send = async (text: string) => {
    const cur = current;
    if (!cur || busy || !text.trim()) return;
    setBusy(true);
    setError('');
    setMessages((prev) => [...prev, { kind: 'user', key: `opt-${Date.now()}`, text }]);
    setLive({ turnId: '', text: '', thinking: '', tools: [], usage: null, compression: null });
    try {
      await runTurn(
        { sessionId: cur.id, input: text, thinking, model: cur.model, provider: cur.provider },
        (ev: AgentEvent) => {
          if (ev.type === 'text_chunk') setLive((l) => (l ? { ...l, text: l.text + ev.text } : l));
          else if (ev.type === 'thinking_chunk') setLive((l) => (l ? { ...l, thinking: l.thinking + ev.text } : l));
          else if (ev.type === 'tool_event') setLive((l) => (l ? applyToolEvent(l, ev) : l));
          else if (ev.type === 'token_usage_updated') {
            setLive((l) => (l ? {
              ...l,
              usage: {
                inputTokens: (l.usage?.inputTokens || 0) + ev.inputTokens,
                outputTokens: (l.usage?.outputTokens || 0) + ev.outputTokens,
                cost: Number(((l.usage?.cost || 0) + ev.cost).toFixed(6)),
              },
            } : l));
          } else if (ev.type === 'context_compression_started') setLive((l) => (l ? { ...l, compression: '正在折叠早期对话…' } : l));
          else if (ev.type === 'context_compression_completed') setLive((l) => (l ? { ...l, compression: `已折叠早期对话，保留近期 ${ev.keptRecords} 条记录` } : l));
          else if (ev.type === 'context_compression_failed') setLive((l) => (l ? { ...l, compression: null } : l));
          else if (ev.type === 'turn_failed') setError(ev.error || '任务失败');
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      try {
        const got = await getSession(cur.id);
        setMessages(projectRecords(got.records));
        setSessions(await listSessions());
      } catch { /* 刷新失败保留当前界面 */ }
      setBusy(false);
      setLive(null);
    }
  };

  const decide = async (requestId: string, decision: 'allow' | 'deny' | 'always') => {
    try {
      await respondPermission(requestId, decision);
    } catch (e) {
      setError(`权限回传失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // 乐观更新：服务端会随即推进并推送后续 tool_event 校正
    setLive((l) => (l ? {
      ...l,
      tools: l.tools.map((t) => (t.requestId === requestId ? { ...t, phase: decision === 'deny' ? 'rejected' : 'running' } : t)),
    } : l));
  };

  const stop = useCallback(async () => {
    if (!currentId) return;
    try { await abortTurn(currentId); } catch { /* 中断失败不阻塞界面，流结束自会收尾 */ }
  }, [currentId]);

  const newSession = async () => {
    try {
      const s = await createSession({ model: current?.model, harness: current?.harness });
      setSessions((prev) => [s, ...prev]);
      openSession(s.id);
    } catch (e) {
      setError(`新建会话失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const removeSession = async (id: string) => {
    try { await deleteSession(id); } catch { /* 继续本地移除 */ }
    let list: SessionMeta[] = [];
    try { list = await listSessions(); } catch { /* 忽略 */ }
    setSessions(list);
    if (id === currentId) {
      if (list.length) openSession(list[0].id);
      else newSession();
    }
  };

  const changeHarness = async (id: string) => {
    if (!current) return;
    try {
      const meta = await patchSession(current.id, { harness: id });
      setSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)));
    } catch (e) {
      setError(`切换模式失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const changeModel = async (m: ModelInfo) => {
    if (!current || busy) return;
    try {
      const meta = await patchSession(current.id, { model: m.id, provider: m.provider });
      setSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)));
    } catch (e) {
      setError(`切换模型失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const providersChanged = useCallback(async () => {
    const pv = await listProviders().catch(() => null);
    if (pv) setProviders(pv.providers);
    refreshModels();
  }, [refreshModels]);

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        currentId={currentId}
        onSelect={openSession}
        onNew={newSession}
        onDelete={removeSession}
        harnesses={harnesses}
        harness={current?.harness || 'standard'}
        onHarness={changeHarness}
        onOpenSettings={() => setSettingsOpen(true)}
        version={settings?.version || '4.0.0'}
      />
      <main className="main">
        {error ? (
          <div className="err-banner" role="alert">
            <IconAlert size={14} />
            <span>{error}</span>
            <button type="button" className="iconbtn" aria-label="关闭错误提示" onClick={() => setError('')}>
              <IconClose size={13} />
            </button>
          </div>
        ) : null}
        <ChatView
          messages={messages}
          live={live}
          hasSession={Boolean(current)}
          onDecide={decide}
          onPick={send}
        />
        <Composer
          busy={busy}
          onSend={send}
          onStop={stop}
          models={models}
          modelStatus={modelStatus}
          model={current?.model || ''}
          onModel={changeModel}
          providers={providers}
          thinking={thinking}
          onThinking={setThinking}
          harnesses={harnesses}
          harness={current?.harness || 'standard'}
          onHarness={changeHarness}
          disabled={!current}
        />
      </main>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onProvidersChanged={providersChanged}
      />
    </div>
  );
}
