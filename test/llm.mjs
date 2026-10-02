/**
 * LLM 抽象层单元测试（util/llm/*）：工具归一化 + wire 转换 + 错误分类。
 */
import { normalizeTool, toolAction, toOpenAIFunction, toAnthropicTool } from '../util/llm/tool.mjs';
import { classifyStatus, classifyError, ERROR_KINDS, QUOTA_WORDING, upstreamHint, isContextOverflow,
  isUsageOverflow, isRecoverableLength, isTransientError, isNonRetryableWording } from '../util/llm/errors.mjs';
import { sanitizeSurrogates, sanitizeSurrogatesDeep } from '../util/text.mjs';
import { textOf, systemTextOf, toAnthropicContent, toAnthropicTurns } from '../util/llm/message.mjs';
import { toolSchemas, anthropicToolSchemas, TOOLS } from '../util/agent/tools.mjs';
import {
  isFailoverable, failoverReason, pickFailoverCandidate, failoverBackoffMs,
  parseFailoverConfig, classifyOutcome, semanticFailure, effectiveTimeouts,
  FAILOVER_DEFAULTS, FAILOVER_ATTEMPT_LIMITS, FAILOVER_TIMEOUT_DEFAULTS, PREF_TTL_DEFAULTS,
} from '../util/llm/failover.mjs';
import { CircuitBreaker, CircuitRegistry, normalizeCircuitConfig, CIRCUIT_DEFAULTS } from '../util/llm/circuit.mjs';
import { retryableSameProvider, RETRY_DEFAULTS, RETRY_ATTEMPT_LIMITS } from '../util/llm/provider.mjs';
import { getCacheWarmingDelayMs, evaluateWarmEconomics, parsePromptCacheWarmConfig, PROMPT_CACHE_WARM_DEFAULTS } from '../util/llm/cache-warmer.mjs';
import { withFileLock, withFileLockSync } from '../util/lock.mjs';
import { parseWwwAuthenticate, isOAuthChallenge, pkcePair, oauthState, buildDiscoveryUrls, buildAuthorizationUrl, normalizeTokens, tokenExpired } from '../util/mcp/oauth.mjs';
import { parseCompactionConfig, summaryFacts, droppedWorkSummary, compactionMessages } from '../util/agent/context.mjs';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function runLlmTests(test, assert, eq) {
  console.log('\nLLM 抽象层单元测试');

  await test('tool: normalizeTool 补全 action 与空 parameters', () => {
    const t = normalizeTool({ name: 'read_file', description: '读' });
    eq(t.action, 'read_file');
    eq(t.deferred, undefined);
    eq(t.parameters.type, 'object');
    const d = normalizeTool({ name: 'x', action: 'y', deferred: true });
    eq(d.action, 'y');
    eq(d.deferred, true);
  });

  await test('tool: toolAction 缺省回退 name', () => {
    eq(toolAction({ name: 'shell' }), 'shell');
    eq(toolAction({ name: 'shell', action: 'exec' }), 'exec');
  });

  await test('tool: OpenAI / Anthropic wire 形状', () => {
    const t = { name: 'grep', description: '搜索', parameters: { type: 'object', properties: {} } };
    const oa = toOpenAIFunction(t);
    eq(oa.type, 'function');
    eq(oa.function.name, 'grep');
    eq(oa.function.parameters.type, 'object');
    const an = toAnthropicTool(t);
    eq(an.name, 'grep');
    assert(an.input_schema && !an.parameters, 'Anthropic 用 input_schema');
  });

  await test('tool: tools.mjs 经共享转换器产出正确形状', () => {
    const oa = toolSchemas(['read_file', 'shell']);
    eq(oa.length, 2);
    eq(oa[0].type, 'function');
    eq(oa[0].function.name, 'read_file');
    const an = anthropicToolSchemas(['read_file']);
    eq(an[0].name, 'read_file');
    assert('input_schema' in an[0]);
    assert(TOOLS.length >= 6, '内置工具至少六个');
  });

  await test('message: textOf 兼容字符串与多模态片段', () => {
    eq(textOf('你好'), '你好');
    eq(textOf([{ type: 'text', text: '甲' }, { type: 'text', text: '乙' }]), '甲\n乙');
    eq(textOf([{ type: 'image_url', image_url: { url: 'x' } }]), '');
    eq(textOf(null), '');
  });

  await test('message: systemTextOf 合并多段系统消息', () => {
    eq(systemTextOf([{ role: 'system', content: 'A' }, { role: 'user', content: 'B' }, { role: 'system', content: 'C' }]), 'A\n\nC');
  });

  await test('message: toAnthropicContent 拆 data URL 与图片块', () => {
    eq(toAnthropicContent('纯文本'), '纯文本');
    const blocks = toAnthropicContent([{ type: 'text', text: '看' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }]);
    eq(JSON.stringify(blocks[0]), JSON.stringify({ type: 'text', text: '看' }));
    eq(blocks[1].source.media_type, 'image/png');
    eq(blocks[1].source.data, 'AAA');
  });

  await test('message: toAnthropicTurns 翻 tool_use / tool_result 并合并连续工具结果', () => {
    const turns = toAnthropicTurns([
      { role: 'system', content: '系统' },
      { role: 'user', content: '问题' },
      { role: 'assistant', content: '思考', tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: '文件内容' },
      { role: 'tool', tool_call_id: 'c2', content: '第二个结果' },
      { role: 'assistant', content: '答复' },
    ]);
    eq(turns.length, 4);
    eq(JSON.stringify(turns[0]), JSON.stringify({ role: 'user', content: '问题' }));
    eq(turns[1].role, 'assistant');
    eq(JSON.stringify(turns[1].content[0]), JSON.stringify({ type: 'text', text: '思考' }));
    eq(turns[1].content[1].type, 'tool_use');
    eq(JSON.stringify(turns[1].content[1].input), JSON.stringify({ path: 'a' }));
    eq(turns[2].role, 'user');
    eq(turns[2].content.length, 2);
    eq(turns[2].content[0].type, 'tool_result');
    eq(JSON.stringify(turns[3]), JSON.stringify({ role: 'assistant', content: '答复' }));
  });

  await test('errors: upstreamHint 按提供方给出中文指引', () => {
    const builtin = { builtin: true, name: '美团 LongCat' };
    assert(upstreamHint(builtin, 401, '').includes('auroraagent.config.json'));
    assert(upstreamHint(builtin, 402, '').includes('充值'));
    const custom = { builtin: false, name: '我的上游' };
    assert(upstreamHint(custom, 401, '').includes('我的上游'));
    eq(upstreamHint(custom, 500, 'boom'), 'boom');
  });

  await test('wire: deferred 工具不进请求 tools[] 但可被解析执行', () => {
    const names = ['read_file', 'list_dir'];
    eq(toolSchemas(names).length, 2);
    eq(toolSchemas(names, [{ name: 'read_file', deferred: true }]).length, 2);
    const extra = [{ name: 'mcp__x__echo', description: 'd', parameters: { type: 'object' }, deferred: true }];
    eq(toolSchemas([...names, 'mcp__x__echo'], extra).length, 2);
    eq(anthropicToolSchemas([...names, 'mcp__x__echo'], extra).length, 2);
    eq(anthropicToolSchemas([...names, 'mcp__x__echo'], extra)[0].name, 'read_file');
  });

  await test('errors: classifyStatus 映射状态码', () => {
    eq(classifyStatus(401), 'auth');
    eq(classifyStatus(403), 'auth');
    eq(classifyStatus(402), 'quota');
    eq(classifyStatus(429), 'rate_limit');
    eq(classifyStatus(400), 'bad_request');
    eq(classifyStatus(404), 'not_found');
    eq(classifyStatus(500), 'server');
    eq(classifyStatus(503), 'server');
  });

  await test('errors: 额度措辞启发式识别为 quota', () => {
    eq(classifyStatus(400, 'insufficient quota for this request'), 'quota');
    eq(classifyStatus(200, 'account balance exhausted'), 'quota');
    eq(classifyStatus(400, 'insufficient balance'), 'quota');
    assert(QUOTA_WORDING.test('usage limit exceeded'));
  });

  await test('errors: classifyError 识别网络与中止', () => {
    eq(classifyError({ name: 'TypeError' }), 'network');
    eq(classifyError({ name: 'AbortError' }), 'aborted');
    eq(classifyError(new Error('x')), 'unknown');
    eq(classifyError(null), 'unknown');
    assert(ERROR_KINDS.includes('quota'));
  });

  await test('failover: 可转移判定只认限流 / 超时 / 服务端 / 网络，中止不转移', () => {
    for (const status of [429, 408, 500, 502, 503, 504, 599]) {
      eq(isFailoverable({ kind: 'x', status }), true, `HTTP ${status} 应可转移`);
    }
    eq(isFailoverable({ kind: 'rate_limit' }), true, 'rate_limit 应可转移');
    eq(isFailoverable({ kind: 'server' }), true, 'server 应可转移');
    eq(isFailoverable({ kind: 'network' }), true, 'network 应可转移');
    eq(isFailoverable(Object.assign(new TypeError('fetch failed'), {})), true, 'fetch 网络异常应可转移');
    eq(isFailoverable(new Error('socket hang up')), true, '裸 Error 按瞬时措辞兜底可转移');
    eq(isFailoverable({ kind: 'x', status: 501 }), false, 'HTTP 501 是请求自身问题，换路掩盖真实错误');
    for (const status of [400, 401, 402, 403, 404, 422]) {
      eq(isFailoverable({ kind: 'auth', status }), false, `HTTP ${status} 不应转移（配置 / 鉴权 / 计费问题）`);
    }
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    eq(isFailoverable(abort), false, '用户中止绝不转移');
    eq(isFailoverable({ kind: 'aborted' }), false, 'aborted 种类不转移');
    eq(isFailoverable(null), false, '空错误不转移');
  });

  await test('failover: 原因词归一（kind 优先，状态码兜底）', () => {
    eq(failoverReason({ kind: 'rate_limit', status: 500 }), 'rate_limit', 'kind 优先于状态码');
    eq(failoverReason({ status: 429 }), 'rate_limit');
    eq(failoverReason({ status: 408 }), 'timeout');
    eq(failoverReason({ status: 503 }), 'server');
    eq(failoverReason(Object.assign(new TypeError('x'), {})), 'network');
    eq(failoverReason({ status: 401 }), 'unknown', '不可转移的错误没有原因词');
  });

  await test('failover: 候选挑选排除当前 / 已试 / 无 Key / 不含目标模型', () => {
    const all = [
      { id: 'a', apiKey: 'k', models: [{ id: 'm1' }] },
      { id: 'b', apiKey: '', models: [{ id: 'm1' }] },
      { id: 'c', apiKey: 'k', models: [{ id: 'other' }] },
      { id: 'd', apiKey: 'k', models: [{ id: 'm1' }, { id: 'm2' }] },
      { id: 'e', apiKey: 'k', models: [{ id: 'm1' }] },
    ];
    const first = pickFailoverCandidate(all, { model: 'm1', currentId: 'a', tried: [] });
    eq(first.id, 'd', '无 Key 与不含目标模型的提供方应被跳过');
    const second = pickFailoverCandidate(all, { model: 'm1', currentId: 'a', tried: ['d'] });
    eq(second.id, 'e', '已试过的提供方不应重复踩');
    eq(pickFailoverCandidate(all, { model: 'm1', currentId: 'a', tried: ['d', 'e'] }), null, '候选耗尽返回 null');
    eq(pickFailoverCandidate([], { model: 'm1', currentId: 'a' }), null, '空候选返回 null');
  });

  await test('failover: 退避线性递增，坏值回退默认', () => {
    eq(failoverBackoffMs(1), FAILOVER_DEFAULTS.backoffMs);
    eq(failoverBackoffMs(2), FAILOVER_DEFAULTS.backoffMs * 2);
    eq(failoverBackoffMs(0), FAILOVER_DEFAULTS.backoffMs, 'attempt 至少按 1 计');
    eq(failoverBackoffMs(1, -5), FAILOVER_DEFAULTS.backoffMs, '负退避回退默认');
    eq(failoverBackoffMs(1, 0), 0, '允许 0 退避（测试用）');
  });

  await test('failover: 配置解析缺省开启、钳制次数、env 优先', () => {
    const d = parseFailoverConfig({}, {});
    eq(d.enabled, true, '缺省开启');
    eq(d.maxAttempts, 3, '缺省 3 次尝试');
    eq(parseFailoverConfig({ providerFailover: false }, {}).enabled, false, '盘上可关');
    eq(parseFailoverConfig({ providerFailover: 'false' }, {}).enabled, false, '字符串 false 也认');
    eq(parseFailoverConfig({ providerFailoverMaxAttempts: 99 }, {}).maxAttempts, FAILOVER_ATTEMPT_LIMITS.max, '上限钳到 5');
    eq(parseFailoverConfig({ providerFailoverMaxAttempts: 0 }, {}).maxAttempts, FAILOVER_ATTEMPT_LIMITS.min, '下限钳到 1');
    eq(parseFailoverConfig({ providerFailoverMaxAttempts: 'abc' }, {}).maxAttempts, 3, '坏值回退 3');
    eq(parseFailoverConfig({}, { AURORAAGENT_FAILOVER: '0' }).enabled, false, 'env 可关');
    eq(parseFailoverConfig({ providerFailover: false }, { AURORAAGENT_FAILOVER: '1' }).enabled, true, 'env 优先于盘上');
    eq(parseFailoverConfig({}, { AURORAAGENT_FAILOVER_MAX_ATTEMPTS: '2' }).maxAttempts, 2, 'env 覆盖次数');
    let warned = '';
    parseFailoverConfig({ providerFailover: 'maybe', providerFailoverMaxAttempts: 'x' }, {}, { warn: (m) => { warned += m; } });
    assert(warned.includes('providerFailover') && warned.includes('providerFailoverMaxAttempts'), '坏值应告警');
  });
  await test('failover: 健康度隔离——请求自身有问题的状态码不转移也不记健康度', () => {
    for (const status of [400, 405, 406, 413, 414, 415, 422, 501]) {
      const out = classifyOutcome({ kind: 'bad_request', status });
      eq(out.failoverable, false, `HTTP ${status} 不应换路`);
      eq(out.countsHealth, false, `HTTP ${status} 不应污染提供方健康度`);
    }
    // 401/402/403/404 维持既有决策不换路：那是这家提供方的配置 / 鉴权 / 计费问题，
    // 换一家只会掩盖真实错误（AGENTS.md 与 util/llm/failover.mjs 头部的不变式）
    for (const status of [401, 402, 403, 404]) {
      eq(classifyOutcome({ kind: 'auth', status }).failoverable, false, `HTTP ${status} 不应换路`);
      eq(classifyOutcome({ kind: 'auth', status }).countsHealth, false, `HTTP ${status} 不应记健康度`);
    }
    // 408 超时 / 429 限流 / 5xx 服务端：换一家可能就好了，且要记健康度
    for (const status of [408, 429, 500, 503]) {
      eq(classifyOutcome({ kind: 'x', status }).failoverable, true, `HTTP ${status} 应可换路`);
      eq(classifyOutcome({ kind: 'x', status }).countsHealth, true, `HTTP ${status} 应记健康度`);
    }
    // 409 / 451 等未归类 4xx：不换路也不记健康度（不是可行动的提供方健康信号）
    for (const status of [409, 451]) {
      eq(classifyOutcome({ kind: 'x', status }).failoverable, false, `HTTP ${status} 不换路`);
      eq(classifyOutcome({ kind: 'x', status }).countsHealth, false, `HTTP ${status} 不记健康度`);
    }
    eq(classifyOutcome({ kind: 'x', status: 500 }).countsHealth, true, '5xx 应记健康度');
    eq(classifyOutcome({ kind: 'rate_limit', status: 429 }).countsHealth, true, '限流应记健康度');
    eq(classifyOutcome({ kind: 'semantic' }).failoverable, true, '2xx 语义失败应可换路');
    eq(classifyOutcome({ kind: 'timeout' }).failoverable, true, '超时应可换路');
    eq(classifyOutcome({ kind: 'circuit_open', status: 503 }).failoverable, false, '熔断开闸不转移');
    eq(classifyOutcome({ kind: 'circuit_open', status: 503 }).countsHealth, false, '熔断开闸不记健康度');
    const abort = Object.assign(new Error('a'), { name: 'AbortError' });
    eq(classifyOutcome(abort).countsHealth, false, '客户端中止不算上游故障');
  });

  await test('failover: 2xx 语义失败判定（200 的错误 envelope 也算失败）', () => {
    eq(semanticFailure({ error: { message: 'quota exceeded' } }), 'quota exceeded', 'OpenAI 兼容顶层 error');
    eq(semanticFailure({ type: 'error', error: { message: 'overloaded' } }), 'overloaded', 'Anthropic error 事件');
    eq(semanticFailure({ type: 'response.failed', response: { error: { message: 'upstream died' } } }), 'upstream died', 'Responses response.failed');
    eq(semanticFailure({ type: 'response.error', error: { message: 'bad frame' } }), 'bad frame', 'Responses response.error');
    eq(semanticFailure({ type: 'error' }), '上游返回错误', '缺 message 时给通用话术');
    eq(semanticFailure({ choices: [{ delta: { content: 'hi' } }] }), null, '正常内容帧不是失败');
    eq(semanticFailure({ type: 'response.completed', response: { id: 'x' } }), null, '完成事件不是失败');
    eq(semanticFailure(null), null, '空帧不是失败');
  });

  await test('failover: 队列优先——非空时只取队列成员且按队列序', () => {
    const all = [
      { id: 'builtin', apiKey: 'k', models: [{ id: 'm1' }] },
      { id: 'p1', apiKey: 'k', models: [{ id: 'm1' }] },
      { id: 'p2', apiKey: 'k', models: [{ id: 'm1' }] },
      { id: 'p3', apiKey: 'k', models: [{ id: 'm1' }] },
    ];
    eq(pickFailoverCandidate(all, { model: 'm1', currentId: 'builtin', queue: ['p3', 'p1'] }).id, 'p3', '队列序即优先级');
    eq(pickFailoverCandidate(all, { model: 'm1', currentId: 'builtin', queue: ['p3', 'p1'], tried: ['p3'] }).id, 'p1', '已试过的队列成员跳过');
    eq(pickFailoverCandidate(all, { model: 'm1', currentId: 'builtin', queue: ['ghost'] }).id, 'p1', '队列成员不可用时回退隐式顺序');
    eq(pickFailoverCandidate(all, { model: 'm1', currentId: 'builtin', queue: [] }).id, 'p1', '空队列回退隐式顺序');
    const gated = (id) => id !== 'p1';
    eq(pickFailoverCandidate(all, { model: 'm1', currentId: 'builtin', queue: ['p1', 'p2'], available: gated }).id, 'p2', '熔断开闸的队列成员被跳过');
    eq(pickFailoverCandidate(all, { model: 'm1', currentId: 'builtin', available: () => false }), null, '全部熔断时无候选');
  });

  await test('failover: 生效超时——关闭时归零，开启时按配置（0 = 禁用）', () => {
    const off = effectiveTimeouts(parseFailoverConfig({ providerFailover: false }, {}));
    eq(off.firstByteMs, 0, '关闭转移时首包超时归零');
    eq(off.idleMs, 0, '关闭转移时空闲超时归零');
    eq(off.nonStreamMs, 0, '关闭转移时连接期超时归零');
    const on = effectiveTimeouts(parseFailoverConfig({}, {}));
    eq(on.firstByteMs, FAILOVER_TIMEOUT_DEFAULTS.firstByteMs, '缺省对齐 CC Switch 现值');
    eq(on.idleMs, FAILOVER_TIMEOUT_DEFAULTS.idleMs);
    eq(on.nonStreamMs, FAILOVER_TIMEOUT_DEFAULTS.nonStreamMs);
    const zeroed = effectiveTimeouts(parseFailoverConfig({ failover: { firstByteMs: 0, idleMs: 0, nonStreamMs: 0 } }, {}));
    eq(zeroed.firstByteMs, 0, '0 = 禁用');
  });

  await test('failover: 配置解析补齐超时三件套 / 熔断五项 / 偏好有效期', () => {
    const d = parseFailoverConfig({}, {});
    eq(d.firstByteMs, 60_000, '首包缺省 60s');
    eq(d.idleMs, 120_000, '空闲缺省 120s');
    eq(d.nonStreamMs, 600_000, '连接期缺省 600s');
    eq(d.circuit.failureThreshold, CIRCUIT_DEFAULTS.failureThreshold, '熔断缺省对齐 CC Switch');
    eq(d.prefTtlHours, PREF_TTL_DEFAULTS.hours, '偏好有效期缺省 24h');
    const custom = parseFailoverConfig({ failover: { firstByteMs: 0, idleMs: 99999999, circuit: { failureThreshold: 999, errorRateThreshold: 0 } } }, {});
    eq(custom.firstByteMs, 0, '0 超时被保留');
    eq(custom.idleMs, 3_600_000, '超上限的超时被钳制');
    eq(custom.circuit.failureThreshold, 100, '熔断阈值钳制');
    eq(custom.circuit.errorRateThreshold, 0.1, '错误率下限 0.1');
    eq(parseFailoverConfig({ failover: 'nope' }, {}).idleMs, 120_000, 'failover 段坏值回退缺省');
    eq(parseFailoverConfig({ failover: { prefTtlHours: 0 } }, {}).prefTtlHours, 1, '偏好有效期下限 1 小时');
  });

  await test('circuit: 连续失败达阈值开闸，超时后半开探测，成功闭合', () => {
    let now = 1_000_000;
    const b = new CircuitBreaker({ failureThreshold: 3, successThreshold: 2, timeoutSeconds: 60 }, () => now);
    eq(b.isAvailable(), true, '初始闭合放行');
    b.recordFailure();
    b.recordFailure();
    eq(b.state, 'closed', '未达阈值仍闭合');
    b.recordFailure();
    eq(b.state, 'open', '连续失败达阈值开闸');
    eq(b.isAvailable(), false, '开闸期间不可用');
    eq(b.allowRequest().allowed, false, '开闸期间拒绝请求');
    now += 59_000;
    eq(b.isAvailable(), false, '未到超时仍拒绝');
    now += 2_000;
    eq(b.isAvailable(), true, '超时到达翻半开');
    const p1 = b.allowRequest();
    eq(p1.allowed && p1.usedHalfOpenPermit, true, '半开放行一次探测并占名额');
    eq(b.allowRequest().allowed, false, '半开只放行一次探测');
    b.recordFailure(p1.usedHalfOpenPermit);
    eq(b.state, 'open', '半开探测失败立即重开');
    now += 61_000;
    const p2 = b.allowRequest();
    b.recordSuccess(p2.usedHalfOpenPermit);
    eq(b.state, 'half_open', '一次成功未达阈值不闭合');
    const p3 = b.allowRequest();
    b.recordSuccess(p3.usedHalfOpenPermit);
    eq(b.state, 'closed', '成功累计达阈值闭合');
    eq(b.stats().totalRequests, 0, '闭合时计数归零');
  });

  await test('circuit: 半开探测失败立即重开，名额释放后可再次探测', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 1, successThreshold: 1, timeoutSeconds: 1 }, () => now);
    b.recordFailure();
    eq(b.state, 'open', '一次失败即开闸');
    now += 1_001;
    const p = b.allowRequest();
    eq(p.allowed, true, '半开放行探测');
    b.releasePermit(p.usedHalfOpenPermit); // 中性释放：结果不计健康度
    const again = b.allowRequest();
    eq(again.allowed, true, '名额已释放，可再次探测');
    eq(b.stats().failedRequests, 1, '中性释放不计失败');
  });

  await test('circuit: 错误率判据——请求数未达标不跳闸，达标且超阈值跳闸', () => {
    let now = 0;
    const b = new CircuitBreaker({ failureThreshold: 100, errorRateThreshold: 0.6, minRequests: 5 }, () => now);
    for (let i = 0; i < 4; i++) b.recordFailure();
    eq(b.state, 'closed', '请求数未达 minRequests 不跳闸');
    b.recordSuccess();
    eq(b.state, 'closed', '错误率 4/5 = 0.8 达阈值但连续失败数未达，仍看错误率');
    const b2 = new CircuitBreaker({ failureThreshold: 100, errorRateThreshold: 0.6, minRequests: 5 }, () => now);
    for (let i = 0; i < 3; i++) b2.recordFailure();
    for (let i = 0; i < 3; i++) b2.recordSuccess();
    eq(b2.state, 'closed', '错误率 3/6 = 0.5 未达阈值');
    b2.recordFailure();
    b2.recordFailure();
    eq(b2.state, 'open', '错误率 5/8 = 0.625 超阈值跳闸');
  });

  await test('circuit: 注册表按 id 托管、快照往返、坏快照容错', () => {
    let now = 500;
    const reg = new CircuitRegistry({ config: { failureThreshold: 1 }, now: () => now });
    reg.recordFailure('p1', false, 'boom');
    eq(reg.isAvailable('p1'), false, 'p1 已熔断');
    eq(reg.isAvailable('p2'), true, 'p2 不受影响');
    const snap = reg.snapshot();
    eq(snap.p1.state, 'open');
    eq(snap.p1.lastError, 'boom');
    const restored = new CircuitRegistry({ config: { failureThreshold: 1 }, now: () => now }).restore({ p1: { state: 'open', openedAt: now, totalRequests: 9, failedRequests: 4, lastError: 'x' }, p2: 'garbage' });
    eq(restored.isAvailable('p1'), false, 'open 状态被恢复');
    eq(restored.health(['p1', 'p2'])[0].totalRequests, 9, '计数器被恢复');
    eq(restored.health(['p2'])[0].state, 'closed', '坏快照静默忽略');
    reg.reset('p1');
    eq(reg.isAvailable('p1'), true, '手动重置后恢复');
    eq(reg.health(['p1'])[0].lastError, '', '重置清空最后错误');
    reg.updateConfig({ failureThreshold: 9 });
    eq(reg.get('p1').config.failureThreshold, 9, '配置热更新生效');
    eq(normalizeCircuitConfig({ failureThreshold: 'x' }).failureThreshold, CIRCUIT_DEFAULTS.failureThreshold, '坏配置回退缺省');
  });

  await test('同提供方重试：只认连接期限流 / 5xx / 网络，中止与熔断不重试', () => {
    const mk = (kind, extra = {}) => Object.assign(new Error('x'), { kind }, extra);
    eq(retryableSameProvider(mk('rate_limit')), true, '限流可原地重试');
    eq(retryableSameProvider(mk('server')), true, '服务端 5xx 可原地重试');
    eq(retryableSameProvider(mk('network')), true, '网络层失败可原地重试');
    eq(retryableSameProvider(mk('timeout')), true, '首包 / 空闲超时（连接期零产出）可原地重试');
    eq(retryableSameProvider(new Error('socket hang up')), true, '裸 Error 按瞬时措辞兜底可重试');
    eq(retryableSameProvider(new TypeError('fetch failed')), true, '尚未分类的 fetch 失败按网络层重试');
    eq(retryableSameProvider(Object.assign(new TypeError('x'), { message: 'insufficient_quota: no funds' })), false, '披着 TypeError 外衣的额度措辞不重试');
    eq(retryableSameProvider(mk('aborted')), false, '用户主动中止不重试');
    eq(retryableSameProvider(Object.assign(new Error('x'), { name: 'AbortError' })), false, 'AbortError 不重试');
    eq(retryableSameProvider(mk('circuit_open')), false, '熔断开闸不重试');
    eq(retryableSameProvider(mk('semantic')), false, '200 错误 envelope 交给换路判定');
    eq(retryableSameProvider(mk('auth')), false, '鉴权类重试无意义');
    eq(retryableSameProvider(mk('quota')), false, '计费类重试无意义');
    eq(retryableSameProvider(null), false, '空错误不重试');
    eq(RETRY_DEFAULTS.attempts, 3, '默认 3 次尝试');
    eq(RETRY_ATTEMPT_LIMITS.min, 1, '最小 1 = 关闭原地重试');
    eq(RETRY_ATTEMPT_LIMITS.max, 5, '最多 5 次尝试');
  });

  await test('上下文超长判定：只认窗口溢出措辞，鉴权 / 计费 / 限流不算', () => {
    const mk = (status, text) => Object.assign(new Error(text), { status, kind: classifyStatus(status, text) });
    eq(isContextOverflow(mk(400, 'maximum context length is 128000 tokens')), true, '英文窗口溢出');
    eq(isContextOverflow(mk(400, 'context window exceeded')), true, 'context window exceeded');
    eq(isContextOverflow(mk(413, 'request entity too large')), true, '载荷过大也算溢出');
    eq(isContextOverflow(mk(422, 'too many tokens')), true, 'token 数超限也算溢出');
    eq(isContextOverflow(mk(400, 'invalid api key')), false, '鉴权不是溢出');
    eq(isContextOverflow(mk(402, 'insufficient quota')), false, '计费不足不是溢出');
    eq(isContextOverflow(mk(429, 'rate limit exceeded, too many tokens')), false, '限流话术里带 token 也不算溢出');
    eq(isContextOverflow(mk(400, 'ThrottlingException: Too many tokens, please wait')), false, 'Bedrock 限流措辞不误判成溢出（移植 pi 排除项）');
    eq(isContextOverflow(mk(500, 'context length exceeded')), false, '服务端 5xx 不按溢出恢复');
    eq(isContextOverflow(null), false, '空错误不判定');
  });

  await test('overflow: 用量口径静默溢出与可恢复长度判定（移植 pi overflow.ts Case 2/3）', () => {
    eq(isUsageOverflow({ prompt_tokens: 199000, cachedTokens: 500 }, 200000), true, '输入+缓存顶到窗口 99% 即溢出');
    eq(isUsageOverflow({ prompt_tokens: 199000, cachedTokens: 500 }, 0), false, '窗口未知无从判定');
    eq(isUsageOverflow(null, 200000), false, 'usage 缺失无从判定');
    eq(isUsageOverflow({ prompt_tokens: 100 }, 200000), false, '正常用量不误判');
    eq(isUsageOverflow({ input_tokens: 199500 }, 200000), true, '兼容 input_tokens 字段名');
    eq(isRecoverableLength('length', 10, 100), true, '产出远低于上限 = 上下文挤占，压缩可救');
    eq(isRecoverableLength('length', 0, 100), true, 'output=0（上游静默截断）同样可救');
    eq(isRecoverableLength('length', 100, 100), false, '产出已顶上限 = 真截断，该续写');
    eq(isRecoverableLength('stop', 10, 100), false, '非 length 结束不判定');
    eq(isRecoverableLength('length', 10, 0), false, '上限未知（自定义提供方未配）时不判定，行为同接入前');
  });

  await test('errors: 瞬时故障与额度措辞库（裸 Error 兜底，移植 pi）', () => {
    eq(isTransientError(new Error('socket hang up')), true, 'socket 中断属瞬时故障');
    eq(isTransientError(new Error('terminated')), true, '连接被终止属瞬时故障');
    eq(isTransientError(new Error('insufficient_quota')), false, '额度措辞不重试');
    eq(isTransientError(new Error('available balance is 0')), false, '余额措辞不重试');
    eq(isTransientError(null), false, '空错误不判定');
    eq(isNonRetryableWording('Monthly usage limit reached'), true, '订阅用量到顶不重试');
    eq(isNonRetryableWording('boom'), false, '普通措辞不在拦截名单');
  });

  await test('text: sanitizeSurrogates 清未配对代理、保住成对 emoji', () => {
    const emoji = 'Hello 🙂 World';
    eq(sanitizeSurrogates(emoji), emoji, '成对代理（合法 emoji）原样保留');
    eq(sanitizeSurrogates(`Text ${String.fromCharCode(0xD83D)} here`), 'Text  here', '未配对高代理被清除');
    eq(sanitizeSurrogates(`Text ${String.fromCharCode(0xDE00)} here`), 'Text  here', '未配对低代理被清除');
    eq(sanitizeSurrogates(sanitizeSurrogates('a\ud800b')), sanitizeSurrogates('a\ud800b'), '幂等');
    eq(sanitizeSurrogates(42), 42, '非字符串原样返回');
    const clean = 'no surrogate here';
    eq(sanitizeSurrogates(clean), clean, '干净字符串走快路径');
  });

  await test('text: sanitizeSurrogatesDeep 在 stringify 前按值深度清洗（post-stringify 是空转）', () => {
    const dirty = { a: 'x\ud800y', b: ['🙂', { c: 'z\udc00q' }], d: 1, e: null };
    const deep = sanitizeSurrogatesDeep(dirty);
    eq(deep.a, 'xy', '顶层字符串已清洗');
    eq(deep.b[0], '🙂', '嵌套数组里的 emoji 保住');
    eq(deep.b[1].c, 'zq', '嵌套对象字符串已清洗');
    eq(deep.d, 1, '数字叶节点不动');
    const serialized = JSON.stringify({ a: 'x\ud800y' });
    eq(serialized.includes('\\ud800'), true, 'stringify 产物里 lone surrogate 是六字符转义文本');
    eq(sanitizeSurrogates(serialized), serialized, '对转义文本跑码元正则 = 空转');
    eq(JSON.stringify(sanitizeSurrogatesDeep({ a: 'x\ud800y' })).includes('\\ud800'), false, '先清洗再 stringify 才有效');
  });

  await test('cache-warmer：经济学判定与延迟（移植 pi core/cache-warmer.ts）', () => {
    eq(getCacheWarmingDelayMs(300_000), 270_000, '5 分钟 TTL 在 90% 处续');
    eq(getCacheWarmingDelayMs(15_000), 5_000, '短 TTL 保底 10 秒余量');
    eq(getCacheWarmingDelayMs(8_000), undefined, 'TTL ≤10s 不续');
    eq(getCacheWarmingDelayMs(NaN), undefined, '坏值不续');
    // 20 万 token 输入：warm 成本 ≈命中价，省下的是「下一轮不必重写缓存」的差价
    const warm = evaluateWarmEconomics({ promptTokens: 200_000, prices: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } });
    eq(warm.action, 'warm', '期望节省为正应续');
    assert(warm.expectedSavings > 0 && warm.missCost > warm.warmCost, 'miss 差价应大于 warm 成本');
    eq(warm.continuationProbability, 0.15, '闲置期打折');
    eq(evaluateWarmEconomics({ promptTokens: 200_000, prices: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 }, phase: 'streaming' }).continuationProbability, 1, '运行期不打折');
    // 微型输入：续命成本固定含 1 个 output token，expected 为负 → 不续
    eq(evaluateWarmEconomics({ promptTokens: 10, prices: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2.5 } }).action, 'stop', '小 prompt 不续');
    const noPrice = evaluateWarmEconomics({ promptTokens: 1000, prices: {} });
    eq(noPrice.action, 'stop', '无单价不续');
    eq(noPrice.economicsAvailable, false, '经济学不可用');
    eq(evaluateWarmEconomics({ promptTokens: 0, prices: { input: 2, output: 8, cacheRead: 0.2 } }).action, 'stop', '无 prompt 量不续');
    // 配置段：缺省关 + 钳制
    const dflt = parsePromptCacheWarmConfig(undefined);
    eq(dflt.enabled, false, '缺省关');
    eq(dflt.minExpectedSavings, PROMPT_CACHE_WARM_DEFAULTS.minExpectedSavings, '缺省门槛');
    eq(dflt.ttlMs, PROMPT_CACHE_WARM_DEFAULTS.ttlMs, '缺省 TTL');
    eq(parsePromptCacheWarmConfig({ enabled: true, minExpectedSavings: -3, ttlMs: 1 }).minExpectedSavings, 0, '负门槛钳到 0');
    eq(parsePromptCacheWarmConfig({ enabled: 'yes' }).enabled, false, '只认布尔 true');
    eq(parsePromptCacheWarmConfig({ ttlMs: 999999999 }).ttlMs, 3_600_000, 'TTL 上限 1 小时');
  });

  await test('lock：并发读改写一次不丢（lost update 归零）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-lock-'));
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ n: 0 }));
    const bump = async () => {
      for (let i = 0; i < 50; i++) {
        await withFileLock(file, () => {
          const st = JSON.parse(readFileSync(file, 'utf8'));
          st.n += 1;
          writeFileSync(file, JSON.stringify(st));
        });
      }
    };
    await Promise.all([bump(), bump(), bump(), bump()]);
    eq(JSON.parse(readFileSync(file, 'utf8')).n, 200, '四路并发各 50 次累加必须一次不丢');
    eq(existsSync(`${file}.lock`), false, '锁用完必须释放');
    rmSync(dir, { recursive: true, force: true });
  });

  await test('lock：回调抛错仍释放，同进程重入不自己等自己', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-lock-'));
    const file = join(dir, 's.json');
    writeFileSync(file, '{}');
    let err = null;
    try { await withFileLock(file, () => { throw new Error('boom'); }); } catch (e) { err = e; }
    assert(err && err.message === 'boom', '回调错误必须原样透出');
    eq(existsSync(`${file}.lock`), false, '抛错后锁仍须释放');
    // 重入：同步套同步、异步里套同步都不得等自己（否则白等 5s / 10s 再抛超时）
    let inner = '';
    withFileLockSync(file, () => { inner += 'a'; withFileLockSync(file, () => { inner += 'b'; }); inner += 'c'; });
    eq(inner, 'abc', '同步嵌套必须直接放行');
    let mixed = '';
    await withFileLock(file, async () => { mixed += 'x'; withFileLockSync(file, () => { mixed += 'y'; }); mixed += 'z'; });
    eq(mixed, 'xyz', '异步里套同步同路径锁也必须放行');
    rmSync(dir, { recursive: true, force: true });
  });

  await test('lock：等待期间仍互相排斥（不是谁都能直接穿过去）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-lock-'));
    const file = join(dir, 'x.json');
    writeFileSync(file, '{}');
    const order = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const holder = withFileLock(file, async () => { order.push('holder-in'); await gate; order.push('holder-out'); });
    await new Promise((r) => setTimeout(r, 20));
    const other = withFileLock(file, () => { order.push('other-in'); });
    await new Promise((r) => setTimeout(r, 20));
    eq(order.join(','), 'holder-in', '第二个任务必须在锁外等，不得并发进入');
    release();
    await Promise.all([holder, other]);
    eq(order.join(','), 'holder-in,holder-out,other-in', '临界区必须严格串行');
    rmSync(dir, { recursive: true, force: true });
  });

  await test('mcp oauth：WWW-Authenticate 解析与挑战判定', () => {
    const parsed = parseWwwAuthenticate('Bearer realm="mcp", error="invalid_token", resource_metadata="https://mcp.test/.well-known/oauth-protected-resource"');
    assert(parsed && parsed.realm === 'mcp', '带引号的 auth-param 应解析');
    assert(parsed.error === 'invalid_token', 'error 参数应解析');
    assert(parsed.resource_metadata === 'https://mcp.test/.well-known/oauth-protected-resource', 'resource_metadata 应解析');
    assert(parsed.scope === undefined, '没有的 param 不得编造');
    eq(parseWwwAuthenticate('Basic realm="x"'), null, '非 Bearer 挑战返回 null');
    eq(parseWwwAuthenticate(''), null, '空头返回 null');
    eq(parseWwwAuthenticate('Bearer'), null, '没有任何 auth-param 返回 null');
    eq(isOAuthChallenge(401, 'Bearer realm="mcp"'), true, '401 + Bearer 挑战 = 需要授权');
    eq(isOAuthChallenge(403, 'Bearer realm="mcp"'), true, '403 同样算挑战');
    eq(isOAuthChallenge(200, 'Bearer realm="mcp"'), false, '非 401/403 不算');
    eq(isOAuthChallenge(401, ''), false, '没有挑战头不算');
  });

  await test('mcp oauth：PKCE / state / 发现链 URL / 授权 URL', () => {
    const { verifier, challenge, method } = pkcePair();
    eq(method, 'S256', 'PKCE 固定 S256');
    assert(verifier.length >= 43 && verifier.length <= 128, `verifier 应 43-128 字符，实际 ${verifier.length}`);
    eq(challenge, createHash('sha256').update(verifier).digest('base64url'), 'challenge = base64url(sha256(verifier))');
    assert(oauthState().length >= 20, 'state 要有足够熵');
    assert(pkcePair().verifier !== pkcePair().verifier, '每次授权都要新的 verifier');
    const urls = buildDiscoveryUrls('https://auth.test/tenant/');
    eq(urls[0].url, 'https://auth.test/.well-known/oauth-authorization-server/tenant', 'RFC 8414 oauth 优先');
    eq(urls[0].type, 'oauth', '类型标注 oauth');
    eq(urls[1].url, 'https://auth.test/.well-known/openid-configuration/tenant', 'OIDC 回退');
    eq(urls[2].url, 'https://auth.test/tenant/.well-known/openid-configuration', '路径内嵌 OIDC');
    eq(buildDiscoveryUrls('https://auth.test').length, 2, '根路径只两条');
    const au = buildAuthorizationUrl({
      authorizationEndpoint: 'https://auth.test/authorize', clientId: 'cid',
      redirectUri: 'http://127.0.0.1:8765/callback', scope: 'tools:read', resource: 'https://mcp.test/mcp',
      state: 'st', codeChallenge: challenge,
    });
    assert(au.includes(`code_challenge=${challenge}`), '授权 URL 带 challenge');
    assert(au.includes('code_challenge_method=S256'), '授权 URL 声明 S256');
    assert(au.includes('state=st') && au.includes('client_id=cid') && au.includes('scope=tools%3Aread'), '授权 URL 带 state / clientId / scope');
    assert(au.includes('resource=https%3A%2F%2Fmcp.test%2Fmcp'), '授权 URL 带 resource（RFC 9728）');
  });

  await test('mcp oauth：令牌归一保留旧 refresh_token，过期判定留 30s 余量', () => {
    const t1 = normalizeTokens({ access_token: 'at1', refresh_token: 'rt1', token_type: 'Bearer', expires_in: 3600, scope: 'a b' }, null, 0);
    eq(t1.accessToken, 'at1', 'access_token 透出');
    eq(t1.refreshToken, 'rt1', '新 refresh_token 采用');
    eq(t1.expiresAt, 3600 * 1000, 'expires_in 换算成绝对时间');
    const t2 = normalizeTokens({ access_token: 'at2', scope: 'a' }, t1, 0);
    eq(t2.refreshToken, 'rt1', '缺 refresh_token（scope 收缩）时保留旧的');
    eq(t2.scope, 'a', '新 scope 覆盖');
    eq(t2.tokenType, 'Bearer', 'token_type 缺省沿用');
    eq(normalizeTokens({ access_token: 'x' }, null, 0).expiresAt, 3600 * 1000, '缺 expires_in 当 1 小时');
    let bad = null;
    try { normalizeTokens({}); } catch (e) { bad = e; }
    assert(bad && bad.message.includes('access_token'), '缺 access_token 必须抛错');
    eq(tokenExpired(null), true, '无令牌按过期');
    eq(tokenExpired({ accessToken: 'x' }), false, '未声明过期不猜，用到 401 再说');
    eq(tokenExpired({ accessToken: 'x', expiresAt: 'abc' }), false, '非数字 expiresAt 当未声明');
    eq(tokenExpired({ accessToken: 'x', expiresAt: 0 }), true, 'expiresAt 0 = 早已过期');
    eq(tokenExpired({ accessToken: 'x', expiresAt: 100_000 }, 0), false, '远期有效');
    eq(tokenExpired({ accessToken: 'x', expiresAt: 100_000 }, 69_999), false, '30s 余量外仍有效');
    eq(tokenExpired({ accessToken: 'x', expiresAt: 100_000 }, 70_000), true, '进入 30s 余量即过期');
    eq(tokenExpired({ accessToken: 'x', expiresAt: 100_000 }, 120_000), true, '已过期');
    eq(tokenExpired({ expiresAt: 100_000 }, 0), true, '没有 access_token 按过期');
  });

  await test('compaction：parseCompactionConfig 钳制与坏值回落', () => {
    const d = parseCompactionConfig(undefined);
    eq(d.providerId, '', '缺省不指定提供方（继承当前）');
    eq(d.model, '', '缺省不指定模型');
    eq(parseCompactionConfig({ providerId: ' Cheap ', model: ' m ' }).providerId, 'Cheap', 'providerId 去空白');
    eq(parseCompactionConfig({ providerId: 'bad/id', model: 'ok' }).providerId, '', '非法 providerId 回落空');
    eq(parseCompactionConfig({ providerId: 'a'.repeat(49), model: 'ok' }).providerId, '', 'providerId 封顶 48');
    eq(parseCompactionConfig({ model: 'a'.repeat(200) }).model.length, 120, 'model 封顶 120');
    eq(parseCompactionConfig('x').model, '', '非对象按缺省');
    eq(parseCompactionConfig(null).providerId, '', 'null 按缺省');
  });

  await test('compaction：facts 跨次累积与 4000 封顶，压缩输入与落盘同源', () => {
    eq(droppedWorkSummary([]), '', '无 head 无事实');
    const head = [
      { t: 'tool_call', id: '1', name: 'read_file', args: { path: 'a.txt' } },
      { t: 'tool_call', id: '2', name: 'edit_file', args: { path: 'b.txt' } },
      { t: 'tool_call', id: '3', name: 'shell', args: { command: 'ls -la' } },
      { t: 'tool_call', id: '4', name: 'grep', args: { pattern: 'TODO' } },
    ];
    const facts = droppedWorkSummary(head);
    assert(facts.includes('a.txt'), '事实清单应含读过的文件');
    assert(facts.includes('b.txt'), '事实清单应含改过的文件');
    assert(facts.includes('ls -la') && facts.includes('TODO'), '事实清单应含命令与检索模式');
    // 第二次压缩：上一次的 facts 就在 head[0]，必须原样续传（否则「上轮读过啥」彻底消失）
    const second = droppedWorkSummary([{ t: 'summary', text: '摘要', facts }, ...head]);
    assert(second.includes('（此前压缩已摘除的工作，原样续传）'), '第二次压缩应带续传标记');
    assert(second.includes('a.txt'), '旧事实应保留');
    assert(second.split('a.txt').length >= 2, '新事实与续传旧事实都在');
    eq(summaryFacts({ t: 'summary', facts: 'x'.repeat(5000) }).length, 4000, 'facts 封顶 4000');
    eq(summaryFacts({ t: 'user', text: 'x' }), '', '非 summary 记录无 facts');
    eq(summaryFacts(null), '', 'null 安全');
    // facts 由调用方算好透传：压缩输入与落盘记录永远是同一份
    const msgs = compactionMessages([{ t: 'summary', text: '旧摘要', facts }], { facts });
    assert(msgs.some((m) => m.role === 'user' && String(m.content).includes(facts.slice(0, 30))), '压缩输入应带注入的 facts');
    const auto = compactionMessages(head);
    assert(auto.some((m) => m.role === 'user' && String(m.content).includes('ls -la')), '不传 facts 时自行提取');
  });
}
