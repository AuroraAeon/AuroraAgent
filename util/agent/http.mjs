/**
 * Agent HTTP 面：/api/agent/* 路由（会话 CRUD / turn SSE / abort / permission / harnesses）。
 * 从 web.mjs 拆出以守住房「单文件约 500 行」预算——web.mjs 只保留一行委派，
 * 路由语义（平铺、单活跃 turn、SSE 断开即中止）与 /api/chat 完全一致。
 */
import { join } from 'node:path';
import { SessionStore } from './session.mjs';
import { runAgentTurn } from './loop.mjs';
import { getHarness, harnessSummaries } from './harness.mjs';
import { sseFrame } from './events.mjs';
import { GoalStore, GoalConflictError } from './goal/store.mjs';
import { applyUserGoalAction, setUserGoalObjective, clearUserGoal, GOAL_BAD_INPUT_CODES } from './goal/actions.mjs';
import { subscribeGoalEvents, publishGoalEvent } from './goal/bus.mjs';
import { loadSkills, findSkill, skillInvocationText } from './skills.mjs';
import { searchWorkspaceFiles } from './files.mjs';
import { PERMISSION_MODES, TITLE_MODES, experimentalEnabled } from '../config.mjs';
import { McpRegistry } from '../mcp/registry.mjs';

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
 * @param deps { dataDir, usage, resolveChatProvider, loadConfig, pickModel, log, builtinPrice }
 * @returns {(req, res, url) => Promise<void>} 只处理 /api/agent/ 前缀的请求
 */
export function createAgentApi(deps) {
  const { dataDir, usage, resolveChatProvider, loadConfig, pickModel, log = () => {}, builtinPrice } = deps;
  const sessions = new SessionStore(dataDir, { warn: (m, e) => log('warn', m, e) });
  // Goal 存储：<数据目录>/goals/<sessionId>.json（一会话一个目标）
  const goals = new GoalStore(dataDir, { warn: (m, e) => log('warn', m, e) });
  // 技能目录：内置 skills/ + 用户 <数据目录>/skills/（进程启动时加载一次）
  const skills = loadSkills({ userDir: join(dataDir, 'skills') });
  const activeTurns = new Map(); // sessionId -> { controller }
  const pendingPermissions = new Map(); // requestId -> { resolve, sessionId }
  const pendingPlans = new Map(); // sessionId -> { resolve }（计划模式等用户批准 / 驳回）
  // MCP 注册表（实验特性门控）：启用时后台连接已配置服务器并发现工具；单服务器失败不阻塞
  const mcpEnabled = experimentalEnabled('MCP');
  const mcp = mcpEnabled ? new McpRegistry({ dataDir, log: (l, m, e) => log(l, m, e) }) : null;
  const mcpTools = () => (mcp ? mcp.tools.slice() : []);
  if (mcp) mcp.refresh().catch(() => {});

  return async function handleAgentApi(req, res, url) {
    if (req.method === 'GET' && url === '/api/agent/harnesses') {
      return json(res, 200, { harnesses: harnessSummaries(), default: 'standard' });
    }

    if (req.method === 'GET' && url === '/api/agent/skills') {
      return json(res, 200, {
        skills: skills.map(({ name, description, source }) => ({ name, description, source })),
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
      return json(res, 200, { deleted: sessions.remove(sessionMatch[1]) });
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
    const mcpMatch = /^\/api\/mcp\/servers\/([A-Za-z0-9._-]{1,48})(\/probe)?$/.exec(url);
    if (mcpMatch && req.method === 'DELETE') {
      if (!mcp) return json(res, 404, { error: { message: 'MCP 为实验特性：设置 AURORAAGENT_EXPERIMENTAL_MCP=1 开启' } });
      const r = mcp.remove(mcpMatch[1]);
      await mcp.refresh();
      return json(res, 200, { ok: true, removed: r.removed, servers: mcp.status() });
    }
    if (mcpMatch && mcpMatch[2] && req.method === 'POST') {
      if (!mcp) return json(res, 404, { error: { message: 'MCP 为实验特性：设置 AURORAAGENT_EXPERIMENTAL_MCP=1 开启' } });
      const r = await mcp.probe(mcpMatch[1]);
      return json(res, 200, r);
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
      if (activeTurns.has(sessionId)) {
        return json(res, 409, { error: { message: '该会话已有正在进行的任务，请先停止或等待完成' } });
      }
      const raw = String(body.input || '').trim();
      if (!raw) return json(res, 400, { error: { message: '输入不能为空' } });
      // 斜杠技能命令：/<技能名> [参数] → 技能正文注入（与终端同一规则，两端同源单点解析）
      const skillCmd = /^\/([A-Za-z0-9._-]+)[ \t]*([\s\S]*)$/.exec(raw);
      const hit = skillCmd ? findSkill(skills, skillCmd[1]) : null;
      const input = hit ? skillInvocationText(hit, skillCmd[2]) : raw;
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
        : TITLE_MODES.includes(got.meta.titleMode) ? got.meta.titleMode : cfg.titleMode;
      const controller = new AbortController();
      activeTurns.set(sessionId, { controller });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      const emit = (type, payload) => { if (!res.writableEnded) res.write(sseFrame(type, payload)); };
      // 客户端断开即中止上游与工具执行，不浪费额度（与 /api/chat 一致）
      res.on('close', () => {
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
      try {
        await runAgentTurn({
          store: sessions, usage, session: got.meta, input, provider, model, harness,
          builtinPrice, skills,
          gen: { maxTokens: cfg.maxTokens, temperature: cfg.temperature, thinkingOn: body.thinking !== false },
          emit, controller, permissionMode, planMode, titleMode, extraTools: mcpTools(),
          agentProxy: cfg.agentProxy,
          goalStore: goals, goalCfg: cfg.goal,
          requestPermission: ({ requestId }) => new Promise((resolve) => {
            pendingPermissions.set(requestId, { resolve, sessionId });
          }),
          requestPlanDecision: () => new Promise((resolve) => {
            pendingPlans.set(sessionId, { resolve });
          }),
          log: (level, msg, extra) => log(level, msg, extra),
        });
      } catch (err) {
        log('error', 'Agent turn 异常', { sessionId, error: String(err) });
        emit('turn_failed', { sessionId, error: String(err) });
      } finally {
        cleanupPermissions();
        activeTurns.delete(sessionId);
        try { res.end(); } catch {}
      }
      return;
    }

    json(res, 404, { error: { message: 'not found' } });
  };
}
