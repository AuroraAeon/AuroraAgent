/**
 * Agent HTTP 面：/api/agent/* 路由（会话 CRUD / turn SSE / abort / permission / harnesses）。
 * 从 web.mjs 拆出以守住房「单文件约 500 行」预算——web.mjs 只保留一行委派，
 * 路由语义（平铺、单活跃 turn、SSE 断开即中止）与 /api/chat 完全一致。
 */
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { SessionStore } from './session.mjs';
import { runAgentTurn, createModelSteer } from './loop.mjs';
import { getHarness, harnessSummaries } from './harness.mjs';
import { sseFrame } from './events.mjs';
import { GoalStore, GoalConflictError } from './goal/store.mjs';
import { applyUserGoalAction, setUserGoalObjective, clearUserGoal, GOAL_BAD_INPUT_CODES } from './goal/actions.mjs';
import { subscribeGoalEvents, publishGoalEvent } from './goal/bus.mjs';
import { loadSkills, findSkill, skillInvocationText } from './skills.mjs';
import { searchWorkspaceFiles } from './files.mjs';
import { SideSession } from './side-session.mjs';
import { TurnQueue, newOpId } from './queue.mjs';
import { JobStore } from '../jobs/store.mjs';
import { JobScheduler } from '../jobs/schedule.mjs';
import { createCronRuntime } from './cron-tool.mjs';
import { createComputerRuntime } from './computer.mjs';
import { createJobsApi } from '../jobs/http.mjs';
import { subscribeJobEvents, publishJobEvent } from '../jobs/bus.mjs';
import { PERMISSION_MODES, TITLE_MODES, experimentalEnabled } from '../config.mjs';
import { McpRegistry } from '../mcp/registry.mjs';
import { parseFailoverConfig, effectiveTimeouts } from '../llm/failover.mjs';

const SESSION_RE = /^\/api\/agent\/sessions\/([0-9a-f-]{36})$/;
const SESSION_FORK_RE = /^\/api\/agent\/sessions\/([0-9a-f-]{36})\/fork$/;
const GOAL_GET_RE = /^\/api\/agent\/goal\/([0-9a-f-]{36})$/;
const GOAL_ACTION_RE = /^\/api\/agent\/goal\/(pause|resume|stop|budget|edit|clear)$/;
const GOAL_EVENTS_RE = /^\/api\/agent\/events$/;

function readBody(req, limit) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/**
 * @param deps { dataDir, usage, resolveChatProvider, providerStore, loadConfig, pickModel, log, builtinPrice }
 * @returns {(req, res, url) => Promise<void>} 只处理 /api/agent/ 前缀的请求
 */
export function createAgentApi(deps) {
  const { dataDir, usage, resolveChatProvider, providerStore = null, loadConfig, pickModel, log = () => {}, builtinPrice } = deps;
  // 故障转移候选源：全部提供方（内置在前）；挑选时的同模型 / 有 Key / 排除已试 / 队列 / 熔断
  // 过滤都在 llm/failover.mjs 与 llm/circuit.mjs
  const failoverCandidates = providerStore ? () => providerStore.all() : null;
  // 熔断器与运行时状态（failover-state.mjs）：跨 turn 共享才有多请求记忆的意义
  const failoverState = deps.failoverState || null;
  const failoverQueue = providerStore ? () => providerStore.failoverQueueIds() : null;
  const sessions = new SessionStore(dataDir, { warn: (m, e) => log('warn', m, e) });
  // Goal 存储：<数据目录>/goals/<sessionId>.json（一会话一个目标）
  const goals = new GoalStore(dataDir, { warn: (m, e) => log('warn', m, e) });
  // 技能目录：内置 skills/ + 用户 <数据目录>/skills/（进程启动时加载一次）
  const skills = loadSkills({ userDir: join(dataDir, 'skills') });
  const activeTurns = new Map(); // sessionId -> { controller }
  // 消息队列（#3212 / #3220）：活跃 turn 期间的新提交进 FIFO，前一条结算后由泵接力
  const queue = new TurnQueue(dataDir, { warn: (m, e) => log('warn', m, e) });
  // 定时任务（#3149）：jobs.json 在本模块单点持有——cron 工具、/api/jobs REST 面、调度器共享同一个
  // store，否则两处各写一份 jobs.json 会互相覆盖
  const jobs = new JobStore(dataDir, { warn: (m, e) => log('warn', m, e) });
  // cron 工具运行时按会话缓存：工具形状稳定才能命中 toolSchemas 的 schema 缓存（请求字节稳定以吃提示缓存）。
  // sessionId 必须是当次 turn 的会话——模型不显式给 session_id 时任务就落到当前会话
  const cronRuntimes = new Map();
  const cronRuntimeFor = (sessionId) => {
    let rt = cronRuntimes.get(sessionId);
    if (!rt) {
      rt = createCronRuntime(jobs, {
        sessionId,
        // runJob 延迟绑定到 runJobTurn（后者要复用 startTurn，只能后定义）
        runJob: (job) => runJobTurn(job),
        publish: () => publishJobEvent({ jobs: jobs.list() }),
      });
      cronRuntimes.set(sessionId, rt);
    }
    return rt;
  };
  // computer_use 运行时按会话缓存：截图落 <数据目录>/shots/<会话 id>/，删除会话时整目录清掉
  const computerRuntimes = new Map();
  const computerRuntimeFor = (sessionId) => {
    let rt = computerRuntimes.get(sessionId);
    if (!rt) {
      rt = createComputerRuntime({
        shotsDir: join(dataDir, 'shots', sessionId),
        // 截图对外 URL：Web 工具卡缩略图与点击放大都走它（web.mjs 的白名单路由）
        urlBase: `/api/shots/${sessionId}`,
        log: (l, m, e) => log(l, m, e),
      });
      computerRuntimes.set(sessionId, rt);
    }
    return rt;
  };
  /** opId -> 该条排队提交的 SSE 响应（轮到它开跑时由泵接管写入） */
  const waitingStreams = new Map();
  // 侧边对话（/btw）：mainSessionId -> SideSession 内存门面（继承主会话 meta 快照 + 自洽历史前缀）。
  // 不落盘、不进 /sessions、不接管 goal、不派发子代理（SideSession.create 抛错），主会话存储零污染
  const sides = new Map();
  const sideStoreFor = (sessionId, meta) => {
    let side = sides.get(sessionId);
    if (!side) {
      side = new SideSession(meta, { prefix: sessions.records(sessionId) });
      sides.set(sessionId, side);
    }
    return side;
  };
  const pendingPermissions = new Map(); // requestId -> { resolve, sessionId }
  const pendingPlans = new Map(); // sessionId -> { resolve }（计划模式等用户批准 / 驳回）
  // MCP 注册表（实验特性门控）：启用时后台连接已配置服务器并发现工具；单服务器失败不阻塞
  const mcpEnabled = experimentalEnabled('MCP');
  const mcp = mcpEnabled ? new McpRegistry({ dataDir, log: (l, m, e) => log(l, m, e) }) : null;
  const mcpTools = () => (mcp ? mcp.tools.slice() : []);
  if (mcp) mcp.refresh().catch(() => {});

  /** 队列变更广播：给该会话所有排队流推一条 turn_queued（位置 / 内容刷新），客户端据此重画队列条 */
  const publishQueue = (sessionId) => {
    const items = queue.list(sessionId).filter((i) => i.state !== 'running');
    for (const item of items) {
      const stream = waitingStreams.get(item.opId);
      if (stream && !stream.writableEnded) {
        stream.write(sseFrame('turn_queued', { sessionId, opId: item.opId, position: items.indexOf(item) + 1, input: item.text }));
      }
    }
  };

  /** 泵：前一条 turn 结算后接力下一条。activeTurns 已删除——若此时又有新 turn 抢跑，直接让位 */
  const pumpNext = (sessionId) => {
    if (activeTurns.has(sessionId)) return;
    const next = queue.shift(sessionId);
    if (!next) return;
    const got = sessions.get(sessionId);
    if (!got) { queue.finish(sessionId, next.opId, 'failed'); return; }
    const stream = waitingStreams.get(next.opId);
    waitingStreams.delete(next.opId);
    // 无人认领（客户端早就断开）也要跑完：用户确实发了这条，只是不看结果了
    if (!stream || stream.writableEnded) { void startTurn(sessionId, got, next.body, null, next.text); return; }
    void startTurn(sessionId, got, next.body, stream, next.text);
  };

  /**
   * 本轮请求的额外工具：MCP 工具 + cron 定时任务工具。
   * 都按 harness.tools 门控（tools.mjs 的 pickTools 只收 names 里的名字），minimal 自然收不进来。
   */
  const extraToolsFor = (harness, side, sessionId) => {
    const extra = mcpTools();
    // 侧边对话不派发子代理、不接管 goal，同样不给有持久副作用的定时任务工具与屏幕操作
    if (!side) {
      extra.push(...cronRuntimeFor(sessionId).tools);
      // computer_use 经 harness.tools 门控（仅 ultimate）；pickTools 自然把其余模式滤掉
      extra.push(computerRuntimeFor(sessionId));
    }
    return extra;
  };

  /**
   * 起跑一条 turn（直接提交或队列泵接力共用）。
   * res 为 null 表示无人认领的流（排队期间客户端断开）：照常执行，事件丢弃。
   */
  /**
   * 起跑一条 turn（直接提交或队列泵接力共用）。
   * res 为 null 表示无人认领的流（排队期间客户端断开）：照常执行，事件丢弃。
   */
  const startTurn = async (sessionId, got, body, res, raw) => {
    // side=true 跑侧边对话：store 换内存门面、goalStore 置空（goal 工具自然摘除）；
    // activeTurns 仍按 sessionId 键控，主 / 侧互斥（与终端 busy 语义一致）
    const side = body.side === true;
    const store = side ? sideStoreFor(sessionId, got.meta) : sessions;
    const sessionMeta = side ? store.meta : got.meta;
    // 斜杠技能命令：/<技能名> [参数] → 技能正文注入（与终端同一规则，两端同源单点解析）
    const skillCmd = /^\/([A-Za-z0-9._-]+)[ \t]*([\s\S]*)$/.exec(raw);
    const hit = skillCmd ? findSkill(skills, skillCmd[1]) : null;
    const input = hit ? skillInvocationText(hit, skillCmd[2]) : raw;
    const inputSkill = hit ? hit.name : ''; // 供 Loop 标记用户记录（压缩期保护技能规范）
    const cfg = loadConfig();
    const model = pickModel(body.model, got.meta.model || cfg.model);
    const provider = resolveChatProvider(body.provider || got.meta.provider, model);
    const harness = getHarness(got.meta.harness);
    // 权限三档 / 计划模式优先级：请求体 > 会话 meta > 全局配置（缺省等价现状）
    const permissionMode = PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode
      : PERMISSION_MODES.includes(got.meta.permissionMode) ? got.meta.permissionMode : cfg.permissionMode;
    const planMode = body.planMode !== undefined ? body.planMode === true
      : got.meta.planMode !== undefined ? got.meta.planMode === true : cfg.planMode === true;
    const titleMode = TITLE_MODES.includes(body.titleMode) ? body.titleMode
      : got.meta.titleMode !== undefined ? got.meta.titleMode : cfg.titleMode;
    const controller = new AbortController();
    // 用户中途发言（steering）：Loop 每轮把模型流中断器绑到它身上，HTTP 面在活跃 turn
    // 收到新提交时 request()——只断当前模型流，不杀在跑工具（loop.mjs 的 createModelSteer）
    const modelSteer = createModelSteer();
    activeTurns.set(sessionId, { controller, side, modelSteer });
    // 队列接力的流已在入队回执里写过头部，只能写一次（重复 writeHead 会抛 HEADERS_SENT）
    if (res && !res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
    const emit = (type, payload) => { if (res && !res.writableEnded) res.write(sseFrame(type, payload)); };
    // 定时任务变更信号：本轮经 cron 工具改了任务，客户端即时收到 jobs_changed 重读列表
    const unsubJobs = subscribeJobEvents((_frame, payload) => emit('jobs_changed', { sessionId: String(payload?.sessionId || '') }));
    // 客户端断开即中止上游与工具执行，不浪费额度（与 /api/chat 一致）
    if (res) res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort(new Error('客户端断开连接'));
        log('info', 'Agent 客户端断开，已中止', { sessionId });
      }
    });
    const cleanupPermissions = () => {
      for (const [id, p] of pendingPermissions) {
        if (p.sessionId === sessionId) { pendingPermissions.delete(id); p.resolve('deny'); }
      }
      const waiting = pendingPlans.get(sessionId);
      if (waiting) { pendingPlans.delete(sessionId); waiting.resolve('reject'); }
    };
    // 队列接力的项带回自己的 opId，结算时按终态剪掉（跑完即从队列视图消失）
    const opId = String(body.opId || '').trim();
    let turnFailed = false;
    try {
      await runAgentTurn({
        store, usage, session: sessionMeta, input, inputSkill, provider, model, harness,
        builtinPrice, skills,
        gen: { maxTokens: cfg.maxTokens, temperature: cfg.temperature, thinkingOn: body.thinking !== false },
        emit, controller, permissionMode, planMode, titleMode, extraTools: extraToolsFor(harness, side, sessionId),
        agentProxy: cfg.agentProxy,
        ignoreEnabled: cfg.ignore?.enabled !== false, sanitizeChildEnv: cfg.sanitizeChildEnv !== false,
        providerFailover: cfg.providerFailover, providerFailoverMaxAttempts: cfg.providerFailoverMaxAttempts,
        failoverCandidates,
        failoverState,
        // 生效超时：故障转移关闭时归零（effectiveTimeouts 单点保证），关闭即完全回到老行为
        failoverTimeouts: effectiveTimeouts(parseFailoverConfig(cfg, {})),
        failoverQueue,
        modelSteer,
        goalStore: side ? null : goals, goalCfg: cfg.goal,
        requestPermission: ({ requestId }) => new Promise((resolve) => {
          pendingPermissions.set(requestId, { resolve, sessionId });
        }),
        requestPlanDecision: () => new Promise((resolve) => {
          pendingPlans.set(sessionId, { resolve });
        }),
        log: (level, msg, extra) => log(level, msg, extra),
      });
    } catch (err) {
      turnFailed = true;
      log('error', 'Agent turn 异常', { sessionId, error: String(err) });
      emit('turn_failed', { sessionId, error: String(err) });
    } finally {
      unsubJobs();
      cleanupPermissions();
      // 中途发言未被本轮消化（计划驳回 / 异常收尾 / 恰好赶在收尾之后）：还回队列由泵接力，
      // 绝不吞掉用户已经发出来的消息
      const leftover = modelSteer.take();
      if (leftover) {
        queue.enqueue(sessionId, { opId: newOpId(), text: leftover, body: { input: leftover } });
        log('info', '中途发言未被本轮消化，已还回队列', { sessionId });
      }
      activeTurns.delete(sessionId);
      if (opId && queue.find(sessionId, opId)) queue.finish(sessionId, opId, turnFailed ? 'failed' : 'done');
      // 队列接力：先让出 activeTurns，再摘牌下一条（!has 的二次判断防延迟清理吞掉新工作）
      pumpNext(sessionId);
      try { if (res) res.end(); } catch {}
    }
  };

  /**
   * 定时任务到期执行器：在目标会话跑一条注入式 turn（prompt 作为用户消息）。
   * 没有 SSE 认领方（res=null）——任务是用户早先设的，到期时没人在看；事件丢弃，账本照记。
   */
  const runJobTurn = async (job) => {
    const sid = String(job.sessionId || '');
    const got = sessions.get(sid);
    if (!got) throw new Error(`目标会话不存在或已删除：${sid}`);
    // 会话正忙：入队由泵接力。队列本就是为「生成中又来一条」设计的，定时任务与用户消息同权
    if (activeTurns.has(sid)) {
      queue.enqueue(sid, { opId: newOpId(), text: job.prompt, body: { input: job.prompt } });
      log('info', '定时任务到期但会话正忙，已入队等待', { jobId: job.id, sessionId: sid });
      return;
    }
    await startTurn(sid, got, { input: job.prompt }, null, job.prompt);
  };

  // 调度器：进程内 1s ticker + jobs.lock 单实例 owner 锁（端口交接期两实例短暂共存也不双跑）
  const scheduler = new JobScheduler(jobs, runJobTurn, { dataDir, log: (l, m, e) => log(l, m, e) });
  // /api/jobs REST 面与 jobs_changed 长连接（实现拆在 util/jobs/http.mjs）：store 与执行器由本模块注入
  const jobsApi = createJobsApi({ jobs, log: (l, m, e) => log(l, m, e), runJob: runJobTurn });

  const handle = async function handleAgentApi(req, res, url) {
    // 定时任务 REST 面与 jobs_changed 长连接（/api/jobs，实现见 util/jobs/http.mjs）
    if (url.startsWith('/api/jobs') && (await jobsApi(req, res, url))) return;

    if (req.method === 'GET' && url === '/api/agent/harnesses') {
      return json(res, 200, { harnesses: harnessSummaries(), default: 'standard' });
    }

    if (req.method === 'GET' && url === '/api/agent/skills') {
      return json(res, 200, {
        // L1 目录 + L3 资源索引：正文仍按需加载，这里只给元数据与附属文件名
        skills: skills.map((s) => ({
          name: s.name, description: s.description, source: s.source,
          resources: s.files.map((f) => f.path),
          implicit: s.implicit,
          compatibility: s.compatibility,
          allowedTools: s.allowedTools,
          bodyLines: s.bodyLines,
          warnings: s.warnings,
        })),
      });
    }

    if (req.method === 'POST' && url === '/api/agent/sessions') {
      const body = await readBody(req, 1024 * 1024);
      const cfg = loadConfig();
      const model = pickModel(body.model, cfg.model || '');
      const provider = resolveChatProvider(body.provider, model);
      const harness = getHarness(body.harness);
      const meta = sessions.create({
        name: String(body.name || '').slice(0, 60),
        model,
        provider: provider.id,
        harness: harness.id,
        workspace: String(body.workspace || ''),
        permissionMode: PERMISSION_MODES.includes(body.permissionMode) ? body.permissionMode : '',
        planMode: body.planMode === true,
        titleMode: TITLE_MODES.includes(body.titleMode) ? body.titleMode : cfg.titleMode,
        thinking: typeof body.thinking === 'boolean' ? body.thinking : cfg.thinking,
      });
      log('info', 'Agent 会话已创建', { sessionId: meta.id, harness: harness.id });
      return json(res, 200, { session: meta });
    }

    if (req.method === 'GET' && url === '/api/agent/sessions') {
      const rows = sessions.list().map((m) => {
        const records = sessions.records(m.id);
        const lastUser = [...records].reverse().find((r) => r.t === 'user');
        return { ...m, preview: lastUser ? String(lastUser.text || '').slice(0, 80) : '' };
      });
      return json(res, 200, { sessions: rows });
    }

    const sessionMatch = SESSION_RE.exec(url);
    if (sessionMatch && req.method === 'GET') {
      const got = sessions.get(sessionMatch[1]);
      if (!got) return json(res, 404, { error: { message: '会话不存在或已删除' } });
      return json(res, 200, got);
    }
    if (sessionMatch && req.method === 'DELETE') {
      const deleted = sessions.remove(sessionMatch[1]);
      sides.delete(sessionMatch[1]); // 会话没了，侧边对话随之作废（防进程内驻留增长）
      // computer_use 截图随会话一起清（shots/<会话 id>/），别让数据目录无限涨
      computerRuntimes.delete(sessionMatch[1]);
      rmSync(join(dataDir, 'shots', sessionMatch[1]), { recursive: true, force: true });
      return json(res, 200, { deleted });
    }
    // 切换模式 / 改名 / 换模型：下一轮 turn 生效（进行中的 turn 不受影响）
    if (sessionMatch && req.method === 'PATCH') {
      const body = await readBody(req, 64 * 1024);
      if (!sessions.get(sessionMatch[1])) return json(res, 404, { error: { message: '会话不存在或已删除' } });
      const changes = {};
      if (body.name !== undefined) changes.name = String(body.name || '').slice(0, 60) || '新会话';
      if (body.harness !== undefined) {
        const want = String(body.harness || '');
        if (getHarness(want).id !== want) {
          return json(res, 400, { error: { message: `未知模式：${want}（可用 minimal / standard / ultimate）` } });
        }
        changes.harness = want;
      }
      if (body.permissionMode !== undefined) {
        if (!PERMISSION_MODES.includes(body.permissionMode)) {
          return json(res, 400, { error: { message: `未知权限模式：${body.permissionMode}（可用 always_ask / ask_when_needed / never_ask）` } });
        }
        changes.permissionMode = body.permissionMode;
      }
      if (body.planMode !== undefined) changes.planMode = body.planMode === true;
      if (body.thinking !== undefined) changes.thinking = body.thinking === true;
      if (body.titleMode !== undefined) {
        if (!TITLE_MODES.includes(body.titleMode)) {
          return json(res, 400, { error: { message: `未知标题生成方式：${body.titleMode}（可用 local / model）` } });
        }
        changes.titleMode = body.titleMode;
      }
      if (body.provider !== undefined) {
        const pid = String(body.provider || '');
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(pid)) return json(res, 400, { error: { message: '提供方 ID 不合法' } });
        changes.provider = pid;
      }
      if (body.model !== undefined) {
        const model = pickModel(body.model, '');
        if (!model) return json(res, 400, { error: { message: '模型 ID 不合法：只能用字母、数字与 . _ : -，最长 80 字符' } });
        changes.model = model;
      }
      if (!Object.keys(changes).length) {
        return json(res, 400, { error: { message: '没有可更新的字段（name / harness / model / provider / permissionMode / planMode / titleMode）' } });
      }
      log('info', 'Agent 会话已更新', { sessionId: sessionMatch[1], changes: Object.keys(changes) });
      return json(res, 200, { meta: sessions.patch(sessionMatch[1], changes) });
    }

    // 派生会话：复制 meta + 转录到新会话（新 id / 新时间戳），源会话只读不动
    if (req.method === 'POST' && SESSION_FORK_RE.test(url)) {
      const meta = sessions.fork(SESSION_FORK_RE.exec(url)[1]);
      if (!meta) return json(res, 404, { error: { message: '会话不存在或已删除' } });
      log('info', 'Agent 会话已派生', { from: SESSION_FORK_RE.exec(url)[1], sessionId: meta.id });
      return json(res, 200, { session: meta });
    }

    if (req.method === 'POST' && url === '/api/agent/abort') {
      const body = await readBody(req, 64 * 1024);
      const entry = activeTurns.get(String(body.sessionId || ''));
      if (!entry) return json(res, 200, { aborted: false, reason: '该会话没有正在进行的任务' });
      entry.controller.abort(new Error('用户点击了停止按钮'));
      log('info', '已收到 Agent 停止请求', { sessionId: body.sessionId });
      return json(res, 200, { aborted: true });
    }

    if (req.method === 'POST' && url === '/api/agent/permission') {
      const body = await readBody(req, 64 * 1024);
      const requestId = String(body.requestId || '');
      const pending = pendingPermissions.get(requestId);
      if (!pending) return json(res, 200, { ok: false, reason: '没有等待中的权限请求（可能已超时或已处理）' });
      pendingPermissions.delete(requestId);
      pending.resolve(body.decision === 'always' ? 'always' : body.decision === 'allow' ? 'allow' : 'deny');
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url === '/api/agent/plan') {
      const body = await readBody(req, 64 * 1024);
      const pending = pendingPlans.get(String(body.sessionId || ''));
      if (!pending) return json(res, 200, { ok: false, reason: '没有等待中的计划请求（可能已超时或已处理）' });
      pendingPlans.delete(String(body.sessionId || ''));
      pending.resolve(body.decision === 'approve' ? 'approve' : 'reject');
      return json(res, 200, { ok: true });
    }

    // ---------- 侧边对话 REST 面（/btw）：查转录 + 丢弃 ----------
    // GET：turn 结束后前端凭它重投影侧边消息（投影与主会话同源）；POST discard 幂等
    const sideMatch = /^\/api\/agent\/side\/([0-9a-f-]{36})$/.exec(url);
    if (sideMatch && req.method === 'GET') {
      const side = sides.get(sideMatch[1]);
      if (!side) return json(res, 404, { error: { message: '当前会话没有侧边对话' } });
      return json(res, 200, { records: side.records() });
    }
    if (req.method === 'POST' && url === '/api/agent/side/discard') {
      const body = await readBody(req, 64 * 1024);
      const sid = String(body.sessionId || '');
      const dropped = sides.delete(sid);
      log('info', '侧边对话已丢弃', { sessionId: sid, dropped });
      return json(res, 200, { ok: true, discarded: dropped });
    }

    if (url === '/api/mcp/servers' && req.method === 'GET') {
      if (!mcp) return json(res, 404, { error: { message: 'MCP 为实验特性：设置 AURORAAGENT_EXPERIMENTAL_MCP=1 开启' } });
      return json(res, 200, { servers: mcp.status() });
    }
    if (url === '/api/mcp/servers' && req.method === 'POST') {
      if (!mcp) return json(res, 404, { error: { message: 'MCP 为实验特性：设置 AURORAAGENT_EXPERIMENTAL_MCP=1 开启' } });
      const body = await readBody(req, 256 * 1024);
      const r = mcp.upsert(body);
      if (!r.ok) return json(res, 400, { error: { message: '服务器配置不合法', fields: r.errors } });
      await mcp.refresh();
      log('info', 'MCP 服务器已保存', { id: r.server.id });
      return json(res, 200, { ok: true, server: r.server, servers: mcp.status() });
    }
    const mcpMatch = /^\/api\/mcp\/servers\/([A-Za-z0-9._-]{1,48})(\/probe|\/enabled)?$/.exec(url);
    if (mcpMatch && req.method === 'DELETE') {
      if (!mcp) return json(res, 404, { error: { message: 'MCP 为实验特性：设置 AURORAAGENT_EXPERIMENTAL_MCP=1 开启' } });
      const r = mcp.remove(mcpMatch[1]);
      await mcp.refresh();
      return json(res, 200, { ok: true, removed: r.removed, servers: mcp.status() });
    }
    if (mcpMatch && mcpMatch[2] === '/probe' && req.method === 'POST') {
      if (!mcp) return json(res, 404, { error: { message: 'MCP 为实验特性：设置 AURORAAGENT_EXPERIMENTAL_MCP=1 开启' } });
      const r = await mcp.probe(mcpMatch[1]);
      return json(res, 200, r);
    }
    // 显示开关：停用即从工具箱摘掉（refresh 跳过连接），配置不动
    if (mcpMatch && mcpMatch[2] === '/enabled' && req.method === 'POST') {
      if (!mcp) return json(res, 404, { error: { message: 'MCP 为实验特性：设置 AURORAAGENT_EXPERIMENTAL_MCP=1 开启' } });
      const body = await readBody(req, 1024);
      if (typeof body.enabled !== 'boolean') return json(res, 400, { error: { message: 'enabled 必须是布尔值' } });
      const r = mcp.setEnabled(mcpMatch[1], body.enabled);
      if (!r.ok) return json(res, 404, { error: { message: r.error } });
      await mcp.refresh();
      log('info', body.enabled ? 'MCP 服务器已启用' : 'MCP 服务器已停用', { id: r.server.id });
      return json(res, 200, { ok: true, server: r.server, servers: mcp.status() });
    }    // ---------- Goal REST 面：一会话一目标；用户操作的优先级永远高于模型提案 ----------
    // GET 走路径带 sessionId（web.mjs 委派时已剥掉 query）；POST 与 turn 一致从 body 取
    // 输入区 @ 提及：只读工作目录内文件名搜索（web.mjs 委派时已剥 query，这里从 req.url 解析）
    if (req.method === 'GET' && url === '/api/files/search') {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      const got = sessions.get(String(qs.get('sessionId') || ''));
      if (!got) return json(res, 404, { error: { message: '会话不存在或已删除' } });
      return json(res, 200, { files: searchWorkspaceFiles(got.meta.workspace, qs.get('q') || '') });
    }
    // 跨客户端 goal 事件流：另一客户端经 REST 改动目标时，订阅方即时收到同一批事件
    // （对齐 MiniMax 全局事件投影；turn 内的 goal 事件仍走 turn SSE，不经此处）
    if (GOAL_EVENTS_RE.test(url) && req.method === 'GET') {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      const sessionId = String(qs.get('sessionId') || '');
      if (!sessions.get(sessionId)) return json(res, 404, { error: { message: '会话不存在或已删除' } });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      // 订阅即写一条 SSE 注释冲掉响应头：否则无事件时头部滞留，客户端 fetch 永远等不到 headers
      res.write(': goal-event-stream connected\n\n');
      const unsubscribe = subscribeGoalEvents(sessionId, (frame) => { if (!res.writableEnded) res.write(frame); });
      // 连接关闭必须无条件退订：SSE 流本就不主动 end，泄漏的订阅会随会话累积
      res.on('close', () => unsubscribe());
      return;
    }
    const goalGetMatch = GOAL_GET_RE.exec(url);
    if (goalGetMatch && req.method === 'GET') {
      if (!sessions.get(goalGetMatch[1])) return json(res, 404, { error: { message: '会话不存在或已删除' } });
      return json(res, 200, { goal: goals.get(goalGetMatch[1]) });
    }
    if (req.method === 'POST' && url === '/api/agent/goal') {
      const body = await readBody(req, 64 * 1024);
      const sessionId = String(body.sessionId || '');
      if (!sessions.get(sessionId)) return json(res, 404, { error: { message: '会话不存在或已删除' } });
      const objective = String(body.objective || '').trim();
      if (!objective) return json(res, 400, { error: { message: '目标内容不能为空' } });
      try {
        const goal = goals.create(sessionId, {
          objective,
          tokenBudget: Number.isInteger(body.tokenBudget) && body.tokenBudget > 0 ? body.tokenBudget : null,
        });
        log('info', 'Goal 已创建', { sessionId, goalId: goal.goalId });
        publishGoalEvent(sessionId, 'goal_created', { goal });
        return json(res, 200, { goal });
      } catch (e) {
        if (e instanceof GoalConflictError) return json(res, 409, { error: { message: e.message, code: e.code } });
        throw e;
      }
    }
    const goalActionMatch = GOAL_ACTION_RE.exec(url);
    if (goalActionMatch && req.method === 'POST') {
      const body = await readBody(req, 64 * 1024);
      const sessionId = String(body.sessionId || '');
      if (!sessions.get(sessionId)) return json(res, 404, { error: { message: '会话不存在或已删除' } });
      const action = goalActionMatch[1];
      // clear 是幂等移除（没有目标时 cleared=false），不走状态迁移、不受无目标 404 门限制
      if (action === 'clear') {
        const { cleared } = clearUserGoal(goals, sessionId);
        log('info', 'Goal 已移除', { sessionId, cleared });
        if (cleared) publishGoalEvent(sessionId, 'goal_cleared', {});
        return json(res, 200, { cleared });
      }
      const cur = goals.get(sessionId);
      if (!cur) return json(res, 404, { error: { message: '当前会话没有目标', code: 'GOAL_NOT_FOUND' } });
      // 纪元门在 HTTP 层：goalId 与 updatedAt 都必须来自一次新鲜的 get_goal 快照。
      // budget 路由与「edit 随文携带 tokenBudget」（/goal <目标> budget=50K）同规约
      const touchesBudget = action === 'budget' || (action === 'edit' && body.tokenBudget !== undefined);
      if (touchesBudget) {
        const tb = body.tokenBudget === null ? null : body.tokenBudget;
        if (tb !== null && (!Number.isInteger(tb) || tb <= 0)) return json(res, 400, { error: { message: 'tokenBudget 需为正整数或 null（清除上限）' } });
        if (String(body.expectedGoalId || '') !== cur.goalId || !Number.isInteger(body.expectedUpdatedAt)) {
          return json(res, 409, { error: { message: '预算变更需要新鲜的 get_goal 快照（expectedGoalId + expectedUpdatedAt）', code: 'GOAL_STALE' } });
        }
      }
      try {
        const goal = applyUserGoalAction(goals, sessionId, action, { tokenBudget: body.tokenBudget, expectedUpdatedAt: body.expectedUpdatedAt, objective: body.objective });
        log('info', `Goal 操作 ${action}`, { sessionId });
        // 与 runtime.emitStatus 同载荷形状：订阅方按 goal 快照整体校正（含 edit 的文本变更）
        publishGoalEvent(sessionId, 'goal_status_changed', { goal, statusReason: goal.statusReason, lastVerification: goal.lastVerification });
        return json(res, 200, { goal });
      } catch (e) {
        // 坏入参（预算非法 / 未知操作）映射 400；状态冲突与纪元不符映射 409
        if (e instanceof GoalConflictError) {
          const status = GOAL_BAD_INPUT_CODES.includes(e.code) ? 400 : 409;
          return json(res, status, { error: { message: e.message, code: e.code } });
        }
        throw e;
      }
    }

    if (req.method === 'POST' && url === '/api/agent/turn') {
      const body = await readBody(req, 10 * 1024 * 1024);
      const sessionId = String(body.sessionId || '');
      const got = sessions.get(sessionId);
      if (!got) return json(res, 404, { error: { message: '会话不存在或已删除' } });
      const raw = String(body.input || '').trim();
      if (!raw) return json(res, 400, { error: { message: '输入不能为空' } });
      // 主 / 侧互斥不因队列松动：任一侧有活跃 turn，对侧提交一律 409（与终端 busy 语义一致）
      const active = activeTurns.get(sessionId);
      if (active && (body.side === true || active.side)) {
        return json(res, 409, { error: { message: '该会话已有正在进行的任务，请先停止或等待完成' } });
      }
      // side=true 跑侧边对话：不落盘、不接管 goal，也不入队
      if (body.side === true) return startTurn(sessionId, got, body, res, raw);
      // 活跃主 turn 期间的新提交：入队等待，前一条结算后由泵自动接力（不再 409 挡人）
      if (active) {
        const opId = String(body.opId || '').trim() || newOpId();
        const receipt = queue.enqueue(sessionId, { opId, text: raw, body: { ...body, input: raw, opId } });
        if (!receipt) return json(res, 400, { error: { message: '输入不能为空' } });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
        // 重复 opId：同一回执原样返回，不开第二条流、不重复执行
        const emit = (type, payload) => { if (!res.writableEnded) res.write(sseFrame(type, payload)); };
        emit('turn_queued', { sessionId, opId: receipt.item.opId, position: receipt.position, input: raw, duplicate: receipt.duplicate });
        if (receipt.duplicate) { try { res.end(); } catch {} return; }
        // 用户中途发言（steering）：这条消息并入正在跑的 turn（中断当前模型流、保留已生成内容），
        // 队列项随即被吸收——泵不会再单独跑它一轮，用户也不必等当前任务结束就能纠偏
        if (active.modelSteer?.request(raw)) {
          queue.remove(sessionId, receipt.item.opId);
          emit('turn_steered', { sessionId, opId: receipt.item.opId, input: raw });
          try { res.end(); } catch {}
          publishQueue(sessionId);
          log('info', '用户中途发言，已并入当前 turn', { sessionId, opId: receipt.item.opId });
          return;
        }
        waitingStreams.set(receipt.item.opId, res);
        // 客户端断开：还在排队（未开跑）就摘掉，别让无人认领的流占着队列
        res.on('close', () => {
          waitingStreams.delete(receipt.item.opId);
          const item = queue.find(sessionId, receipt.item.opId);
          if (item && item.state === 'queued') { queue.remove(sessionId, receipt.item.opId); publishQueue(sessionId); }
        });
        publishQueue(sessionId);
        log('info', 'Agent 消息已入队', { sessionId, opId: receipt.item.opId, position: receipt.position });
        return;
      }
      return startTurn(sessionId, got, body, res, raw);
    }

    if (req.method === 'GET' && /^\/api\/agent\/queue\/[0-9a-f-]{36}$/.test(url)) {
      const sessionId = url.slice('/api/agent/queue/'.length);
      if (!sessions.get(sessionId)) return json(res, 404, { error: { message: '会话不存在或已删除' } });
      return json(res, 200, { sessionId, items: queue.list(sessionId) });
    }

    if (req.method === 'POST' && url === '/api/agent/queue/promote') {
      const body = await readBody(req, 64 * 1024);
      const sessionId = String(body.sessionId || '');
      if (!sessions.get(sessionId)) return json(res, 404, { error: { message: '会话不存在或已删除' } });
      const item = queue.promote(sessionId, String(body.opId || ''));
      if (!item) return json(res, 404, { error: { message: '队列里没有这一条' } });
      publishQueue(sessionId);
      return json(res, 200, { ok: true, item });
    }

    if (req.method === 'POST' && url === '/api/agent/queue/remove') {
      const body = await readBody(req, 64 * 1024);
      const sessionId = String(body.sessionId || '');
      if (!sessions.get(sessionId)) return json(res, 404, { error: { message: '会话不存在或已删除' } });
      const item = queue.find(sessionId, String(body.opId || ''));
      if (!item) return json(res, 404, { error: { message: '队列里没有这一条' } });
      // 已在跑的那条不给远端删：删了就没有流能收它的结果，只能走停止
      if (item.state === 'running') return json(res, 409, { error: { message: '这一条已经在执行，请改用停止' } });
      const stream = waitingStreams.get(item.opId);
      if (stream && !stream.writableEnded) {
        stream.write(sseFrame('turn_cancelled', { sessionId, opId: item.opId, reason: 'removed' }));
        try { stream.end(); } catch {}
      }
      waitingStreams.delete(item.opId);
      queue.remove(sessionId, item.opId);
      publishQueue(sessionId);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: { message: 'not found' } });
  };
  // 调度器与 store 挂在外壳上给 web.mjs：启停时点是服务生命周期的事，不该由某次请求顺带触发
  handle.jobs = jobs;
  handle.runJob = runJobTurn;
  handle.scheduler = scheduler;
  return handle;
}
