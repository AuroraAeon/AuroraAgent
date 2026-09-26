/**
 * LLM 抽象层单元测试（util/llm/*）：工具归一化 + wire 转换 + 错误分类。
 */
import { normalizeTool, toolAction, toOpenAIFunction, toAnthropicTool } from '../util/llm/tool.mjs';
import { classifyStatus, classifyError, ERROR_KINDS, QUOTA_WORDING } from '../util/llm/errors.mjs';
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
