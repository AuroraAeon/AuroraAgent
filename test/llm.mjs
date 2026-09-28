/**
 * LLM 抽象层单元测试（util/llm/*）：工具归一化 + wire 转换 + 错误分类。
 */
import { normalizeTool, toolAction, toOpenAIFunction, toAnthropicTool } from '../util/llm/tool.mjs';
import { classifyStatus, classifyError, ERROR_KINDS, QUOTA_WORDING, upstreamHint } from '../util/llm/errors.mjs';
import { textOf, systemTextOf, toAnthropicContent, toAnthropicTurns } from '../util/llm/message.mjs';
import { toolSchemas, anthropicToolSchemas, TOOLS } from '../util/agent/tools.mjs';
import {
  isFailoverable, failoverReason, pickFailoverCandidate, failoverBackoffMs,
  parseFailoverConfig, FAILOVER_DEFAULTS, FAILOVER_ATTEMPT_LIMITS,
} from '../util/llm/failover.mjs';

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
}
