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
  abortTurn, clearGoal, createGoal, createSession, deleteSession, editGoal, forkSession, getGoal, getSession, getSettings, goalAction,
  listHarnesses, listModels, listSkills, listProviders, listSessions, patchSession, respondPermission, respondPlan, runTurn,
} from './api';
import { GOAL_COMMAND_HELP, formatGoalReceipt, formatGoalSummary, parseGoalCommand } from '../../util/agent/goal/command.mjs';
import { connectGoalEvents } from './goal-events';
import { GoalBar } from './components/GoalBar';
import { GOAL_STATUS_LABELS } from './types';
import type { GoalState, Harness, LiveTurn, ModelInfo, MsgView, ProviderRow, SessionMeta, SettingsInfo, TodoItem, SkillRow } from './types';
import { createTurnEventHandlers, finishTurnProjection } from './turn-events';
import { discardSide } from './api';

import { IconAlert, IconClose } from './icons';
import { toast, ToastViewport } from './toast';

export default function App() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MsgView[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  // 侧边对话（/btw）：null = 没开过；live / busy 与主对话同构但完全独立
  const [side, setSide] = useState<{ msgs: MsgView[]; live: LiveTurn | null; busy: boolean } | null>(null);
  const [sideActive, setSideActive] = useState(false); // 当前显示哪条对话（Ctrl+/ 切换）
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
  const [effort, setEffort] = useState('standard');
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState('');
  const [booting, setBooting] = useState(true); // 首屏会话列表未回：侧栏显示骨架而非「还没有会话」
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
      setEffort(got.meta.thinking === false ? 'off' : 'standard');
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
      setBooting(false);
      if (list.length) { openSession(list[0].id); return; }
      try {
        const s = await createSession({});
        setSessions([s]);
        openSession(s.id);
      } catch (e) {
        toast.error('初始化会话失败', { description: e instanceof Error ? e.message : String(e) });
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
    await runTurnStream('main', cur.id, text, {
      scope: 'main',
      setMsgs: setMessages, setLive, setTodos, setError, setSessions, setGoal, currentIdRef,
    });
  };

  /** 侧边对话（/btw）：一问一答的临时分支——继承主会话历史前缀，不落盘、不进会话列表、不接管目标 */
  const sendSide = async (text: string) => {
    const cur = current;
    if (!cur || !text.trim()) return;
    setSide((prev) => ({ msgs: [...(prev?.msgs || []), { kind: 'user', key: `side-opt-${Date.now()}`, text }], live: { turnId: '', parts: [], thinking: '', usage: null, compression: null, plan: null, round: 0, startedAt: Date.now() }, busy: true }));
    setSideActive(true);
    await runTurnStream('side', cur.id, text, {
      scope: 'side',
      setMsgs: (updater) => setSide((prev) => (prev ? { ...prev, msgs: typeof updater === 'function' ? updater(prev.msgs) : updater } : prev)),
      setLive: (updater) => setSide((prev) => (prev ? { ...prev, live: typeof updater === 'function' ? updater(prev.live) : updater } : prev)),
      setTodos, setError, setSessions, currentIdRef,
    });
  };

  /**
   * 跑一个 turn 并收尾：事件投影走 createTurnEventHandlers（主 / 侧同源），结束后按对应转录重投影。
   * 主对话额外刷新会话列表（标题 / 轮次 / 用量汇总）；侧边对话不碰主会话任何状态。
   */
  const runTurnStream = async (
    scope: 'main' | 'side',
    sessionId: string,
    text: string,
    setters: Parameters<typeof createTurnEventHandlers>[0],
  ) => {
    const cur = current;
    try {
      await runTurn(
        {
          sessionId, input: text, thinking: effort !== 'off',
          model: cur?.model, provider: cur?.provider, ...(scope === 'side' ? { side: true } : {}),
        },
        createTurnEventHandlers(setters),
      );
    } catch (e) {
      toast.error('任务失败', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      try {
        // 运行中切换 / 新建会话后，旧 turn 的收尾刷新不得把旧会话投影写进新会话界面
        // （与 SSE goal 事件的 sessionId 校验同一道防线，对齐 MiniMax canProjectOperation）
        if (scope === 'side' || currentIdRef.current === sessionId) {
          await finishTurnProjection(scope, sessionId, setters.setMsgs);
        }
        if (scope === 'main') setSessions(await listSessions());
      } catch { /* 刷新失败保留当前界面 */ }
      if (scope === 'main') { setBusy(false); setLive(null); }
      else setSide((prev) => (prev ? { ...prev, live: null, busy: false } : prev));
    }
  };

  /** 丢弃侧边对话回到主对话（与终端 Ctrl+C 空提示符同语义） */
  const discardBtw = async () => {
    if (!currentId) return;
    try { await discardSide(currentId); } catch { /* 丢弃失败也照样回到主对话：侧边数据本就不落盘 */ }
    setSide(null);
    setSideActive(false);
  };

  /** Ctrl+/ 主 / 侧边对话切换：没有侧边对话时不开切换 */
  const toggleSide = useCallback(() => {
    if (!side) { toast.info('还没有侧边对话', { description: '输入 /btw <问题> 开一个，继承当前会话历史，不落盘' }); return; }
    setSideActive((v) => !v);
  }, [side]);

  const decide = async (requestId: string, decision: 'allow' | 'deny' | 'always') => {
    try {
      await respondPermission(requestId, decision);
    } catch (e) {
      toast.error('权限回传失败', { description: e instanceof Error ? e.message : String(e) });
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
      toast.error('计划回传失败', { description: e instanceof Error ? e.message : String(e) });
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

  // 跨客户端 goal 事件流：另一客户端（终端 / 另一标签页）经 REST 改动目标时，横幅与本地状态
  // 即时校正（goal_cleared 清横幅；其余按服务端快照整体覆写）——对齐 MiniMax 全局事件投影
  useEffect(() => {
    if (!currentId) return;
    return connectGoalEvents(currentId, (ev) => {
      if (ev.sessionId !== currentIdRef.current) return; // 切会话后迟到的帧不投影
      if (ev.type === 'goal_cleared') { setGoal(null); return; }
      setGoal(ev.goal);
    });
  }, [currentId]);

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
    // 无会话处理（对齐 MiniMax execute() 第 4-5 步）：kind==='create' 先尝试 ensureSessionId()
    // 自动建会话；其余意图直接告警。两条路径都 retained——原样回填，会话就绪后可直接重发
    if (!currentId && intent.kind !== 'create') {
      push('当前没有会话：请先新建或切换会话，再管理目标');
      setGoalPrefill({ text: `/goal ${rawArgs}`, nonce: Date.now() });
      return;
    }
    let sid = currentId;
    if (!sid) {
      try {
        const s = await createSession({});
        setSessions((prev) => [s, ...prev]);
        await openSession(s.id); // 等会话落地（消息投影 / 偏好就位）再继续，目标回执不被投影冲掉
        currentIdRef.current = s.id; // setCurrentId 的渲染尚未落地，手动同步引用供 stale() 判定
        sid = s.id;
      } catch (e) {
        push('无法为当前目标创建会话：请稍后重试或手动新建会话后再设立目标');
        setGoalPrefill({ text: `/goal ${rawArgs}`, nonce: Date.now() });
        toast.error('自动创建会话失败', { description: e instanceof Error ? e.message : String(e) });
        return;
      }
    }
    // 命令发起时的会话与纪元：回调迟到（用户已切换 / 新建会话）时不投影，避免旧会话的
    // 目标状态与通知落到新会话界面（对齐 MiniMax canProjectOperation）
    const epoch = goalViewEpochRef.current;
    const stale = () => goalViewEpochRef.current !== epoch || currentIdRef.current !== sid;
    const fail = (e: unknown) => {
      // 对齐 MiniMax goal-flow 的 retained 语义：操作失败不清空用户输入，原样回填便于就地修改重发
      // onlyIfEmpty：仅当用户尚未输入新内容时恢复，避免覆盖失败等待期间新敲的文本
      setGoalPrefill({ text: `/goal ${rawArgs}`, nonce: Date.now(), onlyIfEmpty: true });
      toast.error('目标操作失败', { description: `${e instanceof Error ? e.message : String(e)}（输入已保留，可修改后重发）` });
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
      toast.error('目标操作失败', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const changePermMode = async (mode: string) => {
    if (!current) return;
    try {
      const meta = await patchSession(current.id, { permissionMode: mode });
      setSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)));
      setPermMode(mode);
    } catch (e) {
      toast.error('切换权限模式失败', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const changeTitleMode = async (mode: string) => {
    if (!current) return;
    try {
      const meta = await patchSession(current.id, { titleMode: mode });
      setSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)));
      setTitleMode(mode);
    } catch (e) {
      toast.error('切换标题生成方式失败', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const changeEffort = async (level: string) => {
    if (!current) return;
    const on = level !== 'off';
    try {
      const meta = await patchSession(current.id, { thinking: on });
      setSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)));
      setEffort(level);
    } catch (e) {
      toast.error('切换思考强度失败', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const changePlan = async (on: boolean) => {
    if (!current) return;
    try {
      const meta = await patchSession(current.id, { planMode: on });
      setSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)));
      setPlanOn(on);
    } catch (e) {
      toast.error('切换计划模式失败', { description: e instanceof Error ? e.message : String(e) });
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
      toast.error('新建会话失败', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const forkSessionById = async (id: string) => {
    try {
      const s = await forkSession(id);
      setSessions((prev) => [s, ...prev]);
      openSession(s.id);
    } catch (e) {
      toast.error('派生会话失败', { description: e instanceof Error ? e.message : String(e) });
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
      toast.error('切换模式失败', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const changeModel = async (m: ModelInfo) => {
    if (!current || busy) return;
    try {
      const meta = await patchSession(current.id, { model: m.id, provider: m.provider });
      setSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)));
    } catch (e) {
      toast.error('切换模型失败', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  // 键盘快捷键：Ctrl/Cmd+K 新建会话，/ 聚焦输入框（焦点不在可输入元素时）。
  // 弹层打开时只保留聚焦输入（其余让位给对话框自身的按键处理）。
  const [focusNonce, setFocusNonce] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (settingsOpen) return;
        e.preventDefault();
        void newSession();
        return;
      }
      // Ctrl+/ 主 / 侧边对话切换（与终端同键位；弹层打开时让位给对话框自身按键处理）
      if ((e.metaKey || e.ctrlKey) && e.key === '/' && !settingsOpen) {
        e.preventDefault();
        toggleSide();
        return;
      }
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const dlg = document.querySelector('dialog[open]');
        if (dlg) return; // 弹层内的 / 是搜索输入，不抢
        e.preventDefault();
        setFocusNonce((n) => n + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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
        loading={booting}
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
        {side && sideActive ? (
          <div className="side-banner" role="status">
            <span className="side-banner-text">侧边对话中 · 继承自主对话历史，不落盘、不进会话列表</span>
            <span className="side-banner-acts">
              <button type="button" className="btn btn-link" onClick={() => setSideActive(false)}>返回主对话</button>
              <button type="button" className="btn btn-link danger" onClick={() => { discardBtw().catch(() => {}); }}>丢弃</button>
            </span>
          </div>
        ) : null}
        <ChatView
          messages={sideActive ? side?.msgs || [] : messages}
          live={sideActive ? side?.live ?? null : live}
          hasSession={Boolean(current)}
          onDecide={decide}
          onDecidePlan={decidePlan}
          onPick={sideActive ? sendSide : send}
          todos={sideActive ? [] : todos}
        />
        {!sideActive && goal ? <GoalBar goal={goal} onAction={decideGoal} /> : null}
        <Composer
          busy={sideActive ? Boolean(side?.busy) : busy}
          onSend={sideActive ? sendSide : send}
          onGoalCommand={handleGoalCommand}
          goalPrefill={goalPrefill}
          onStop={stop}
          models={models}
          modelStatus={modelStatus}
          model={current?.model || ''}
          onModel={changeModel}
          providers={providers}
          effort={effort}
          onEffort={changeEffort}
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
          focusNonce={focusNonce}
        />
      </main>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onProvidersChanged={providersChanged}
      />
      <ToastViewport />
    </div>
  );
}
