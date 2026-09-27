/**
 * AuroraAgent 工作台根组件：会话 / 消息 / 流式 turn / 模型 / 模式 / 设置的状态编排。
 * 发送时乐观插入用户消息并挂上 live turn，事件经函数式 setState 增量更新，结束后按服务端转录重投影。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { browserNotifyEnabled } from './components/TuiPanel';
import { ChatView } from './components/ChatView';
import { Composer } from './components/Composer';
import { SettingsDialog } from './components/SettingsDialog';
import { projectRecords } from './projection';
import {
  abortTurn, clearGoal, createGoal, createSession, deleteSession, editGoal, forkSession, getGoal, getSession, getSettings, goalAction,
  listHarnesses, listModels, listSkills, listProviders, listSessions, patchSession, respondPermission, respondPlan, runTurn,
} from './api';
import { GOAL_COMMAND_HELP, formatGoalReceipt, formatGoalSummary, parseGoalCommand } from '../../util/agent/goal/command.mjs';
import { GOAL_STATUS_LABELS } from './types';
import type { AgentEvent, GoalState, Harness, LiveTurn, ModelInfo, MsgPart, MsgView, PlanView, ProviderRow, SessionMeta, SettingsInfo, TodoItem, ToolView, SkillRow } from './types';

const planView = (text: string, decided: PlanView['decided']): PlanView => ({ text, decided });
import { IconAlert, IconClose } from './icons';

/** 文本增量 → 追加到 parts 的最后一个文本片段（工具之后的新文本开新片段，保住时间线） */
function appendTextPart(live: LiveTurn, text: string): LiveTurn {
  const parts = live.parts.slice();
  const last = parts[parts.length - 1];
  if (last && last.kind === 'text') parts[parts.length - 1] = { kind: 'text', text: last.text + text };
  else parts.push({ kind: 'text', text });
  return { ...live, parts };
}

/** 工具事件 → live turn parts 里的工具卡片状态机（工具片段保持在时间线原位置） */
function applyToolEvent(live: LiveTurn, ev: Extract<AgentEvent, { type: 'tool_event' }>): LiveTurn {
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
      if (open >= 0 && cur) parts[open] = { ...cur, phase: 'done', output: ev.output || '', ...(ev.extra ? { extra: ev.extra as ToolView['extra'] } : {}) };
      else settle({ kind: 'tool', id: ev.toolId, name: ev.toolName, params: ev.params, phase: 'done', output: ev.output || '', ...sub });
      break;
    case 'failed':
      if (open >= 0 && cur) parts[open] = { ...cur, phase: 'failed', output: ev.output || '', ...(ev.extra ? { extra: ev.extra as ToolView['extra'] } : {}) };
      else settle({ kind: 'tool', id: ev.toolId, name: ev.toolName, params: ev.params, phase: 'failed', output: ev.output || '', ...sub });
      break;
  }
  return { ...live, parts };
}

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MsgView[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [todos, setTodos] = useState<TodoItem[]>([]);
  const [goal, setGoal] = useState<GoalState | null>(null);
  const [goalPrefill, setGoalPrefill] = useState<{ text: string; nonce: number; onlyIfEmpty?: boolean }>({ text: '', nonce: 0 });
  const [permMode, setPermMode] = useState('ask_when_needed');
  const [titleMode, setTitleMode] = useState('local');
  const [planOn, setPlanOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [modelStatus, setModelStatus] = useState('idle');
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [thinking, setThinking] = useState(true);
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const booted = useRef(false);

  const current = sessions.find((s) => s.id === currentId) || null;
  // 最新会话 id 与目标视图纪元：异步回调（goal REST / getGoal / SSE goal 事件）凭此防串会话
  // （对齐 MiniMax goal-flow 的 canProjectOperation：sequence 最新且会话未变才投影）
  const currentIdRef = useRef<string | null>(currentId);
  const goalViewEpochRef = useRef(0);
  useEffect(() => { currentIdRef.current = currentId; }, [currentId]);

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
    const epoch = ++goalViewEpochRef.current; // 慢响应迟到时凭纪元丢弃，不投影到已切走的会话
    try {
      const got = await getSession(id);
      if (goalViewEpochRef.current !== epoch) return;
      setMessages(projectRecords(got.records));
      setTodos(Array.isArray(got.meta.todos) ? got.meta.todos : []);
      getGoal(id).then((r) => { if (goalViewEpochRef.current === epoch) setGoal(r.goal); }).catch(() => { if (goalViewEpochRef.current === epoch) setGoal(null); });
      setPermMode(got.meta.permissionMode || 'ask_when_needed');
      setTitleMode(got.meta.titleMode || 'local');
      setPlanOn(got.meta.planMode === true);
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
      listSkills().then(setSkills).catch(() => {});
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
    setLive({ turnId: '', parts: [], thinking: '', usage: null, compression: null, plan: null, round: 0, startedAt: Date.now() });
    try {
      await runTurn(
        { sessionId: cur.id, input: text, thinking, model: cur.model, provider: cur.provider },
        (ev: AgentEvent) => {
          if (ev.type === 'session_renamed') setSessions((prev) => prev.map((s) => (s.id === ev.sessionId ? { ...s, name: ev.name } : s)));
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
          else if (ev.type === 'goal_created' || ev.type === 'goal_status_changed' || ev.type === 'goal_usage_updated' || ev.type === 'goal_wait_changed') { if (ev.sessionId === currentIdRef.current) setGoal(ev.goal); }
          else if (ev.type === 'turn_failed') setError(ev.error || '任务失败');
          // 浏览器通知（opt-in，默认关；未授权时静默跳过）
          if ((ev.type === 'turn_completed' || ev.type === 'turn_failed') && browserNotifyEnabled() && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            try {
              new Notification(ev.type === 'turn_completed' ? 'AuroraAgent：任务完成' : 'AuroraAgent：任务失败', {
                body: ev.type === 'turn_failed' ? (ev.error || '详见界面错误提示') : '点击回到会话查看结果',
              });
            } catch { /* 部分浏览器构造即抛，忽略 */ }
          }
        },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      try {
        // 运行中切换 / 新建会话后，旧 turn 的收尾刷新不得把旧会话投影写进新会话界面
        // （与 SSE goal 事件的 sessionId 校验同一道防线，对齐 MiniMax canProjectOperation）
        if (currentIdRef.current === cur.id) {
          const got = await getSession(cur.id);
          // notice（/goal 命令回执、goal 事件凭据）只存在于本地、不在服务端转录里：
          // 整体替换会把它们冲掉，「生成中可管理目标」于是收不到任何反馈。保留 notice 追加在投影之后
          setMessages((prev) => [...projectRecords(got.records), ...prev.filter((m) => m.kind === 'notice')]);
        }
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
      parts: l.parts.map((p) => (p.kind === 'tool' && p.requestId === requestId
        ? { ...p, phase: decision === 'deny' ? 'rejected' as const : 'running' as const }
        : p)),
    } : l));
  };

  const decidePlan = async (decision: 'approve' | 'reject') => {
    if (!currentId) return;
    try {
      await respondPlan(currentId, decision);
    } catch (e) {
      setError(`计划回传失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // 乐观更新：服务端会随即推进并推送 plan_approved / plan_rejected 校正
    setLive((l) => (l && l.plan ? { ...l, plan: { ...l.plan, decided: decision === 'approve' ? 'approved' : 'rejected' } } : l));
  };

  // 目标完成回执：同一 goalId 从非 complete 迁到 complete 时贴一条系统消息（会话切换不误触发）
  const prevGoal = useRef<{ id: string; status: string } | null>(null);
  useEffect(() => {
    const cur = goal ? { id: goal.goalId, status: goal.status } : null;
    if (goal && cur && prevGoal.current && cur.id === prevGoal.current.id && cur.status === 'complete' && prevGoal.current.status !== 'complete') {
      setMessages((m) => [...m, { kind: 'notice', key: `gr${goal.updatedAt}`, text: formatGoalReceipt(goal) }]);
    }
    prevGoal.current = cur;
  }, [goal]);

  /**
   * /goal 斜杠命令：解析与终端 REPL 共用 command.mjs 单一事实源；执行走 /api/agent/goal* REST 面。
   * 每次执行前先取一次新鲜目标快照再分派（对齐 MiniMax TuiGoalFlow.execute() 的
   * `existing = await runtime.getGoal(sessionId)`）：React state 里的 goal 可能陈旧——turn 运行中
   * 模型侧自建 / 改写目标、或另一客户端刚改动过——陈旧快照会让人误走 create 而非 edit、
   * 或带陈旧纪元触发假 GOAL_STALE 409。help / error 不依赖快照，本地直接收尾（MiniMax 同样
   * 在取快照前消费二者）。
   */
  const handleGoalCommand = async (rawArgs: string) => {
    const push = (text: string) => setMessages((m) => [...m, { kind: 'notice', key: `g${Date.now()}`, text }]);
    const intent = parseGoalCommand(rawArgs);
    if (intent.kind === 'help') { push(GOAL_COMMAND_HELP); return; }
    if (intent.kind === 'error') {
      // 解析失败不回撤输入：原样回填便于就地修改（对齐 MiniMax 的 retained 语义）
      push(intent.message);
      setGoalPrefill({ text: `/goal ${rawArgs}`, nonce: Date.now() });
      return;
    }
    if (!currentId) {
      push('当前没有会话：请先新建或切换会话，再管理目标');
      // 对齐 MiniMax retained 语义：无会话也原样回填，会话就绪后可直接重发
      setGoalPrefill({ text: `/goal ${rawArgs}`, nonce: Date.now() });
      return;
    }
    // 命令发起时的会话与纪元：回调迟到（用户已切换 / 新建会话）时不投影，避免旧会话的
    // 目标状态与通知落到新会话界面（对齐 MiniMax canProjectOperation）
    const sid = currentId;
    const epoch = goalViewEpochRef.current;
    const stale = () => goalViewEpochRef.current !== epoch || currentIdRef.current !== sid;
    const fail = (e: unknown) => {
      // 对齐 MiniMax goal-flow 的 retained 语义：操作失败不清空用户输入，原样回填便于就地修改重发
      // onlyIfEmpty：仅当用户尚未输入新内容时恢复，避免覆盖失败等待期间新敲的文本
      setGoalPrefill({ text: `/goal ${rawArgs}`, nonce: Date.now(), onlyIfEmpty: true });
      setError(`目标操作失败：${e instanceof Error ? e.message : String(e)}（输入已保留，可修改后重发）`);
    };
    // 新鲜快照：create-or-edit 判定、纪元、查看摘要、edit 回填全部以它为准（在途切会话则丢弃）
    let existing: GoalState | null;
    try {
      existing = (await getGoal(sid)).goal;
    } catch (e) { fail(e); return; }
    if (stale()) return;
    setGoal(existing); // 以服务端真相校正横幅（含 turn 运行中模型侧的自建 / 改写）
    // 有未完成目标时「设立」语义变为「改写目标文本」（与 MiniMax 客户端 setObjective 一致；创建的严格 409 由服务端守）
    const unfinished = existing !== null && existing.status !== 'complete';
    switch (intent.kind) {
      case 'view':
        if (!existing) { push('当前会话没有目标：输入 /goal <你想达成的目标> 设立'); return; }
        push(formatGoalSummary(existing));
        return;
      case 'edit':
        if (!existing) { push('当前会话没有目标'); return; }
        setGoalPrefill({ text: `/goal ${existing.objective}`, nonce: Date.now() });
        push('编辑目标文本后按 Enter 提交（budget=50K 可随文调整预算）');
        return;
      case 'clear':
        clearGoal(sid).then((r) => { if (stale()) return; setGoal(null); push(r.cleared ? '目标已移除' : '当前会话没有目标'); }).catch(fail);
        return;
      case 'create':
        // 改写路径同样携带 budget= 与纪元快照（/goal <目标> budget=50K 对已有目标也生效）
        (unfinished && existing
          ? editGoal(sid, intent.objective, intent.tokenBudget, { expectedGoalId: existing.goalId, expectedUpdatedAt: existing.updatedAt })
          : createGoal(sid, intent.objective, intent.tokenBudget))
          .then((r) => {
            if (stale()) return;
            setGoal(r.goal);
            push(`${unfinished ? '目标文本已更新' : '新目标已设立'}：${intent.objective}${intent.tokenBudget != null ? ` · 预算 ${intent.tokenBudget} tokens` : ''}`);
          }).catch(fail);
        return;
      case 'budget':
        if (!existing) { push('当前会话没有目标'); return; }
        goalAction(sid, 'budget', { tokenBudget: intent.tokenBudget, expectedGoalId: existing.goalId, expectedUpdatedAt: existing.updatedAt })
          .then((r) => {
            if (stale()) return;
            setGoal(r.goal);
            push(`预算已${intent.tokenBudget == null ? '清除' : `设为 ${intent.tokenBudget}`}`);
          }).catch(fail);
        return;
      default: {
        // pause / resume / stop：状态迁移（回执与终端 REPL 同源；拒绝信息由服务端说清原因）
        const label = { pause: '已暂停', resume: '已恢复', stop: '已停止' }[intent.kind] || '已更新';
        goalAction(sid, intent.kind)
          .then((r) => { if (stale()) return; setGoal(r.goal); push(`目标${label}：${GOAL_STATUS_LABELS[r.goal.status] || r.goal.status}`); })
          .catch(fail);
        return;
      }
    }
  };

  const decideGoal = async (action: 'pause' | 'resume' | 'stop') => {
    if (!currentId) return;
    try {
      const r = await goalAction(currentId, action);
      setGoal(r.goal); // 以服务端结算为准（含纪元与状态校验的拒绝信息）
    } catch (e) {
      setError(`目标操作失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const changePermMode = async (mode: string) => {
    if (!current) return;
    try {
      const meta = await patchSession(current.id, { permissionMode: mode });
      setSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)));
      setPermMode(mode);
    } catch (e) {
      setError(`切换权限模式失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const changeTitleMode = async (mode: string) => {
    if (!current) return;
    try {
      const meta = await patchSession(current.id, { titleMode: mode });
      setSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)));
      setTitleMode(mode);
    } catch (e) {
      setError(`切换标题生成方式失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const changePlan = async (on: boolean) => {
    if (!current) return;
    try {
      const meta = await patchSession(current.id, { planMode: on });
      setSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)));
      setPlanOn(on);
    } catch (e) {
      setError(`切换计划模式失败：${e instanceof Error ? e.message : String(e)}`);
    }
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

  const forkSessionById = async (id: string) => {
    try {
      const s = await forkSession(id);
      setSessions((prev) => [s, ...prev]);
      openSession(s.id);
    } catch (e) {
      setError(`派生会话失败：${e instanceof Error ? e.message : String(e)}`);
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
        onFork={forkSessionById}
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
          onDecidePlan={decidePlan}
          onPick={send}
          todos={todos}
          goal={goal}
          onGoalAction={decideGoal}
        />
        <Composer
          busy={busy}
          onSend={send}
          onGoalCommand={handleGoalCommand}
          goalPrefill={goalPrefill}
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
          permissionMode={permMode}
          onPermissionMode={changePermMode}
          titleMode={titleMode}
          onTitleMode={changeTitleMode}
          planMode={planOn}
          onPlanMode={changePlan}
          skills={skills}
          sessionId={currentId}
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
