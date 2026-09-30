/**
 * AuroraAgent 工作台根组件：会话 / 消息 / 流式 turn / 模型 / 模式 / 设置的状态编排。
 * 发送时乐观插入用户消息并挂上 live turn，事件经函数式 setState 增量更新，结束后按服务端转录重投影。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { WorkspaceHeader } from './components/WorkspaceHeader';
import { WorkspaceTopOverlay } from './components/WorkspaceTopOverlay';
import { ScopedErrorBoundary } from './ScopedErrorBoundary';
import { ChatView } from './components/ChatView';
import { Composer } from './components/Composer';
import { SettingsDialog } from './components/SettingsDialog';
import { projectRecords } from './projection';
import {
  abortTurn, checkUpdate, clearGoal, createGoal, createSession, deleteSession, editGoal, forkSession, getAgentQueue, getGoal, getSession, getSettings, goalAction,
  listHarnesses, listHooks, listJobs, listMcpServers, listModels, listSkills, listProviders, listSessions, patchSession, promoteQueueItem, removeQueueItem, respondPermission, respondPlan, runTurn,
  saveApiKey, saveGeneration,
} from './api';
import { GOAL_COMMAND_HELP, formatGoalReceipt, formatGoalSummary, parseGoalCommand } from '../../util/agent/goal/command.mjs';
import { connectGoalEvents } from './goal-events';
import { GoalBar } from './components/GoalBar';
import { GOAL_STATUS_LABELS } from './types';
import { BASE_COMMANDS } from './slash-commands';
import { setThemePreference } from './theme';
import type { ThemePreference } from './theme';
import type { AgentEvent, GoalState, Harness, LiveTurn, ModelInfo, MsgView, ProviderRow, QueueItem, SessionMeta, SettingsInfo, TodoItem, SkillRow, UpdateInfo } from './types';
import { createTurnEventHandlers, finishTurnProjection } from './turn-events';
import { canGoBack, canGoForward, createNavHistory, goBack, goForward, pushNav, removeNav } from './nav-history.mjs';
import { discardSide } from './api';

import { IconAlert, IconClose } from './icons';
import { toast, ToastViewport } from './toast';

/** /theme 参数 → 主题偏好（auto 与 system 同义，对齐终端 /theme 的三档） */
const THEME_ARGS: Record<string, ThemePreference> = { dark: 'dark', light: 'light', auto: 'system', system: 'system' };
const THEME_LABEL: Record<ThemePreference, string> = { dark: '深色', light: '浅色', system: '跟随系统' };

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
  // 斜杠命令唤起选择器：/model 与 /harness 无参数时打开对应二级菜单（nonce 递增即触发）
  const [pickerRequest, setPickerRequest] = useState<{ kind: 'model' | 'harness'; nonce: number } | null>(null);
  const [permMode, setPermMode] = useState('ask_when_needed');
  const [titleMode, setTitleMode] = useState('local');
  const [planOn, setPlanOn] = useState(false);
  const [busy, setBusy] = useState(false);
  // 消息队列（#3212）：活跃 turn 期间提交的消息在服务端排队，这里只做界面投影与操作入口
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const refreshQueue = useCallback(async (sid: string) => {
    try { setQueue((await getAgentQueue(sid)).items); } catch { setQueue([]); }
  }, []);
  // 正在运行的会话 id 集合（侧栏行左侧灰色加载圈的数据源）：主 / 侧边 turn 开始时登记、收尾移除。
  // 运行中允许切换会话，旧的 turn 仍在跑——故不能简单用 busy && currentId 推导
  const [running, setRunning] = useState<Set<string>>(() => new Set());
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

  // 会话导航历史（ZCode taskNav：浏览器式前进 / 后退栈）。用户主动打开 / 新建 / 派生会话入栈，
  // 后退 / 前进只移 cursor 不再入栈；删除会话时把它的条目摘掉。ref 供快捷键等处读最新值。
  const [navHist, setNavHist] = useState(createNavHistory);
  const navHistRef = useRef(navHist);
  useEffect(() => { navHistRef.current = navHist; }, [navHist]);

  const openSession = useCallback(async (id: string, record = true) => {
    if (record) setNavHist((h) => pushNav(h, id));
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

  /**
   * 主 turn 结算信号：队列接力的流必须等前一条完全落地才能接管主对话视图，
   * 否则前一条 finally 里的 setBusy(false) / setLive(null) 会把刚起跑的接力 turn 抹掉。
   * 每条主对话工作（直接提交的、队列接力的）结束前都把自己的 promise 挂上来，形成链式等待。
   */
  const mainSettled = useRef<Promise<void>>(Promise.resolve());

  const send = async (text: string) => {
    const cur = current;
    if (!cur || !text.trim()) return;
    // 生成中提交：不进转录、不起 live，交给服务端入队；队列条即它的容身之处，
    // 前一条结算后由泵接力，届时 runQueuedTurn 把投影接到主对话视图上
    if (busy) { void runQueuedTurn(cur.id, text); return; }
    let settle!: () => void;
    mainSettled.current = new Promise<void>((resolve) => { settle = resolve; });
    setBusy(true);
    setRunning((prev) => new Set(prev).add(cur.id));
    setError('');
    setMessages((prev) => [...prev, { kind: 'user', key: `opt-${Date.now()}`, text }]);
    setLive({ turnId: '', parts: [], thinking: '', usage: null, compression: null, plan: null, round: 0, startedAt: Date.now() });
    try {
      await runTurnStream('main', cur.id, text, {
        scope: 'main',
        setMsgs: setMessages, setLive, setTodos, setError, setSessions, setGoal, currentIdRef,
      });
    } finally { settle(); }
  };

  /**
   * 队列接力：服务端把这条消息排在活跃 turn 之后，流先只回 turn_queued 回执。
   * 等 turn_started 到场（泵开始跑它）且前一条主 turn 已结算，再把用户消息 + live turn
   * 补进主对话视图，缓冲事件按序补放——用户视角就是两条消息连着跑完，中间没有断档。
   */
  const runQueuedTurn = async (sessionId: string, text: string) => {
    const prev = mainSettled.current;
    const opId = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let settle!: () => void;
    mainSettled.current = new Promise<void>((resolve) => { settle = resolve; });
    const handlers = createTurnEventHandlers({
      scope: 'main',
      setMsgs: setMessages, setLive, setTodos, setError, setSessions, setGoal, currentIdRef,
    });
    const buf: AgentEvent[] = [];
    let primed = false;
    const prime = () => {
      primed = true;
      setMessages((m) => [...m, { kind: 'user', key: `q-${opId}`, text }]);
      setLive({ turnId: '', parts: [], thinking: '', usage: null, compression: null, plan: null, round: 0, startedAt: Date.now() });
      setBusy(true);
      setRunning((r) => new Set(r).add(sessionId));
    };
    let flushing = false;
    const flush = async () => {
      await prev;
      for (const ev of buf.splice(0)) {
        if (!primed && ev.type !== 'turn_queued') prime();
        handlers(ev);
      }
    };
    try {
      await runTurn({ sessionId, input: text, opId }, (ev) => {
        if (ev.type === 'turn_queued') { void refreshQueue(sessionId); return; }
        // 已被当前 turn 吸收（steering）：不开新回合，队列条刷新后即消失
        if (ev.type === 'turn_steered') { void refreshQueue(sessionId); return; }
        buf.push(ev);
        if (!flushing) { flushing = true; void flush(); }
      });
    } catch (e) {
      if (primed) toast.error('任务失败', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      await flush();
      if (primed) await finishMainTurn(sessionId);
      else await refreshQueue(sessionId);
      settle();
    }
  };

  /** 主对话收尾：与 runTurnStream 的 finally 同构（重投影 + 清 live + 摘运行标记） */
  const finishMainTurn = async (sessionId: string) => {
    try {
      if (currentIdRef.current === sessionId) await finishTurnProjection('main', sessionId, setMessages);
      setSessions(await listSessions());
    } catch { /* 刷新失败保留当前界面 */ }
    setBusy(false);
    setLive(null);
    setRunning((prev) => { const next = new Set(prev); next.delete(sessionId); return next; });
  };

  /** 侧边对话（/btw）：一问一答的临时分支——继承主会话历史前缀，不落盘、不进会话列表、不接管目标 */
  const sendSide = async (text: string) => {
    const cur = current;
    if (!cur || !text.trim()) return;
    setSide((prev) => ({ msgs: [...(prev?.msgs || []), { kind: 'user', key: `side-opt-${Date.now()}`, text }], live: { turnId: '', parts: [], thinking: '', usage: null, compression: null, plan: null, round: 0, startedAt: Date.now() }, busy: true }));
    setSideActive(true);
    setRunning((prev) => new Set(prev).add(cur.id)); // 侧边对话也是该会话的活跃工作：侧栏同样转圈
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
      setRunning((prev) => { const next = new Set(prev); next.delete(sessionId); return next; });
    }
  };

  // 队列刷新：会话忙或有等待项时按 1.2s 轮询（turn_queued 只推给自己那条流，
  // 跨提交的队列视图统一由轮询兜底，避免漏刷导致「已经跑了却还显示在队列里」）
  useEffect(() => {
    if (!currentId) { setQueue([]); return; }
    let dead = false;
    const tick = () => { if (!dead) void refreshQueue(currentId); };
    tick();
    const id = setInterval(tick, 1200);
    return () => { dead = true; clearInterval(id); };
  }, [currentId, refreshQueue, busy]);

    /** 队列操作：立即发送（挪到队首，下一个就被泵接走）/ 移除等待中的消息 */
  const promoteQueue = async (opId: string) => {
    if (!currentId) return;
    try { await promoteQueueItem(currentId, opId); await refreshQueue(currentId); }
    catch (e) { toast.error('操作失败', { description: e instanceof Error ? e.message : String(e) }); }
  };
  const removeQueue = async (opId: string) => {
    if (!currentId) return;
    try { await removeQueueItem(currentId, opId); await refreshQueue(currentId); }
    catch (e) { toast.error('操作失败', { description: e instanceof Error ? e.message : String(e) }); }
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
   * 斜杠命令分发（Composer 的 `/` 菜单执行入口；/goal 家族另有专用处理器）。
   * 词条与终端 REPL 的 baseCommands 同源（web-ui/src/slash-commands.ts），这里只做网页侧落地：
   * 能本地立即生效的直接办，需要服务端的走既有 REST，纯终端语义的给出说明。
   */
  const handleCommand = async (name: string, args: string) => {
    const notice = (text: string) => setMessages((m) => [...m, { kind: 'notice', key: `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`, text }]);
    const arg = args.trim();
    switch (name) {
      case 'goal':
        await handleGoalCommand(arg); // 正常路径由 Composer 先行拦截，这里是兜底
        return;
      case 'help': {
        const lines = BASE_COMMANDS.map((c) => `/${c.name}${c.argHint ? ` ${c.argHint}` : ''} — ${c.summary}`);
        notice(`可用命令（与终端一致）：\n${lines.join('\n')}`);
        return;
      }
      case 'new':
        await newSession();
        return;
      case 'sessions': {
        if (!sessions.length) { notice('当前没有会话'); return; }
        const lines = sessions.slice(0, 12).map((s, i) => `${i + 1}. ${s.name}（${s.model || '默认模型'} · ${s.harness || 'standard'}）`);
        notice(`会话列表（左侧栏可切换）：\n${lines.join('\n')}${sessions.length > 12 ? `\n…共 ${sessions.length} 个` : ''}`);
        return;
      }
      case 'model':
        if (arg) { notice(`切换模型：${arg}（用输入框右侧的模型选择器切换）`); return; }
        setPickerRequest({ kind: 'model', nonce: Date.now() });
        return;
      case 'harness':
        if (arg) {
          if (harnesses.some((h) => h.id === arg)) { await changeHarness(arg); return; }
          notice(`未知模式：${arg}（可选 ${harnesses.map((h) => h.id).join(' / ')}）`);
          return;
        }
        setPickerRequest({ kind: 'harness', nonce: Date.now() });
        return;
      case 'theme': {
        const pref = THEME_ARGS[arg || 'system'];
        if (!pref) { notice('用法：/theme dark|light|auto'); return; }
        setThemePreference(pref);
        notice(`外观已切换：${THEME_LABEL[pref]}`);
        return;
      }
      case 'mcp': {
        try {
          const rows = await listMcpServers();
          if (!rows.length) { notice('尚未配置 MCP 服务器（设置 → MCP 工具，实验特性需 AURORAAGENT_EXPERIMENTAL_MCP=1）'); return; }
          const lines = rows.map((r) => `${r.name}（${r.transport}）${r.enabled === false ? ' · 已停用' : r.connected ? ` · 已连接 · ${r.tools} 个工具` : ' · 未连接'}`);
          notice(`MCP 服务器：\n${lines.join('\n')}`);
        } catch (e) { notice(`MCP 未开启：${e instanceof Error ? e.message : String(e)}`); }
        return;
      }
      case 'cron': {
        if (!currentId) { notice('当前没有会话：定时任务要绑定一个会话'); return; }
        try {
          const rows = (await listJobs()).filter((j) => j.sessionId === currentId);
          if (!rows.length) { notice('当前会话没有定时任务。设置 → 定时任务可新建；也可以直接让模型用 cron 工具自建。'); return; }
          const lines = rows.map((j) => `${j.name} · ${j.schedule.kind === 'cron' ? `cron ${j.schedule.expr}` : `每 ${Math.round(j.schedule.everyMs / 60000)} 分钟`} · ${j.enabled ? '启用' : '停用'} · id=${j.id.slice(0, 8)}`);
          notice(`当前会话的定时任务：\n${lines.join('\n')}`);
        } catch (e) { notice(`读取定时任务失败：${e instanceof Error ? e.message : String(e)}`); }
        return;
      }
      case 'hooks': {
        try {
          const rows = await listHooks(current?.workspace || undefined);
          if (!rows.enabled) { notice('钩子未开启：设置 AURORAAGENT_EXPERIMENTAL_HOOKS=1 后重启服务'); return; }
          if (!rows.hooks.length) { notice('尚未发现钩子：把脚本命名为 <事件名>.sh 或 <事件名>.mjs 放进数据目录 hooks/ 或工作目录 .auroraagent/hooks/ 即生效'); return; }
          const lines = rows.hooks.map((h) => `${h.event} · ${h.source === 'workspace' ? '项目' : '个人'} · ${h.path}`);
          notice(`已发现的钩子（${rows.hooks.length} 个）：\n${lines.join('\n')}`);
        } catch (e) { notice(`读取钩子失败：${e instanceof Error ? e.message : String(e)}`); }
        return;
      }
      case 'title': {
        const want = arg || (titleMode === 'model' ? 'local' : 'model');
        if (!['local', 'model'].includes(want)) { notice('用法：/title local|model'); return; }
        await changeTitleMode(want);
        notice(`标题生成方式已切换为${want === 'model' ? '模型总结（每个新会话多一次小额请求）' : '本地推导（零成本）'}`);
        return;
      }
      case 'btw': {
        if (!arg) { notice('用法：/btw <问题>（侧边对话，继承当前会话历史，不落盘）'); return; }
        if (!currentId) { notice('当前没有会话：先新建或切换会话再开侧边对话'); return; }
        setSideActive(true);
        await sendSide(arg);
        return;
      }
      case 'plan':
        await changePlan(arg !== 'off');
        notice(`计划模式已${arg === 'off' ? '关闭' : '开启（下一轮先出计划，y 批准后执行）'}`);
        return;
      case 'think': {
        const next = arg === 'off' ? 'off' : 'standard';
        await changeEffort(next);
        notice(`思考过程已${next === 'off' ? '关闭' : '开启'}`);
        return;
      }
      case 'temp': {
        const v = Number(arg);
        if (!arg || Number.isNaN(v) || v < 0 || v > 1) { notice('用法：/temp 0~1（温度需在 0 ~ 1 之间）'); return; }
        try { await saveGeneration({ temperature: v }); notice(`温度 = ${v}（全局，下一轮请求生效）`); }
        catch (e) { toast.error('保存温度失败', { description: e instanceof Error ? e.message : String(e) }); }
        return;
      }
      case 'max': {
        const v = Number(arg);
        if (!arg || !Number.isInteger(v) || v <= 0) { notice('用法：/max <正整数>（单次最大输出）'); return; }
        try { await saveGeneration({ maxTokens: v }); notice(`单次最大输出 = ${v}（全局，下一轮请求生效）`); }
        catch (e) { toast.error('保存最大输出失败', { description: e instanceof Error ? e.message : String(e) }); }
        return;
      }
      case 'key': {
        if (!arg) { notice('用法：/key <ak-xxx>（更新 API Key，全局生效）'); return; }
        try { await saveApiKey(arg); notice('Key 已更新并保存（全局生效）'); }
        catch (e) { toast.error('保存 Key 失败', { description: e instanceof Error ? e.message : String(e) }); }
        return;
      }
      case 'quit':
        notice('网页端无需退出：关掉标签页即可（服务由 LaunchAgent 常驻，设置页可管开机自启）');
        return;
      default:
        // 技能调用：与终端 /<技能名> 同形态，直接把调用文本发给模型
        if (skills.some((sk) => sk.name === name)) {
          if (busy) { notice('正在生成中：请等当前任务结束后再调用技能'); return; }
          send(arg ? `/${name} ${arg}` : `/${name}`);
          return;
        }
        notice(`未知命令：/${name}`);
    }
  };

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

  // 原始创建（删除当前会话后的空列表恢复等内部路径走这里，不受「新会话」守卫约束）
  const createSessionNow = async () => {
    try {
      const s = await createSession({ model: current?.model, harness: current?.harness });
      setSessions((prev) => [s, ...prev]);
      openSession(s.id);
    } catch (e) {
      toast.error('新建会话失败', { description: e instanceof Error ? e.message : String(e) });
    }
  };

  // 新建任务（ZCode NewTaskButtonGroup 语义）：当前会话已是空新会话（无任何轮次且未在生成）时
  // 不再新建——否则每次点击都会在列表顶部再堆一个空会话。按钮禁用 + 快捷键静默无效；
  // 想换模型 / 模式直接在当前新会话里改，想开新话题先发第一条消息。
  const isPristineSession = Boolean(current && current.turns === 0 && !busy);
  const newSession = () => { if (isPristineSession) return; void createSessionNow(); };

  // 后退 / 前进（ZCode taskNav.goBack / goForward）：只移 cursor，目标会话照常打开但不再入栈
  const navGo = useCallback((dir: 'back' | 'forward') => {
    const step = dir === 'back' ? goBack(navHistRef.current) : goForward(navHistRef.current);
    if (!step) return;
    setNavHist(step.history);
    void openSession(step.id, false);
  }, [openSession]);

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
    setNavHist((h) => removeNav(h, id)); // 被删会话的条目摘掉，后退 / 前进不再指向它
    let list: SessionMeta[] = [];
    try { list = await listSessions(); } catch { /* 忽略 */ }
    setSessions(list);
    if (id === currentId) {
      if (list.length) openSession(list[0].id);
      else void createSessionNow();
    }
  };

  /** Header 标题原位重命名（ZCode TaskRenameDialog 语义：PATCH name，失败说清原因） */
  const renameCurrent = async (name: string) => {
    if (!current) return;
    try {
      const meta = await patchSession(current.id, { name });
      setSessions((prev) => prev.map((s) => (s.id === meta.id ? meta : s)));
      toast.success('会话已重命名');
    } catch (e) {
      toast.error('重命名失败', { description: e instanceof Error ? e.message : String(e) });
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

  // 侧栏收回态：偏好只影响本机浏览器（与主题同思路）；Ctrl/Cmd+B 与下方快捷键共用同一状态。
  // 语义对齐 ZCode：收回后左侧边整体消失，只留 WorkspaceHeader 承载入口（不是 56px 图标导轨）。
  const [rail, setRail] = useState(() => { try { return localStorage.getItem('auroraagent.sidebar') === 'rail'; } catch { return false; } });
  useEffect(() => {
    try { localStorage.setItem('auroraagent.sidebar', rail ? 'rail' : 'wide'); } catch { /* 无痕模式等场景下静默 */ }
  }, [rail]);
  const toggleRail = useCallback(() => setRail((v) => !v), []);

  // 顶部浮层（ZCode DesktopTopOverlay）：实测宽度供 Header 收回态让位；非交互容器不吃事件。
  // 浮层自身是 absolute，ref 直接挂它根节点（外包 flex 容器零宽，量不到）
  const overlayRef = useRef<HTMLDivElement>(null);
  const [overlayW, setOverlayW] = useState(0);
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setOverlayW(el.offsetWidth));
    ro.observe(el);
    setOverlayW(el.offsetWidth);
    return () => ro.disconnect();
  }, []);

  // 会话区过窄时自动收回侧栏（ZCode CONVERSATION_AUTO_COLLAPSE_SIDEBAR_WIDTH_PX=360 同款）：
  // 只收不展——自动展开会在拖窗口边缘时来回抖，用户想展开用 Ctrl/Cmd+B 或浮层切换钮
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = mainRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => { if (el.clientWidth > 0 && el.clientWidth < 360) setRail(true); });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 版本更新状态：进页面拉一次（服务端 6 小时缓存，失败静默）；帮助菜单可强制重查
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  useEffect(() => { void checkUpdate().then(setUpdate).catch(() => {}); }, []);
  const checkUpdateNow = useCallback(() => {
    void checkUpdate(true).then((r) => {
      setUpdate(r);
      if (r.updateAvailable) toast.success(`发现新版本 v${r.latest}`, { description: '点击顶部浮层的更新图标前往发布页' });
      else if (!r.error) toast.success('已是最新版本');
      else toast.error('检查更新失败', { description: r.error });
    }).catch(() => toast.error('检查更新失败', { description: '网络异常，稍后再试' }));
  }, []);

  // 键盘快捷键：Ctrl/Cmd+K 新建会话，Ctrl/Cmd+B 切换侧栏收回态，/ 聚焦输入框（焦点不在可输入元素时）。
  // 弹层打开时只保留聚焦输入（其余让位给对话框自身的按键处理）。
  const [focusNonce, setFocusNonce] = useState(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable));
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        if (settingsOpen) return;
        e.preventDefault();
        newSession();
        return;
      }
      // Ctrl/Cmd+[ 后退、Ctrl/Cmd+] 前进（会话导航历史；与 ZCode navigateBack / navigateForward 同键位，
      // 弹层打开时让位给对话框自身的按键处理）
      if ((e.metaKey || e.ctrlKey) && (e.key === '[' || e.key === ']') && !e.shiftKey && !e.altKey) {
        if (settingsOpen) return;
        e.preventDefault();
        navGo(e.key === '[' ? 'back' : 'forward');
        return;
      }
      // Ctrl/Cmd+B 切换侧栏收回态（与 ZCode toggleSidebar 同键位；弹层打开时让位）
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b' && !e.shiftKey && !e.altKey) {
        if (settingsOpen) return;
        e.preventDefault();
        setRail((v) => !v);
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
      {/* 侧栏裁剪容器：收回时宽高归零 + 淡出（ZCode transition-[width,opacity]），
          组件本身不卸载，于是这段 200ms 是「擦除」而不是「消失再出现」 */}
      <div className={`sb-panel${rail ? ' off' : ''}`} aria-hidden={rail || undefined} inert={rail}>
        <ScopedErrorBoundary scope="sidebar" resetKeys={[currentId]}>
          <Sidebar
            sessions={sessions}
            currentId={currentId}
            onSelect={openSession}
            onNew={newSession}
            newDisabled={isPristineSession}
            onDelete={removeSession}
            onFork={forkSessionById}
            onOpenSettings={() => setSettingsOpen(true)}
            loading={booting}
            running={running}
            version={settings?.version || '4.0.0'}
          />
        </ScopedErrorBoundary>
      </div>
      {/* 顶部浮层（ZCode DesktopTopOverlay）：常驻不卸载，盖在侧栏上方 / 收回态浮到最左，
          切换 / 后退 / 前进 / 新建 / 更新入口都在这；自带分区错误边界 */}
      <ScopedErrorBoundary scope="top-overlay" resetKeys={[currentId, rail]} variant="inline">
        <WorkspaceTopOverlay
          ref={overlayRef}
          collapsed={rail}
          onToggle={toggleRail}
          onNew={newSession}
          newDisabled={isPristineSession}
          onBack={() => navGo('back')}
          onForward={() => navGo('forward')}
          canBack={canGoBack(navHist)}
          canForward={canGoForward(navHist)}
          updateUrl={update?.updateAvailable ? update.url : null}
          updateLatest={update?.updateAvailable ? update.latest : null}
        />
      </ScopedErrorBoundary>
      <ScopedErrorBoundary scope="main" resetKeys={[currentId]}>
        <main className="main" ref={mainRef}>
          {/* 工作区 Header（ZCode WorkspaceHeader）：常驻展示工作区上下文 + 会话标题 +
              更多菜单 + 帮助 / 设置；侧栏收回时左侧内距让位给顶部浮层。
              自带分区错误边界——header 崩了不该把整列对话拖下去 */}
          <ScopedErrorBoundary scope="header" resetKeys={[currentId, rail]} variant="inline">
            <WorkspaceHeader
              session={current}
              version={settings?.version || '4.0.0'}
              collapsed={rail}
              overlayInset={overlayW}
              onRename={renameCurrent}
              onFork={() => { if (currentId) void forkSessionById(currentId); }}
              onDelete={() => { if (currentId) void removeSession(currentId); }}
              onOpenSettings={() => setSettingsOpen(true)}
              onCheckUpdate={checkUpdateNow}
            />
          </ScopedErrorBoundary>
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
            onCommand={(name, args) => { handleCommand(name, args).catch(() => {}); }}
            skills={skills}
            sessionId={currentId}
            disabled={!current}
            queue={sideActive ? [] : queue}
            onQueuePromote={(opId) => { void promoteQueue(opId); }}
            onQueueRemove={(opId) => { void removeQueue(opId); }}
            focusNonce={focusNonce}
            pickerNonce={pickerRequest?.nonce}
          />
        </main>
      </ScopedErrorBoundary>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onProvidersChanged={providersChanged}
      />
      <ToastViewport />
    </div>
  );
}
