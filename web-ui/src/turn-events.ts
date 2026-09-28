/**
 * turn SSE 事件 → 界面状态：主对话与侧边对话（/btw）共用同一套投影规则。
 * 从 App.tsx 抽出，避免两条对话通道各抄一份事件状态机（抄两份必然漂移）。
 * scope=main 额外处理会话改名 / goal 横幅投影 / 侧栏会话列表刷新；side 一律不碰这些
 * （侧边会话不落盘、不改主会话标题、不接管 goal）。
 */
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { projectRecords } from './projection';
import { getSession, getSideSession } from './api';
import { browserNotifyEnabled } from './components/TuiPanel';
import { PROVIDER_SWITCH_REASONS } from './types';
import type { AgentEvent, GoalState, LiveTurn, MsgPart, MsgView, PlanView, SessionMeta, TodoItem } from './types';

/** 文本增量 → 追加到 parts 的最后一个文本片段（工具之后的新文本开新片段，保住时间线） */
export function appendTextPart(live: LiveTurn, text: string): LiveTurn {
  const parts = live.parts.slice();
  const last = parts[parts.length - 1];
  if (last && last.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + text };
  else parts.push({ kind: 'text', text });
  return { ...live, parts };
}

/** 工具事件 → live turn parts 里的工具卡片状态机（工具片段保持在时间线原位置） */
export function applyToolEvent(live: LiveTurn, ev: Extract<AgentEvent, { type: 'tool_event' }>): LiveTurn {
  const parts = live.parts.slice();
  // 同 id 多调用（个别上游代理复用 tool_call id）：open 定位尚未完结的卡片，
  // 后一个调用的增量事件开新卡片而非顶掉前一个已完结的调用（与 transcript 投影同语义）
  const open = parts.findIndex((p) => p.kind === 'tool' && p.id === ev.toolId && p.phase !== 'done' && p.phase !== 'failed' && p.phase !== 'rejected');
  const idx = open >= 0 ? open : parts.findIndex((p) => p.kind === 'tool' && p.id === ev.toolId);
  const cur: Extract<MsgPart, { kind: 'tool' }> | null = idx >= 0 && parts[idx].kind === 'tool' ? parts[idx] : null;
  // loop 对「拒绝」会补发 failed：保留拒绝态，不被失败态覆盖
  if ((ev.phase === 'failed' || ev.phase === 'completed') && cur?.phase === 'rejected') return live;
  // begin 类事件（started / params_partial / confirmation_needed）：无未完结卡片即开新卡
  const begin = (view: Extract<MsgPart, { kind: 'tool' }>) => {
    if (open >= 0) parts[open] = view;
    else parts.push(view);
  };
  // settle 类事件（completed / failed）：无未完结卡片时仅从未见过的调用才补卡，重复完成事件忽略
  const settle = (view: Extract<MsgPart, { kind: 'tool' }>) => {
    if (open >= 0) parts[open] = view;
    else if (idx < 0) parts.push(view);
  };
  const sub = ev.subAgent ? { subAgent: true, subTask: ev.subTask } : {};
  switch (ev.phase) {
    case 'started':
      begin({ kind: 'tool', id: ev.toolId, name: ev.toolName, params: ev.params, phase: 'running', output: '', ...sub });
      break;
    case 'params_partial':
      if (open >= 0 && cur) parts[open] = { ...cur, params: ev.params };
      else begin({ kind: 'tool', id: ev.toolId, name: ev.toolName, params: ev.params, phase: 'running', output: '', ...sub });
      break;
    case 'confirmation_needed':
      begin({ kind: 'tool', id: ev.toolId, name: ev.toolName, params: ev.params, phase: 'ask', output: '', requestId: ev.requestId });
      break;
    case 'confirmed':
      if (open >= 0 && cur) parts[open] = { ...cur, phase: 'running' };
      break;
    case 'rejected':
      if (open >= 0 && cur) parts[open] = { ...cur, phase: 'rejected' };
      break;
    case 'completed':
      if (open >= 0 && cur) parts[open] = { ...cur, phase: 'done', output: ev.output || '', ...(ev.extra ? { extra: ev.extra as Extract<MsgPart, { kind: 'tool' }>['extra'] } : {}) };
      else settle({ kind: 'tool', id: ev.toolId, name: ev.toolName, params: ev.params, phase: 'done', output: ev.output || '', ...sub });
      break;
    case 'failed':
      if (open >= 0 && cur) parts[open] = { ...cur, phase: 'failed', output: ev.output || '', ...(ev.extra ? { extra: ev.extra as Extract<MsgPart, { kind: 'tool' }>['extra'] } : {}) };
      else settle({ kind: 'tool', id: ev.toolId, name: ev.toolName, params: ev.params, phase: 'failed', output: ev.output || '', ...sub });
      break;
  }
  return { ...live, parts };
}

export const planView = (text: string, decided: PlanView['decided']): PlanView => ({ text, decided });

export type TurnScope = 'main' | 'side';

type TurnSetters = {
  scope: TurnScope;
  setMsgs: Dispatch<SetStateAction<MsgView[]>>;
  setLive: Dispatch<SetStateAction<LiveTurn | null>>;
  setTodos: Dispatch<SetStateAction<TodoItem[]>>;
  setError: Dispatch<SetStateAction<string>>;
  setSessions: Dispatch<SetStateAction<SessionMeta[]>>;
  /** 仅主对话投影 goal 横幅；侧边对话不接管目标 */
  setGoal?: Dispatch<SetStateAction<GoalState | null>>;
  /** 当前会话 id 引用：异步回调迟到（已切会话）时凭此丢弃，不污染新会话界面 */
  currentIdRef: MutableRefObject<string | null>;
};

/** 生成一条 turn 的事件处理器；主 / 侧两条通道各持一份，互不串扰 */
export function createTurnEventHandlers(s: TurnSetters): (ev: AgentEvent) => void {
  const { scope, setMsgs, setLive, setTodos, setError, setSessions, setGoal, currentIdRef } = s;
  return (ev: AgentEvent) => {
    if (ev.type === 'session_renamed') { if (scope === 'main') setSessions((prev) => prev.map((x) => (x.id === ev.sessionId ? { ...x, name: ev.name } : x))); }
    else if (ev.type === 'turn_started') setLive((l) => (l ? { ...l, startedAt: Date.now() } : l));
    else if (ev.type === 'model_round_started') setLive((l) => (l ? { ...l, round: ev.round } : l));
    else if (ev.type === 'text_chunk') setLive((l) => (l ? appendTextPart(l, ev.text) : l));
    else if (ev.type === 'thinking_chunk') setLive((l) => (l ? { ...l, thinking: l.thinking + ev.text } : l));
    else if (ev.type === 'tool_event') {
      setLive((l) => (l ? applyToolEvent(l, ev) : l));
      const list = (ev.extra as { todos?: TodoItem[] } | undefined)?.todos;
      if (Array.isArray(list)) setTodos(list);
    }
    else if (ev.type === 'plan_proposed') setLive((l) => (l ? { ...l, plan: planView(ev.plan, 'pending') } : l));
    else if (ev.type === 'plan_approved') setLive((l) => (l ? { ...l, plan: planView(ev.plan, 'approved') } : l));
    else if (ev.type === 'plan_rejected') setLive((l) => (l ? { ...l, plan: planView(ev.plan, 'rejected') } : l));
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
    // goal 事件仅投影到当前会话（对齐 MiniMax goal-flow.project 的 sessionId 首行校验：
    // 运行中切换 / 新建会话后，旧会话 turn 流仍在推送，不能污染新会话的横幅）
    else if (ev.type === 'goal_created' || ev.type === 'goal_status_changed' || ev.type === 'goal_usage_updated' || ev.type === 'goal_wait_changed') {
      if (scope === 'main' && setGoal && ev.sessionId === currentIdRef.current) setGoal(ev.goal);
    }
    // 故障转移提示（notice 不进服务端转录，turn 收尾刷新时保留，与 /goal 回执同一机制）
    else if (ev.type === 'provider_switched') setMsgs((m) => [...m, { kind: 'notice', key: `ps-${ev.turnId}-${ev.attempt}`, text: `已切换提供方：${ev.fromName || ev.from} → ${ev.toName || ev.to}（${PROVIDER_SWITCH_REASONS[ev.reason] || ev.reason}，第 ${ev.attempt} 次尝试）` }]);
    else if (ev.type === 'turn_failed') setError(ev.error || '任务失败');
    // 浏览器通知（opt-in，默认关；未授权时静默跳过）
    if ((ev.type === 'turn_completed' || ev.type === 'turn_failed') && browserNotifyEnabled() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(ev.type === 'turn_completed' ? 'AuroraAgent：任务完成' : 'AuroraAgent：任务失败', {
          body: ev.type === 'turn_failed' ? (ev.error || '详见界面错误提示') : '点击回到会话查看结果',
        });
      } catch { /* 部分浏览器构造即抛，忽略 */ }
    }
  };
}

/**
 * turn 收尾重投影：主对话按服务端会话转录，侧边对话按侧边转录（同源投影）。
 * notice（/goal 回执、故障转移提示）只存在于本地、不在服务端转录里，整体替换会冲掉，
 * 故统一「先投影、再把本地 notice 追加回来」。迟到（已切会话）时不投影。
 */
export async function finishTurnProjection(scope: TurnScope, sessionId: string, setMsgs: Dispatch<SetStateAction<MsgView[]>>): Promise<void> {
  const records = scope === 'side'
    ? (await getSideSession(sessionId)).records
    : (await getSession(sessionId)).records;
  setMsgs((prev) => [...projectRecords(records), ...prev.filter((m) => m.kind === 'notice')]);
}
