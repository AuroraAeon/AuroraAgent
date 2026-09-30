/**
 * API 响应形状归一化（零依赖纯函数，Node 测试直接 import 同一份）：
 *  设置页「技能」分区曾因后端进程旧于前端产物（LaunchAgent 常驻、public/app/ 按请求读盘），
 *  `/api/agent/skills` 只回旧形状 {name, description, source}，前端零容差解引用
 *  `s.allowedTools.length` 直接把整站打进错误边界。同类崩点遍布其余设置面板与常驻列表：
 *  会话 / 模型目录 / 模式 / 用量 / 错误日志 / MCP / 故障转移 / 提供方 / TUI / 文件搜索。
 *  这里在 api.ts 边界把每个响应当规整成声明形状：必填字段缺安全默认值，集合字段保证是数组，
 *  可选字段类型不对落回 undefined（不伪造值）；未知扩展字段原样保留（向前兼容）。
 *  规整只「补缺」不「置空」——后端返回正确形状时是恒等映射，测试对此有深等于断言。
 */
import { asArray, asBool, asCount, asNumber, asObject, asOptionalNumber, asString, asStringArray } from './coerce.mjs';

/**
 * 行级规整公共形：保留未知字段；patch 给出的键一律以规整值为准——
 * 值为 undefined 表示「该键确保缺席」（原始值类型不对时不残留），
 * 因而正确形状过一遍是恒等映射（原值是什么就还是什么），畸形值被清掉。
 */
const row = (raw, patch) => {
  const out = { ...asObject(raw), ...patch };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete out[k];
  return out;
};

/** 行列表规整：非对象行（null / 数字 / 字符串）先剔除，再逐行补缺 */
const rows = (raw, patch) => asArray(raw).filter((r) => r && typeof r === 'object').map((r) => row(r, typeof patch === 'function' ? patch(r) : patch));

/** 模型目录行（ModelInfo）：id / provider 必填，其余可选（可选字段类型不对落回 undefined，不伪造 0） */
export function normalizeModelRows(raw) {
  return rows(raw, (m) => ({
    id: asString(m?.id),
    provider: asString(m?.provider),
    name: typeof m?.name === 'string' ? m.name : undefined,
    tag: typeof m?.tag === 'string' ? m.tag : undefined,
    providerName: typeof m?.providerName === 'string' ? m.providerName : undefined,
    contextWindow: asOptionalNumber(m?.contextWindow),
    maxTokens: asOptionalNumber(m?.maxTokens),
  }));
}

/** 提供方行（ProviderRow） */
export function normalizeProviderRows(raw) {
  return rows(raw, (p) => ({
    id: asString(p?.id),
    name: asString(p?.name),
    protocol: asString(p?.protocol),
    baseUrl: asString(p?.baseUrl),
    pathPrefix: typeof p?.pathPrefix === 'string' ? p.pathPrefix : undefined,
    builtin: asBool(p?.builtin, false),
    hasKey: asBool(p?.hasKey, false),
    model: asString(p?.model),
    models: normalizeModelRows(p?.models),
    price: p?.price && typeof p.price === 'object'
      ? { ...p.price, input: asOptionalNumber(p.price.input), output: asOptionalNumber(p.price.output) }
      : undefined,
    failoverIndex: asOptionalNumber(p?.failoverIndex),
  }));
}

/** 提供方预设目录行（CatalogProvider）：端点与模型保证是数组，协议门控标记保证是布尔 */
export function normalizeCatalogProviders(raw) {
  return rows(raw, (p) => ({
    id: asString(p?.id),
    name: asString(p?.name),
    description: asString(p?.description),
    endpoints: asArray(p?.endpoints).filter((e) => e && typeof e === 'object').map((e) => ({
      id: asString(e.id),
      baseUrl: asString(e.baseUrl),
      format: asString(e.format),
      label: asString(e.label),
      isDefault: asBool(e.isDefault, false),
      supported: asBool(e.supported, false),
    })),
    models: asStringArray(p?.models),
  }));
}

/** 消息队列行（QueueItem）：文本与 opId 保证是字符串，state 归一（未知值回落 queued） */
export function normalizeQueueItems(raw) {
  return rows(raw, (i) => ({
    opId: asString(i?.opId),
    sessionId: asString(i?.sessionId),
    text: asString(i?.text),
    state: ['queued', 'running', 'held', 'done', 'failed'].includes(i?.state) ? i.state : 'queued',
    at: asCount(i?.at),
  }));
}

/** 会话行（SessionMeta）：rules / todos 保证是数组，计数字段保证是数字 */
export function normalizeSessionRows(raw) {
  return rows(raw, (s) => ({
    id: asString(s?.id),
    name: asString(s?.name),
    model: asString(s?.model),
    provider: asString(s?.provider),
    harness: asString(s?.harness),
    workspace: asString(s?.workspace),
    createdAt: asString(s?.createdAt),
    updatedAt: asString(s?.updatedAt),
    turns: asCount(s?.turns),
    rules: rows(s?.rules, (r) => ({ action: asString(r?.action), resource: asString(r?.resource), effect: asString(r?.effect) })),
    todos: Array.isArray(s?.todos) ? s.todos : undefined,
    inputTokens: asCount(s?.inputTokens),
    outputTokens: asCount(s?.outputTokens),
    cost: asNumber(s?.cost),
    preview: typeof s?.preview === 'string' ? s.preview : undefined,
  }));
}

/** 空会话行（回包缺 session / meta 时的保底，字段全默认而非 undefined） */
const emptySessionRow = () => normalizeSessionRows([{}])[0];

/** 会话列表：GET /api/agent/sessions */
export function normalizeSessions(raw) {
  return normalizeSessionRows(asObject(raw).sessions);
}

/** 创建 / 查会话回包：{ session }（session 缺字段时 openSession(s.id) 拿到空串而非 undefined） */
export function normalizeSessionResult(raw) {
  const o = asObject(raw);
  return { ...o, session: normalizeSessionRows([o.session])[0] || emptySessionRow() };
}

/** 改会话回包：{ meta }（meta 直接进会话列表被 Sidebar 渲染） */
export function normalizeSessionMetaResult(raw) {
  const o = asObject(raw);
  return { ...o, meta: normalizeSessionRows([o.meta])[0] || emptySessionRow() };
}

/** 会话详情：GET /api/agent/sessions/:id（records 供投影层消费，保证是数组） */
export function normalizeSessionDetail(raw) {
  const o = asObject(raw);
  return { ...o, meta: normalizeSessionRows([o.meta])[0] || emptySessionRow(), records: asArray(o.records) };
}

/** 侧边对话转录：GET /api/agent/side/:id（records 喂投影层，非数组即崩） */
export function normalizeSideSession(raw) {
  const o = asObject(raw);
  return { ...o, records: asArray(o.records) };
}

/** 模型目录：GET /api/models（Composer 按 g.models.length 分组，缺数组即白屏） */
export function normalizeModels(raw) {
  const o = asObject(raw);
  return { ...o, models: normalizeModelRows(o.models), status: asString(o.status) };
}

/** 模式列表：GET /api/agent/harnesses（ComposerPickers 直接 harnesses.map） */
export function normalizeHarnesses(raw) {
  const o = asObject(raw);
  const harnesses = rows(o.harnesses, (h) => ({
    id: asString(h?.id), label: asString(h?.label), summary: asString(h?.summary),
    tools: asStringArray(h?.tools), maxRounds: asCount(h?.maxRounds),
  }));
  const dflt = asString(o.default);
  return { ...o, harnesses, default: dflt || harnesses[0]?.id || '' };
}

/** 用量逐日 / 构成行（UsageDay / UsageBucket 同形） */
const usageBucket = (r) => ({
  key: typeof r?.key === 'string' ? r.key : undefined,
  day: typeof r?.day === 'string' ? r.day : undefined,
  requests: asCount(r?.requests), inputTokens: asCount(r?.inputTokens),
  outputTokens: asCount(r?.outputTokens), cost: asNumber(r?.cost),
});

/** 用量汇总：GET /api/usage（totals 缺对象 / stats 缺数组 / recent 非数组都会白屏） */
export function normalizeUsageSummary(raw) {
  const o = asObject(raw);
  const t = asObject(o.totals);
  const st = o.stats && typeof o.stats === 'object' ? o.stats : null;
  return {
    ...o,
    totals: { requests: asCount(t.requests), inputTokens: asCount(t.inputTokens), outputTokens: asCount(t.outputTokens), cost: asNumber(t.cost) },
    recent: rows(o.recent, (r) => ({
      ts: asString(r?.ts), kind: asString(r?.kind), model: asString(r?.model),
      provider: asString(r?.provider), sessionId: asString(r?.sessionId),
      inputTokens: asCount(r?.inputTokens), outputTokens: asCount(r?.outputTokens), cost: asNumber(r?.cost),
    })),
    stats: st ? {
      ...st,
      days: asCount(st.days),
      byDay: rows(st.byDay, usageBucket),
      byModel: rows(st.byModel, usageBucket),
      byProvider: rows(st.byProvider, usageBucket),
      byPurpose: rows(st.byPurpose, usageBucket),
      bySession: rows(st.bySession, usageBucket),
    } : undefined,
  };
}

/** 错误日志：GET /api/logs/errors（entries 非数组即 entries.length 白屏） */
export function normalizeErrorLogPage(raw) {
  const o = asObject(raw);
  return {
    ...o,
    ok: asBool(o.ok, true),
    entries: rows(o.entries, (e) => ({
      ts: asString(e?.ts), kind: asString(e?.kind), message: asString(e?.message),
      detail: asString(e?.detail), version: asString(e?.version),
    })),
    total: asCount(o.total),
  };
}

/** MCP 服务器列表：GET /api/mcp/servers（servers 非数组即 servers.map 白屏） */
export function normalizeMcpServers(raw) {
  const o = asObject(raw);
  return rows(o.servers, (s) => ({
    id: asString(s?.id), name: asString(s?.name), transport: asString(s?.transport),
    enabled: asBool(s?.enabled, false), connected: asBool(s?.connected, false),
    error: asString(s?.error), tools: asCount(s?.tools),
    serverInfo: s?.serverInfo && typeof s.serverInfo === 'object' ? { ...s.serverInfo } : null,
  }));
}

/** 熔断健康行（CircuitHealth）：providerId 缺字符串时 sort 比较器 localeCompare 会抛 */
export function normalizeHealthRows(raw) {
  return rows(raw, (h) => ({
    providerId: asString(h?.providerId), state: asString(h?.state) || 'closed',
    consecutiveFailures: asCount(h?.consecutiveFailures), consecutiveSuccesses: asCount(h?.consecutiveSuccesses),
    totalRequests: asCount(h?.totalRequests), failedRequests: asCount(h?.failedRequests),
    errorRate: asNumber(h?.errorRate), openedAt: asCount(h?.openedAt), lastError: asString(h?.lastError),
  }));
}

/** 故障转移设置：GET/POST /api/settings/failover（failover 段嵌套深，逐层保底） */
export function normalizeFailoverSettings(raw) {
  const o = asObject(raw);
  const f = asObject(o.failover);
  const c = asObject(f.circuit);
  return {
    ...o,
    ok: asBool(o.ok, true),
    providerFailover: asBool(o.providerFailover, true),
    providerFailoverMaxAttempts: asCount(o.providerFailoverMaxAttempts),
    failover: {
      ...f,
      firstByteMs: asCount(f.firstByteMs), idleMs: asCount(f.idleMs), nonStreamMs: asCount(f.nonStreamMs),
      prefTtlHours: asNumber(f.prefTtlHours),
      circuit: {
        ...c,
        failureThreshold: asCount(c.failureThreshold), successThreshold: asCount(c.successThreshold),
        timeoutSeconds: asCount(c.timeoutSeconds), errorRateThreshold: asNumber(c.errorRateThreshold), minRequests: asCount(c.minRequests),
      },
    },
    queue: asStringArray(o.queue),
    health: normalizeHealthRows(o.health),
  };
}

/** 提供方列表：GET /api/providers（protocols 非数组时 protocols[0] 取值即抛） */
export function normalizeProviderList(raw) {
  const o = asObject(raw);
  return {
    ...o,
    ok: asBool(o.ok, true),
    protocols: rows(o.protocols, (p) => ({ id: asString(p?.id), label: asString(p?.label) })),
    providers: normalizeProviderRows(o.providers),
  };
}

/** 故障转移队列：GET/POST /api/providers/failover-queue（queue 非数组即 queue.length 白屏） */
export function normalizeFailoverQueue(raw) {
  const o = asObject(raw);
  return { ...o, ok: asBool(o.ok, true), queue: asStringArray(o.queue), providers: normalizeProviderRows(o.providers) };
}

/** 终端偏好：GET /api/settings/tui（tui 段缺对象时 cfg?.tui.terminalTitle 即抛） */
export function normalizeTuiSettings(raw) {
  const o = asObject(raw);
  const t = asObject(o.tui);
  const n = asObject(t.notifications);
  const opt = asObject(o.options);
  const dn = asObject(opt.defaultNotifications);
  return {
    ...o,
    ok: asBool(o.ok, true),
    tui: {
      ...t,
      terminalTitle: asStringArray(t.terminalTitle),
      notifications: { ...n, when: asString(n.when), method: asString(n.method), events: asStringArray(n.events) },
    },
    options: {
      ...opt,
      terminalTitleItems: asStringArray(opt.terminalTitleItems),
      defaultTerminalTitle: asStringArray(opt.defaultTerminalTitle),
      notificationWhen: asStringArray(opt.notificationWhen),
      notificationMethods: asStringArray(opt.notificationMethods),
      notificationEvents: asStringArray(opt.notificationEvents),
      defaultNotifications: { ...dn, when: asString(dn.when), method: asString(dn.method), events: asStringArray(dn.events) },
    },
  };
}

/** 保存终端偏好回包：{ ok, tui }（tui 段同样保底，回落进 state 不炸） */
export function normalizeTuiSaveResult(raw) {
  const o = asObject(raw);
  return { ...o, ok: asBool(o.ok, true), tui: normalizeTuiSettings({ tui: o.tui }).tui };
}

/** 定时任务行（JobItem）：schedule 形状不对时回落成不合法但安全的空 cron，绝不白屏面板 */
export function normalizeJobRows(raw) {
  return rows(raw, (j) => {
    const sc = asObject(j?.schedule);
    const schedule = sc.kind === 'interval'
      ? { kind: 'interval', everyMs: asCount(sc.everyMs) }
      : { kind: 'cron', expr: asString(sc.expr) };
    return {
      id: asString(j?.id),
      name: asString(j?.name),
      sessionId: asString(j?.sessionId),
      prompt: asString(j?.prompt),
      schedule,
      enabled: asBool(j?.enabled, true),
      createdAt: asCount(j?.createdAt),
      updatedAt: asCount(j?.updatedAt),
      lastRunAt: asOptionalNumber(j?.lastRunAt) ?? null,
      lastStatus: asString(j?.lastStatus),
      lastError: asString(j?.lastError),
      nextRunAt: asOptionalNumber(j?.nextRunAt) ?? null,
    };
  });
}

/** 任务列表回包：GET /api/jobs */
export function normalizeJobList(raw) {
  const o = asObject(raw);
  return { ...o, jobs: normalizeJobRows(o.jobs) };
}

/** 文件搜索：GET /api/files/search（files 非数组即 MentionPalette filter 白屏） */
export function normalizeFileSearch(raw) {
  const o = asObject(raw);
  return { ...o, files: asStringArray(o.files) };
}

/**
 * 模型发现：POST /api/providers/discover（models 非数组即 picker.map 白屏）。
 * 发现结果比 ModelInfo 松（无 provider 字段，来自上游目录），按自身声明形状规整。
 */
export function normalizeDiscoveredModels(raw) {
  const o = asObject(raw);
  return {
    ...o,
    ok: asBool(o.ok, true),
    url: asString(o.url),
    models: rows(o.models, (m) => ({
      id: asString(m?.id),
      name: typeof m?.name === 'string' ? m.name : undefined,
      contextWindow: asOptionalNumber(m?.contextWindow),
      maxTokens: asOptionalNumber(m?.maxTokens),
    })),
  };
}

/** 服务状态：GET /api/settings（设置页「通用」区渲染源） */
export function normalizeSettingsInfo(raw) {
  const o = asObject(raw);
  return {
    ...o,
    ok: asBool(o.ok, true),
    version: asString(o.version),
    autostart: asBool(o.autostart, false),
    managed: asBool(o.managed, false),
    serviceRunning: asBool(o.serviceRunning, false),
    servicePid: asOptionalNumber(o.servicePid) ?? null,
    port: asCount(o.port),
    dataDir: asString(o.dataDir),
  };
}
