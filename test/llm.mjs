/**
 * LLM 抽象层单元测试（util/llm/*）：工具归一化 + wire 转换 + 错误分类。
 */
import { normalizeTool, toolAction, toOpenAIFunction, toAnthropicTool } from '../util/llm/tool.mjs';
import { classifyStatus, classifyError, ERROR_KINDS, QUOTA_WORDING, upstreamHint } from '../util/llm/errors.mjs';
import { textOf, systemTextOf, toAnthropicContent, toAnthropicTurns } from '../util/llm/message.mjs';
import { toolSchemas, anthropicToolSchemas, TOOLS } from '../util/agent/tools.mjs';

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
}
