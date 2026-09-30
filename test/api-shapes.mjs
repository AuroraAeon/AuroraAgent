/**
 * API 边界归一化单测（web-ui/src/api-shapes.mjs 的 Node 侧直接 import）：
 * 崩点复盘——设置页「技能」分区因版本错配（后端进程旧于前端产物）只回旧形状，
 * 前端零容差解引用 `s.allowedTools.length` 整站白屏。同类崩点遍布其余设置面板与
 * 常驻列表，归一化层在 api.ts 边界把每个响应当规整成声明形状。这里守三类性质：
 *   1) 恒等性：后端返回正确形状时规整深等于输入（不加工、不改显示）；
 *   2) 缺字段 / 旧形状：必填给安全默认值、集合字段保证是数组，崩点表达式不再抛；
 *   3) 畸形值：类型不对的标量落回默认，可选字段不伪造 0，未知扩展字段原样保留。
 */
import { deepStrictEqual } from 'node:assert';
import {
  normalizeCatalogProviders,
  normalizeCheckpointEntries, normalizeCheckpointPreview, normalizeCheckpointRestore,
  normalizeDiscoveredModels, normalizeErrorLogPage, normalizeFailoverQueue, normalizeFailoverSettings,
  normalizeFileSearch, normalizeHarnesses, normalizeHealthRows, normalizeModels, normalizeMcpServers,
  normalizeProviderList, normalizeProviderRows, normalizeQueueItems, normalizeSessionDetail, normalizeSessionMetaResult,
  normalizeSessionResult, normalizeSessionRows, normalizeSessions, normalizeSettingsInfo, normalizeSideSession,
  normalizeTuiSaveResult, normalizeTuiSettings, normalizeUsageSummary,
} from '../web-ui/src/api-shapes.mjs';

/** 完整正确形状的会话（后端当前形态） */
const FULL_SESSION = {
  id: 's1', name: '会话', model: 'LongCat-2.5-Preview', provider: 'longcat', harness: 'standard', workspace: '/w',
  createdAt: '2026-09-29T00:00:00.000Z', updatedAt: '2026-09-29T00:00:01.000Z', turns: 2,
  rules: [{ action: 'read_file', resource: '*', effect: 'allow' }],
  inputTokens: 10, outputTokens: 20, cost: 0.001, preview: '你好',
};

const deepEq = (a, b, msg) => deepStrictEqual(a, b, msg);

export async function runApiShapesTests(test, assert, eq) {
  console.log('\nAPI 边界归一化单测');

  await test('api-shapes: 正确形状恒等映射（不加工、不改显示）', () => {
    deepEq(normalizeSessions({ sessions: [FULL_SESSION] }), [FULL_SESSION], '会话列表恒等');
    deepEq(normalizeSessionDetail({ meta: FULL_SESSION, records: [{ t: 'user', text: 'hi' }] }),
      { meta: FULL_SESSION, records: [{ t: 'user', text: 'hi' }] }, '会话详情恒等');
    deepEq(normalizeSessionResult({ session: FULL_SESSION }).session, FULL_SESSION, '创建回包恒等');
    deepEq(normalizeSessionMetaResult({ meta: FULL_SESSION }).meta, FULL_SESSION, '改会话回包恒等');
    deepEq(normalizeModels({ models: [{ id: 'm1', name: '模型', provider: 'p', contextWindow: 128000 }], status: 'ok' }),
      { models: [{ id: 'm1', name: '模型', provider: 'p', contextWindow: 128000 }], status: 'ok' }, '模型目录恒等');
    deepEq(normalizeHarnesses({ harnesses: [{ id: 'standard', label: '日常', summary: 's', tools: ['read_file'], maxRounds: 24 }], default: 'standard' }),
      { harnesses: [{ id: 'standard', label: '日常', summary: 's', tools: ['read_file'], maxRounds: 24 }], default: 'standard' }, '模式列表恒等');
    const usage = {
      totals: { requests: 3, inputTokens: 100, outputTokens: 200, cost: 0.5 },
      recent: [{ ts: '2026-09-29T00:00:00.000Z', kind: 'agent', model: 'm', provider: 'p', sessionId: 's', inputTokens: 1, outputTokens: 2, cost: 0.1 }],
      stats: {
        days: 30, byDay: [{ day: '2026-09-29', requests: 1, inputTokens: 1, outputTokens: 2, cost: 0.1 }],
        byModel: [{ key: 'm', requests: 1, inputTokens: 1, outputTokens: 2, cost: 0.1 }],
        byProvider: [], byPurpose: [], bySession: [],
      },
    };
    deepEq(normalizeUsageSummary(usage), usage, '用量汇总恒等');
    deepEq(normalizeErrorLogPage({ ok: true, entries: [{ ts: 't', kind: 'frontend_crash', message: 'm', detail: 'd', version: '7.3.2' }], total: 1 }),
      { ok: true, entries: [{ ts: 't', kind: 'frontend_crash', message: 'm', detail: 'd', version: '7.3.2' }], total: 1 }, '错误日志恒等');
    const servers = [{ id: 'a', name: 'A', transport: 'stdio', enabled: true, connected: true, error: '', tools: 2, serverInfo: { name: 'srv', version: '1' } }];
    deepEq(normalizeMcpServers({ servers }), servers, 'MCP 列表恒等');
    const fo = {
      ok: true, providerFailover: true, providerFailoverMaxAttempts: 3,
      failover: { firstByteMs: 1000, idleMs: 2000, nonStreamMs: 3000, prefTtlHours: 6, circuit: { failureThreshold: 3, successThreshold: 2, timeoutSeconds: 60, errorRateThreshold: 0.5, minRequests: 5 } },
      queue: ['longcat'], health: [{ providerId: 'longcat', state: 'closed', consecutiveFailures: 0, consecutiveSuccesses: 1, totalRequests: 2, failedRequests: 0, errorRate: 0, openedAt: 0, lastError: '' }],
    };
    deepEq(normalizeFailoverSettings(fo), fo, '故障转移设置恒等');
    deepEq(normalizeHealthRows(fo.health), fo.health, '健康行恒等');
    const providers = [{ id: 'longcat', name: 'LongCat', protocol: 'openai', baseUrl: 'https://x', builtin: true, hasKey: true, model: 'm', models: [{ id: 'm', provider: 'longcat' }] }];
    deepEq(normalizeProviderList({ ok: true, protocols: [{ id: 'openai', label: 'OpenAI 兼容' }], providers }), { ok: true, protocols: [{ id: 'openai', label: 'OpenAI 兼容' }], providers }, '提供方列表恒等');
    deepEq(normalizeProviderRows(providers), providers, '提供方行恒等');
    deepEq(normalizeFailoverQueue({ ok: true, queue: ['a'], providers }), { ok: true, queue: ['a'], providers }, '队列恒等');
    const tui = {
      ok: true, tui: { terminalTitle: ['state'], notifications: { when: 'unfocused', method: 'auto', events: ['turn-complete'] } },
      options: { terminalTitleItems: ['state', 'session'], defaultTerminalTitle: ['state', 'session', 'app'], notificationWhen: ['unfocused'], notificationMethods: ['auto'], notificationEvents: ['turn-complete'], defaultNotifications: { when: 'unfocused', method: 'auto', events: [] } },
    };
    deepEq(normalizeTuiSettings(tui), tui, 'TUI 设置恒等');
    deepEq(normalizeTuiSaveResult({ ok: true, tui: tui.tui }), { ok: true, tui: tui.tui }, 'TUI 保存回包恒等');
    deepEq(normalizeFileSearch({ files: ['a.txt'] }), { files: ['a.txt'] }, '文件搜索恒等');
    deepEq(normalizeDiscoveredModels({ ok: true, url: 'u', models: [{ id: 'm', name: 'n', contextWindow: 1, maxTokens: 2 }] }), { ok: true, url: 'u', models: [{ id: 'm', name: 'n', contextWindow: 1, maxTokens: 2 }] }, '模型发现恒等');
    deepEq(normalizeSettingsInfo({ ok: true, version: '7.3.2', autostart: false, managed: true, serviceRunning: true, servicePid: 42, port: 8787, dataDir: '/d' }), { ok: true, version: '7.3.2', autostart: false, managed: true, serviceRunning: true, servicePid: 42, port: 8787, dataDir: '/d' }, '服务状态恒等');
    deepEq(normalizeSideSession({ records: [{ t: 'user' }] }), { records: [{ t: 'user' }] }, '侧边转录恒等');
  });

  await test('api-shapes: 旧形状 / 全缺响应不再白屏（崩点表达式逐一演练）', () => {
    const sessions = normalizeSessions({});
    eq(sessions.length, 0, 'sessions 缺省回退空列表（Sidebar 的 sessions.length 不再抛）');
    const detail = normalizeSessionDetail({});
    deepEq(detail.meta, normalizeSessionRows([{}])[0], 'meta 缺省回退全默认行（字段可解引用）');
    eq(detail.records.length, 0, 'records 缺省回退空数组（projectRecords 不再抛）');
    eq(normalizeSessionResult({}).session.id, '', '创建回包缺 session 时 id 为空串');
    eq(normalizeSessionMetaResult({}).meta.id, '', '改会话回包缺 meta 时 id 为空串');
    eq(normalizeSideSession({}).records.length, 0, '侧边转录缺 records 回退空数组');
    const models = normalizeModels({ models: [{ id: 'm1' }] });
    eq(models.models.length, 1, '模型行缺 provider 不丢行');
    eq(models.models[0].provider, '', '缺 provider 回退空串（Composer 分组不再抛）');
    eq(normalizeModels({}).models.length, 0, 'models 缺失回退空列表');
    eq(normalizeModels({ models: 'x' }).models.length, 0, 'models 是字符串回退空列表');
    const hs = normalizeHarnesses({});
    eq(hs.harnesses.length, 0, 'harnesses 缺省回退空列表');
    eq(hs.default, '', 'default 缺省回退空串');
    const usage = normalizeUsageSummary({});
    eq(usage.totals.requests, 0, 'totals 缺失时 requests 为 0（不再读 undefined）');
    eq(usage.totals.cost, 0, 'totals 缺失时 cost 为 0');
    eq(usage.recent.length, 0, 'recent 缺失回退空数组（.slice(0,8) 不再抛）');
    eq(usage.stats, undefined, 'stats 缺失保持缺席（面板只渲染汇总与最近请求）');
    const st = normalizeUsageSummary({ stats: {} }).stats;
    eq(st.byDay.length, 0, 'byDay 缺失回退空数组（DayBars 的 days.map 不再抛）');
    eq(st.byModel.length, 0, 'byModel 缺失回退空数组（Breakdown 的 rows.reduce 不再抛）');
    eq(st.bySession.length, 0, 'bySession 缺失回退空数组');
    const logs = normalizeErrorLogPage({});
    eq(logs.entries.length, 0, 'entries 缺失回退空数组（entries.length 不再抛）');
    eq(logs.total, 0, 'total 缺失回退 0');
    const mcp = normalizeMcpServers({ servers: [{}] });
    eq(mcp.length, 1, '服务器行缺字段不丢行');
    eq(mcp[0].enabled, false, 'enabled 缺失回退 false');
    eq(mcp[0].tools, 0, 'tools 缺失回退 0');
    eq(mcp[0].serverInfo, null, 'serverInfo 缺失回退 null');
    const fo = normalizeFailoverSettings({});
    eq(fo.failover.circuit.failureThreshold, 0, '嵌套 circuit 缺省逐层保底');
    eq(fo.queue.length, 0, 'queue 缺失回退空数组（queue.length 不再抛）');
    eq(fo.health.length, 0, 'health 缺失回退空数组');
    eq(normalizeHealthRows([{}])[0].providerId, '', '健康行缺 providerId 回退空串（localeCompare 不再抛）');
    eq(normalizeHealthRows([{}])[0].state, 'closed', '健康行缺 state 回退 closed');
    const pv = normalizeProviderList({});
    eq(pv.protocols.length, 0, 'protocols 缺失回退空数组');
    eq(pv.providers.length, 0, 'providers 缺失回退空数组');
    eq(normalizeFailoverQueue({}).queue.length, 0, '队列缺失回退空数组');
    const tui = normalizeTuiSettings({});
    eq(tui.tui.terminalTitle.length, 0, 'tui 段缺失时 terminalTitle 回退空数组（cfg?.tui.terminalTitle 不再抛）');
    eq(tui.options.notificationEvents.length, 0, 'options 段缺失时 notificationEvents 回退空数组');
    eq(normalizeFileSearch({}).files.length, 0, 'files 缺失回退空数组（MentionPalette filter 不再抛）');
    eq(normalizeDiscoveredModels({}).models.length, 0, '发现模型缺失回退空数组');
    eq(normalizeSettingsInfo({}).servicePid, null, 'servicePid 缺失回退 null');
  });

  await test('api-shapes: 畸形值——标量落回默认、可选字段不伪造、未知字段保留', () => {
    const rows = normalizeSessions({ sessions: [{ id: 'a', turns: 'x', cost: null, futureField: 1 }, null, 42, 'nope'] });
    eq(rows.length, 1, '非对象行剔除');
    eq(rows[0].turns, 0, 'turns 非数字回退 0');
    eq(rows[0].cost, 0, 'cost 非数字回退 0');
    eq(rows[0].futureField, 1, '未知扩展字段原样保留（向前兼容）');
    const ms = normalizeModels({ models: [{ id: 'm', provider: 'p', contextWindow: 'big', maxTokens: null, name: 7 }] }).models;
    eq(ms[0].contextWindow, undefined, '可选数字类型不对落回 undefined（不伪造 0）');
    eq(ms[0].maxTokens, undefined, '可选 maxTokens 不对落回 undefined');
    eq(ms[0].name, undefined, '可选 name 非字符串落回 undefined');
    const pr = normalizeProviderRows([{ id: 'p', models: 'x', price: 'y', builtin: 'yes', failoverIndex: -3 }]);
    eq(pr[0].models.length, 0, 'providers.models 非数组回退空列表');
    eq(pr[0].price, undefined, 'price 非对象落回 undefined');
    eq(pr[0].builtin, false, 'builtin 非布尔回退 false');
    eq(pr[0].failoverIndex, -3, 'failoverIndex 有限数原样保留（含 -1 语义）');
    const mixed = normalizeUsageSummary({ recent: [{ ts: 't', inputTokens: '1' }, null] });
    eq(mixed.recent.length, 1, 'recent 非对象行剔除');
    eq(mixed.recent[0].inputTokens, 0, 'inputTokens 非数字回退 0');
    const fo = normalizeFailoverSettings({ providerFailover: 'false', providerFailoverMaxAttempts: 'x', failover: { firstByteMs: -5 } });
    eq(fo.providerFailover, true, 'providerFailover 非布尔回退 true（缺省即开）');
    eq(fo.providerFailoverMaxAttempts, 0, 'maxAttempts 非数字回退 0（面板再回退默认 3）');
    eq(fo.failover.firstByteMs, 0, '负数超时钳为 0');
    eq(normalizeTuiSettings({ tui: { terminalTitle: 'state' } }).tui.terminalTitle.length, 0, 'terminalTitle 非数组回退空数组');
    // 崩点原式回放：旧形状响应过一遍归一化后，各面板的解引用表达式必须不抛
    // 提供方目录（provider-catalog.mjs）：端点 / 模型必须是数组，supported 必须是布尔——
    // ProvidersPanel 的 `p.endpoints.some(...)` 与 `.map` 直接吃这个响应
    const cat = normalizeCatalogProviders([
      { id: 'deepseek', name: 'DeepSeek', endpoints: [{ id: 'default', format: 'openai', supported: true, isDefault: true }], models: ['deepseek-v4-pro'] },
      { id: 'bad', endpoints: 'x', models: 'y' },
      null,
    ]);
    eq(cat.length, 2, 'catalog 非对象行剔除');
    eq(cat[0].endpoints.length, 1, '端点数组保留');
    eq(cat[0].endpoints[0].supported, true, 'supported 布尔保留');
    eq(cat[0].models.length, 1, '模型数组保留');
    eq(cat[1].endpoints.length, 0, 'endpoints 非数组回退空列表');
    eq(cat[1].models.length, 0, 'models 非数组回退空列表');
    eq(normalizeCatalogProviders(undefined).length, 0, '整个响应缺失回退空目录');
    // 消息队列（util/agent/queue.mjs）：Composer 队列条直接 map items 并读 position / text
    const q = normalizeQueueItems([
      { opId: 'a', sessionId: 's1', text: '一', state: 'queued', at: 1 },
      { opId: 'b', sessionId: 's1', text: '二', state: '怪状态', at: 'x' },
      null,
    ]);
    eq(q.length, 2, '非对象行剔除');
    eq(q[0].state, 'queued', '合法状态原样保留');
    eq(q[1].state, 'queued', '未知状态回落 queued（不当成 running 吞掉）');
    eq(q[1].at, 0, 'at 非数字回退 0');
    eq(normalizeQueueItems(undefined).length, 0, '整个响应缺失回退空队列');
    const renderQueue = () => {
      const list = normalizeQueueItems({});
      list.map((i, idx) => `${idx + 1}.${i.text}`) && list.map((i) => i.opId);
    };
    renderQueue();
    const renderCat = () => {
      const list = normalizeCatalogProviders({});
      list.map((p) => p.endpoints.some((e) => e.supported && e.isDefault));
      list.map((p) => p.models.map((m) => m.id));
    };
    renderCat();
    const render = () => {
      const s = normalizeSessions({});
      s.length && s.map((x) => x.name);
      const u = normalizeUsageSummary({});
      u.totals.requests && u.recent.slice(0, 8).map((r) => r.ts);
      const f = normalizeFailoverSettings({});
      [...f.health].sort((a, b) => a.providerId.localeCompare(b.providerId)).map((h) => h.lastError.length);
      const t = normalizeTuiSettings({});
      t.tui.terminalTitle.map((x) => x) && t.options.notificationEvents.map((e) => e);
      const p = normalizeProviderList({});
      p.protocols.map((x) => x.id) && p.providers.map((x) => x.models.length);
    };
    render();
    assert(true, '崩点表达式回放不抛');
  });

  await test('api-shapes: 检查点三件套（列表 / 预览 / 回滚结果）恒等与容错', () => {
    const full = {
      sessionId: 's1', kind: 'mirror',
      checkpoints: [
        { turnIndex: 2, kind: 'git', ref: 'refs/auroraagent/checkpoints/s1/2', at: 1700000000000, createdAt: 1700000000000, note: '第 2 轮' },
        { turnIndex: 1, kind: 'mirror', dir: '/bk/s1/1', at: 1699999999000 },
      ],
    };
    deepEq(normalizeCheckpointEntries(full), full, '检查点列表恒等');
    const prev = { sessionId: 's1', turnIndex: 1, kind: 'mirror', note: '第 1 轮', at: 1699999999000, files: ['a.txt', 'b.txt'] };
    deepEq(normalizeCheckpointPreview(prev), prev, '预览恒等');
    const res = { ok: true, turnIndex: 1, kind: 'mirror', worktree: null, trimmed: 0, filesAfter: ['a.txt'] };
    deepEq(normalizeCheckpointRestore(res), res, '回滚结果恒等');
    const empty = normalizeCheckpointEntries({});
    eq(empty.checkpoints.length, 0, '整个响应缺失给空列表（回滚入口不崩）');
    eq(empty.kind, '', 'kind 缺失回退空串');
    const weird = normalizeCheckpointEntries({ checkpoints: [null, { turnIndex: 'x', kind: 5 }, { turnIndex: 3 }] }).checkpoints;
    eq(weird.length, 2, '非对象行剔除');
    eq(weird[0].turnIndex, 0, 'turnIndex 非数字回退 0');
    eq(weird[0].kind, '', 'kind 非字符串回退空串');
    eq(weird[1].ref, undefined, 'ref 缺席不伪造');
    const badPrev = normalizeCheckpointPreview({ files: 'x', turnIndex: null });
    eq(badPrev.files.length, 0, 'files 非数组回退空列表');
    eq(badPrev.turnIndex, 0, 'turnIndex 非数字回退 0');
    eq(normalizeCheckpointRestore({}).ok, false, '回滚结果缺失 ok 落回 false');
    eq(normalizeCheckpointRestore({ worktree: 7 }).worktree, null, 'worktree 非字符串落回 null');
  });
}
