/**
 * 代码模式（code 工具，util/agent/codemode/）单元测试：
 * 源码 options 解析、工具名 → 脚本标识符、TS 声明渲染、QuickJS 沙箱语义
 * （return / 顶层 await / 输出项 / 工具往返 / store 跨次 / stalled / 超时 / 内存上限 /
 * abort / 全局隔离）、执行器的预算截断与 spill，以及经 Loop 的端到端一次 code 调用。
 * 数据隔离：全部用临时目录当数据目录，绝不碰真实数据目录。
 */
import { mkdtempSync, statSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { parseCodemodeSource, CodemodeSourceError } from '../util/agent/codemode/source.mjs';
import { toCodemodeIdentifier, renderDeclarations, renderToolSignature, renderToolSample, schemaToType } from '../util/agent/codemode/declarations.mjs';
import { CodemodeSandbox, defaultWorkerUrl } from '../util/agent/codemode/sandbox.mjs';
import { loadQuickJSWasm } from '../util/agent/codemode/wasm.mjs';
import { executeCodemode, parseCodeModeConfig, buildCodeDescription, CODE_MODE_DEFAULTS, CODE_MEMORY_LIMIT_BYTES } from '../util/agent/codemode/execute.mjs';
import { codeTool, CODE_TOOL_NAME } from '../util/agent/codemode/tool.mjs';
import { SessionStore } from '../util/agent/session.mjs';
import { UsageLedger } from '../util/usage.mjs';
import { getHarness } from '../util/agent/harness.mjs';
import { runAgentTurn } from '../util/agent/loop.mjs';
import { defaultRules, PermissionPolicy } from '../util/agent/policy.mjs';
import { toolLabel, toolIconKey } from '../util/agent/transcript.mjs';

const sseResp = (frames) => new Response(new ReadableStream({
  start(c) {
    for (const f of frames) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(f)}\n\n`));
    c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
    c.close();
  },
}), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
const textFrames = (txt) => [
  { choices: [{ index: 0, delta: { content: txt } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
];
const codeFrames = (code) => [
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_c1', type: 'function', function: { name: CODE_TOOL_NAME, arguments: JSON.stringify({ code }) } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8 } },
];

/** 造一个沙箱（wasm 编译产物按路径缓存，多次执行共享一份） */
function sandbox(tools = [], options = {}) {
  return new CodemodeSandbox({ tools, timeoutMs: 5000, memoryLimitBytes: CODE_MEMORY_LIMIT_BYTES, wasm: loadQuickJSWasm(), ...options });
}

async function runScript(code, tools = [], options = {}) {
  const s = sandbox(tools, options);
  try {
    return await s.execute(code, options.executeOptions);
  } finally {
    await s.close();
  }
}

export async function runCodemodeTests(test, assert, eq) {
  console.log('\n代码模式（QuickJS 沙箱）单元测试');

  // ---------- 源码 options 行 ----------
  await test('code: @options 首行解析与容错（行号对齐、未知字段、坏 JSON 全给中文原因）', () => {
    const plain = parseCodemodeSource('return 1;');
    eq(plain.options.timeoutMs, undefined, '无 options 行即空配置');
    eq(plain.code, 'return 1;', '代码原样');

    const withOpts = parseCodemodeSource('// @options: {"max_output_tokens": 2000, "timeout_ms": 30000}\nreturn 1;');
    eq(withOpts.options.maxOutputTokens, 2000, '输出预算字段');
    eq(withOpts.options.timeoutMs, 30000, '超时字段');
    // options 行被替换成空行而非删掉：堆栈行号与模型写的源码逐行对齐
    assert(withOpts.code.startsWith('\nreturn 1;'), 'options 行留空行保行号');

    const indented = parseCodemodeSource('   // @options: {"timeout_ms": 100}\nreturn 1;');
    eq(indented.options.timeoutMs, 100, '行首空白容忍');

    eq(parseCodemodeSource('// @options: {}\nreturn 1;').options.timeoutMs, undefined, '空对象即无覆盖');

    const thrown = [];
    for (const bad of [
      '',
      '   ',
      '// @options: {"nope": 1}\nreturn 1;',
      '// @options: {"timeout_ms": 0}\nreturn 1;',
      '// @options: {"timeout_ms": 2147483648}\nreturn 1;',
      '// @options: {"max_output_tokens": 1.5}\nreturn 1;',
      '// @options: {"max_output_tokens": -1}\nreturn 1;',
      '// @options: {"timeout_ms": "x"}\nreturn 1;',
      '// @options: [1]\nreturn 1;',
      '// @options: {oops}\nreturn 1;',
      '// @options: {"timeout_ms": 1000}',
      '// @options: {"timeout_ms": 1000}\n   \n',
    ]) {
      try { parseCodemodeSource(bad); thrown.push(`未抛错: ${bad}`); }
      catch (error) { if (!(error instanceof CodemodeSourceError)) thrown.push(`错类型: ${bad} -> ${error.name}`); }
    }
    eq(thrown.join(' | '), '', '非法输入一律 CodemodeSourceError 且不执行');
    assert(CodemodeSourceError.prototype instanceof Error, 'CodemodeSourceError 是 Error');
  });

  // ---------- 工具名 → 脚本标识符 ----------
  await test('code: 工具名归一成合法脚本标识符', () => {
    eq(toCodemodeIdentifier('read_file'), 'read_file', '合法名原样');
    eq(toCodemodeIdentifier('mcp__docs__search'), 'mcp__docs__search', '双下划线命名空间原样');
    eq(toCodemodeIdentifier('my-tool'), 'my_tool', '连字符降级');
    eq(toCodemodeIdentifier('1abc'), '_abc', '首字符必须是字母 / 下划线 / $');
    eq(toCodemodeIdentifier('工具'), '__', '非 ASCII 降级（CJK 一字一符）');
    eq(toCodemodeIdentifier(''), '_', '空名给占位符');
    eq(toCodemodeIdentifier(undefined), '_', 'undefined 给占位符');
  });

  // ---------- TS 声明渲染 ----------
  await test('code: JSON Schema → TypeScript 声明渲染', () => {
    eq(schemaToType({ type: 'string' }), 'string', '字符串');
    eq(schemaToType({ type: 'integer' }), 'number', '整数归 number');
    eq(schemaToType({ type: 'boolean' }), 'boolean', '布尔');
    eq(schemaToType({ type: 'null' }), 'null', 'null');
    eq(schemaToType({ type: ['string', 'null'] }), 'string | null', '联合去重');
    eq(schemaToType({ type: 'array', items: { type: 'string' } }), 'Array<string>', '数组');
    eq(schemaToType({ type: 'array', items: [{ type: 'string' }, { type: 'number' }] }), '[string, number]', '元组');
    eq(schemaToType({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }), '{ a: string; }', '对象必选');
    assert(schemaToType({ type: 'object', properties: { a: { type: 'string' } } }).includes('a?:'), '缺 required 即可选');
    assert(schemaToType({ const: 'x' }).includes('"x"'), 'const 走字面量');
    assert(schemaToType({ enum: ['a', 'b'] }).includes('"a" | "b"'), 'enum 走字面量联合');
    eq(schemaToType({ $ref: '#/$defs/X', $defs: { X: { type: 'string' } } }), 'string', '局部 $ref 展开');
    eq(schemaToType({ $ref: '#/$defs/Missing', $defs: {} }), 'unknown', '解析不了的引用降级');
    eq(schemaToType({ type: 'object', properties: { a: { type: 'string' } } }, { maxChars: 5 }), 'unknown', '超长降级 unknown');
    eq(schemaToType(true), 'unknown', 'schema true 降级');
    eq(schemaToType(false), 'never', 'schema false 归 never');

    const signature = renderToolSignature({ name: 'my-tool', description: '做点事', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } });
    eq(signature, 'my_tool(args: { path: string; }): Promise<unknown>;', '签名用脚本标识符 + Promise 包裹');
    eq(renderToolSignature({ name: 'x', description: 'd' }), 'x(args: unknown): Promise<unknown>;', '无 schema 即 unknown');

    const sample = renderToolSample({ name: 'read_file', description: '读文件', inputSchema: { type: 'object', properties: {} } });
    assert(sample.includes('读文件'), '样本带描述');
    assert(sample.includes('declare const tools'), '样本带声明代码块');
    assert(sample.includes('```ts'), '样本是 TS 代码块');

    const rendered = renderDeclarations({
      tools: [{ name: 'read_file', description: '读文件', inputSchema: { type: 'object', properties: { path: { type: 'string', description: '路径' } }, required: ['path'] } }],
      globals: [{ name: 'describeTool', description: '查声明', inputSchema: { type: 'string' }, outputSchema: { type: 'string' } }],
    });
    assert(rendered.includes('declare const tools: {'), '工具块');
    assert(rendered.includes('// 路径'), '属性描述变注释');
    assert(rendered.includes('declare function describeTool(args: string): Promise<string>;'), '全局函数声明');
    eq(renderDeclarations({}), '', '空清单出空串');
    eq(renderDeclarations({ globals: [{ name: 'bad name', description: '' }] }).includes('declare function bad name'), false, '非法名不进全局函数声明');
  });

  // ---------- 沙箱基本语义 ----------
  await test('code: 沙箱基本语义（return / 顶层 await / 输出项）', async () => {
    const basic = await runScript('return 1 + 1;');
    eq(basic.ok, true, '同步 return');
    eq(basic.value, 2, '返回值原样');
    eq(basic.calls.length, 0, '无工具调用');
    assert(Array.isArray(basic.output) && basic.output.length === 0, '无输出项');

    const awaited = await runScript('const v = await Promise.resolve(7); return v * 3;');
    eq(awaited.ok, true, '顶层 await 可用');
    eq(awaited.value, 21, 'await 结果');

    const noReturn = await runScript('const x = 1;');
    eq(noReturn.ok, true, '无 return 也收尾');
    eq(noReturn.value, undefined, '无返回值即 undefined');

    const out = await runScript('text("甲"); console.log("乙"); text({a:[1,2]}); return "收尾";', [], { executeOptions: {} });
    eq(out.ok, true, '带输出项也成功');
    eq(out.value, '收尾', 'return 与输出项并存');
    eq(out.output.map((item) => item.type).join(','), 'text,text,text', '输出项类型');
    eq(out.output[0].text, '甲', 'text() 追加');
    eq(out.output[1].text, '乙', 'console.log 追加');
    eq(out.output[2].text, '{"a":[1,2]}', '非字符串走 JSON');
  });

  await test('code: 沙箱没有定时器 / fetch / process / require / 模块 / WebAssembly', async () => {
    const r = await runScript('return [typeof fetch, typeof process, typeof require, typeof WebAssembly, typeof setTimeout, typeof setInterval, typeof Buffer, typeof globalThis];');
    eq(r.ok, true, '脚本正常收尾');
    for (const [i, name] of ['fetch', 'process', 'require', 'WebAssembly', 'setTimeout', 'setInterval', 'Buffer'].entries()) {
      eq(r.value[i], 'undefined', `${name} 不可见`);
    }
    eq(r.value[7], 'object', 'globalThis 在（但只装了 prelude 的东西）');
  });

  // ---------- 工具往返 ----------
  await test('code: 工具往返（参数 / 结果过 JSON 回合，抛错在脚本内可 catch）', async () => {
    const seen = [];
    const tools = [{
      name: 'read_file',
      description: '读文件',
      execute: async (args, opts) => { seen.push({ args, aborted: Boolean(opts?.signal?.aborted) }); return '文件内容'; },
    }];
    const round = await runScript('const v = await tools.read_file({ path: "a.txt", limit: 3 }); return v.length;', tools);
    eq(round.ok, true, '工具调用成功');
    eq(round.value, 4, '结果是 JSON 回合后的字符串');
    eq(seen.length, 1, '只调一次');
    eq(seen[0].args.path, 'a.txt', '参数对象穿越边界');
    eq(seen[0].args.limit, 3, '数字参数保持数字');
    eq(seen[0].aborted, false, '执行期信号未中止');
    eq(round.calls.length, 1, '调用入清单');
    eq(round.calls[0].name, 'read_file', '清单记工具名');
    eq(round.calls[0].status, 'ok', '清单记状态');

    const boomer = [{ name: 'kaput', description: 'x', execute: async () => { throw new Error('工具炸了'); } }];
    const caught = await runScript('try { await tools.kaput({}); return "没接住"; } catch (e) { return "接住了:" + e.message; }', boomer);
    eq(caught.ok, true, '脚本内 catch 即成功收尾');
    eq(caught.value, '接住了:工具炸了', '失败以 Error 拒绝，脚本才接得住');
    eq(caught.calls[0].status, 'error', '清单记失败');
    assert(caught.calls[0].error.includes('工具炸了'), '清单记错误摘要');

    const uncaught = await runScript('await tools.kaput({});', boomer);
    eq(uncaught.ok, false, '没 catch 就是脚本失败');
    eq(uncaught.error.kind, 'script', '失败归类为脚本错');
    eq(uncaught.error.name, 'Error', '错误名透出');
    eq(uncaught.error.message, '工具炸了', '错误消息透出');
    assert(typeof uncaught.error.stack === 'string' && uncaught.error.stack.length > 0, '带堆栈');

    const named = await runScript('return await tools["read_file"]({ path: "b" });', tools);
    eq(named.ok, true, '工具名本身也可作键');
    eq(named.value, '文件内容', '原名调用等价');

    const ident = await runScript('return await tools.my_tool({});', [{ name: 'my-tool', description: 'x', execute: async () => 'ok' }]);
    eq(ident.ok, true, '非法标识符字符降级后可调');
    eq(ident.value, 'ok', '降级调用结果');
    const all = await runScript('return ALL_TOOLS.map((t) => t.name);', [{ name: 'my-tool', description: 'x', execute: async () => 'ok' }]);
    eq(all.value[0], 'my_tool', 'ALL_TOOLS 用脚本标识符');
  });

  // ---------- 全局函数 ----------
  await test('code: 注入的全局函数（describeTool 用展开参数）', async () => {
    const r = await runScript('return await describeTool("read_file");', [{
      name: 'read_file', description: '读文件', execute: async () => 'x',
    }], { globals: [{ name: 'describeTool', spread: true, description: '查声明', execute: (args) => `命中:${Array.isArray(args) ? args[0] : JSON.stringify(args)}` }] });
    eq(r.ok, true, '全局函数可调');
    eq(r.value, '命中:read_file', 'spread 全局函数收多个参数');
    const nested = await runScript('return await describeTool("不存在的工具");', [], { globals: [{ name: 'describeTool', spread: true, description: 'd', execute: () => '未命中' }] });
    eq(nested.value, '未命中', '未命中也走注入实现');
  });

  // ---------- store 跨次执行 ----------
  await test('code: store / load 跨执行存取并在删除时不写回', async () => {
    const s = sandbox();
    try {
      const first = await s.execute('store("k", { a: 1 }); return load("k");');
      eq(first.ok, true, '首次执行');
      eq(first.value.a, 1, 'store 后同次执行可 load');
      eq(first.storeWrites.set.k.a, 1, '写回集合');
      eq(Object.keys(first.storeWrites.set).length, 1, '只写动过的键');
      assert(!('missing' in first.storeWrites.set), '没动过的键不进写回');
      const second = await s.execute('return load("k");', { store: first.storeWrites.set });
      eq(second.value.a, 1, '跨执行延续');
      eq(Object.keys(second.storeWrites.set).length, 0, '没写就没有写回');
      const removed = await s.execute('store("k", undefined); return load("k");', { store: first.storeWrites.set });
      eq(removed.storeWrites.delete.join(','), 'k', '删除进 delete 清单');
      const bad = await s.execute('store(1, 2);', { store: {} });
      eq(bad.ok, false, 'key 非字符串即失败');
      assert(bad.error.message.includes('key 必须是字符串'), '给中文原因');
    } finally { await s.close(); }
  });

  // ---------- stalled / 超时 / OOM / abort ----------
  await test('code: 空转微任务的脚本立刻判失败（没有定时器，等不到人唤醒）', async () => {
    const r = await runScript('await new Promise(() => {});');
    eq(r.ok, false, 'stalled 即失败');
    assert(r.error.message.includes('永远等不到'), '说清为什么等不到');
  });

  await test('code: 超时杀掉失控脚本', async () => {
    const r = await runScript('for (;;) {}', [], { timeoutMs: 400 });
    eq(r.ok, false, '超时即失败');
    eq(r.error.kind, 'timeout', '归类为超时');
    assert(r.error.message.includes('400'), '消息带超时值');
  });

  await test('code: 内存上限把失控脚本判 OOM 而非拖垮宿主', async () => {
    const r = await runScript('const a = []; for (;;) a.push(new Array(100000).fill(1)); return a.length;', [], { timeoutMs: 20000, memoryLimitBytes: 8 * 1024 * 1024 });
    eq(r.ok, false, '超限即失败');
    assert(/out of memory/i.test(`${r.error.message} ${r.error.stack ?? ''}`), '报内存不足');
  });

  await test('code: 中止杀掉在飞脚本', async () => {
    const s = sandbox();
    try {
      const controller = new AbortController();
      const pending = s.execute('return 1;', { signal: controller.signal });
      controller.abort();
      const r = await pending;
      eq(r.ok, false, '中止即失败');
      eq(r.error.kind, 'aborted', '归类为中止');
    } finally { await s.close(); }
    const pre = new AbortController();
    pre.abort();
    const already = await runScript('return 1;', [], { executeOptions: { signal: pre.signal } });
    eq(already.ok, false, '已中止的信号不再启动执行');
    eq(already.error.kind, 'aborted', '同样是中止');
  });

  await test('code: 沙箱构造期校验（重名工具 / 非法全局名 / 关闭后拒绝执行）', async () => {
    const s = sandbox([{ name: 'a', description: '', execute: async () => 1 }]);
    try {
      let threw = '';
      try { s.registerTool({ name: 'a', description: '', execute: async () => 2 }); } catch (e) { threw = e.message; }
      assert(threw.includes('已注册'), '同名工具重复注册即抛错');
      const unregistered = s.unregisterTool('a');
      eq(unregistered, true, '可摘除');
      s.registerTool({ name: 'a', description: '', execute: async () => 3 });
      const after = await s.execute('return await tools.a({});');
      eq(after.value, 3, '摘除后重注册生效');
    } finally { await s.close(); }
    const rejected = await s.execute('return 1;').then(() => false, (e) => e.message);
    assert(String(rejected).includes('沙箱已关闭'), 'close 后拒绝新执行');

    for (const name of ['bad name', 'a.b.c', 'tools', 'console']) {
      let threw = '';
      try { new CodemodeSandbox({ tools: [], globals: [{ name, description: '' }] }); } catch (e) { threw = e.message; }
      assert(threw.includes('非法全局函数名') || threw.includes('已注册') || threw.includes('冲突'), `全局名 ${name} 被拒: ${threw}`);
    }
  });

  // ---------- 工具定义与描述 ----------
  await test('code: 工具定义与描述（每 turn 现造、预算内联、可关）', async () => {
    const policy = new PermissionPolicy(defaultRules(), {});
    eq(policy.effective(CODE_TOOL_NAME, 'x'), 'ask', 'code 默认要权限（跑脚本花 token）');
    const relaxed = new PermissionPolicy(defaultRules(), { permissionMode: 'never_ask' });
    eq(relaxed.effective(CODE_TOOL_NAME, 'x'), 'allow', 'never_ask 档下放行');
    const sessionAllowed = new PermissionPolicy([...defaultRules(), { action: CODE_TOOL_NAME, resource: '*', effect: 'allow', source: 'session' }], { permissionMode: 'always_ask' });
    eq(sessionAllowed.effective(CODE_TOOL_NAME, 'x'), 'allow', '会话级「总是允许」不被 always_ask 推翻');

    const tool = codeTool([{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]);
    eq(tool.name, CODE_TOOL_NAME, '工具名');
    eq(tool.parameters.required.join(','), 'code', '参数只要 code');
    eq(tool.parameters.properties.code.type, 'string', 'code 是字符串');
    assert(Object.isFrozen(tool.parameters), '参数 schema 冻结：下游只读');
    assert(tool.description.includes('QuickJS'), '描述说清沙箱');
    assert(tool.description.includes('read_file'), '描述内联本 turn 可调用工具');

    const narrow = codeTool([{ name: 'read_file', description: '读文件', parameters: { type: 'object' } }, { name: 'shell', description: 'x', parameters: { type: 'object' } }]);
    assert(narrow.description.includes('shell'), '多个工具都列');
    assert(codeTool([]).description.includes('没有可调用工具'), '空工具表也能描述');

    // 预算：超出就让模型用 describeTool() 补看，而不是把描述撑爆
    const many = [];
    for (let i = 0; i < 400; i++) many.push({ name: `t${i}`, description: 'x'.repeat(400), parameters: { type: 'object' } });
    const fat = buildCodeDescription(many);
    assert(fat.includes('describeTool('), '放不下时告诉模型用 describeTool() 补看');
    assert(fat.includes('个未在此列出'), '说清几个没列出');
    assert(!fat.includes('t399'), '放不下的工具不进描述');
    assert(fat.length < 30000, `描述有界（实际 ${fat.length} 字符）`);
    eq(buildCodeDescription(null).length > 0, true, '坏值也给描述');
  });

  await test('code: 配置解析（单叶容错 + 钳制）', () => {
    eq(parseCodeModeConfig().enabled, true, '缺省开');
    eq(parseCodeModeConfig({ enabled: false }).enabled, false, '可关');
    eq(parseCodeModeConfig({ timeoutMs: 10 }).timeoutMs, 1000, '低于下限钳到下限');
    eq(parseCodeModeConfig({ timeoutMs: 60000 }).timeoutMs, 60000, '区间内原样');
    eq(parseCodeModeConfig({ timeoutMs: 99999999 }).timeoutMs, 3600000, '高于上限钳制');
    eq(parseCodeModeConfig({ maxOutputTokens: 1 }).maxOutputTokens, 200, '输出预算下限');
    eq(parseCodeModeConfig({ maxOutputTokens: 99999999 }).maxOutputTokens, 200000, '输出预算上限');
    eq(parseCodeModeConfig({ timeoutMs: 'x' }).timeoutMs, CODE_MODE_DEFAULTS.timeoutMs, '坏值回落默认');
    eq(parseCodeModeConfig(null).maxOutputTokens, CODE_MODE_DEFAULTS.maxOutputTokens, 'null 回落默认');
    eq(parseCodeModeConfig([1, 2]).enabled, true, '数组回落默认');
  });

  await test('code: 依赖与 worker 入口', () => {
    assert(defaultWorkerUrl().endsWith('worker.mjs'), '默认 worker 在本目录');
    assert(CODE_MEMORY_LIMIT_BYTES === 256 * 1024 * 1024, '内存上限 256MB');
    const wasm = loadQuickJSWasm();
    assert(typeof wasm.then === 'function', 'wasm 加载是 Promise');
    return wasm.then((module) => assert(module instanceof WebAssembly.Module, '编译产物是 Module'));
  });

  // ---------- 执行器 ----------
  await test('code: 执行器缺运行时上下文即抛错', async () => {
    let threw = '';
    try { await executeCodemode({ code: 'return 1;' }, {}); } catch (e) { threw = e.message; }
    assert(threw.includes('运行时上下文'), '说清缺什么');
    const ok = await executeCodemode({ code: 'return 1;' }, { codemode: { cfg: parseCodeModeConfig(), tools: () => [], nested: async () => ({ ok: true }), event: () => {}, store: { read: () => ({}), write: () => {} } } });
    assert(ok.output.includes('脚本已完成'), '有 runtime 就跑');
  });

  await test('code: 执行器渲染结果文本与 extra.codeMode', async () => {
    const ctx = {
      codemode: {
        cfg: parseCodeModeConfig(),
        tools: () => [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
        nested: async (name) => ({ ok: true, output: `读了 ${name}` }),
        event: () => {},
        store: { read: () => ({}), write: () => {} },
      },
    };
    const out = await executeCodemode({ code: 'text("开始"); const v = await tools.read_file({ path: "a" }); store("seen", 1); return v.length;' }, ctx);
    assert(out.output.includes('脚本已完成'), '头部状态');
    assert(out.output.includes('开始'), '脚本输出');
    assert(out.output.includes('—— 返回值 ——'), '返回值分区');
    assert(out.output.includes('- read_file ') && out.output.includes('→ ok'), '嵌套调用清单带工具名 / 参数 / 状态');
    eq(out.extra.codeMode.ok, true, 'extra 记成败');
    eq(out.extra.codeMode.calls.length, 1, 'extra 记调用');
    eq(out.extra.codeMode.images, 0, 'extra 记图片数');
    assert(out.extra.codeMode.durationMs >= 0, 'extra 记耗时');

    const failed = await executeCodemode({ code: 'throw new Error("炸");' }, ctx);
    assert(failed.output.includes('脚本执行失败'), '失败头部');
    assert(failed.output.includes('—— 堆栈 ——'), '失败带堆栈');
    eq(failed.extra.codeMode.ok, false, 'extra 记失败');

    const timeout = await executeCodemode({ code: 'for(;;){}' }, { codemode: { ...ctx.codemode, cfg: parseCodeModeConfig({ timeoutMs: 1000 }) } });
    assert(timeout.output.includes('脚本超时'), '超时话术');

    const bad = await executeCodemode({ code: 'await tools.x({});' }, { codemode: { cfg: parseCodeModeConfig(), tools: () => [{ name: 'x', description: '', execute: async () => { throw new Error('内层失败'); } }], nested: async () => ({ ok: false, output: '内层失败' }), event: () => {}, store: { read: () => ({}), write: () => {} } } });
    assert(bad.output.includes('内层失败'), '嵌套失败原因回给模型');
    assert(bad.output.includes('脚本执行失败'), '没 catch 就是脚本失败');
    assert(bad.output.includes('- x '), '调用清单记被拒的那次');

    const badOpts = await executeCodemode({ code: '// @options: {"nope": 1}\nreturn 1;' }, ctx).then(() => null, (e) => e);
    assert(badOpts && badOpts.name === 'CodemodeSourceError', '非法 options 直接抛给工具层');
  });

  await test('code: 输出超预算截断并 spill 到临时文件（模型可读回全文）', async () => {
    const stored = [];
    const ctx = {
      codemode: {
        cfg: parseCodeModeConfig({ maxOutputTokens: 200 }),
        tools: () => [],
        nested: async () => ({ ok: true }),
        event: () => {},
        store: { read: () => ({}), write: (writes) => stored.push(writes) },
      },
    };
    // 预算 200 token ≈ 800 字符，脚本吐 3000 字符必被截断
    const out = await executeCodemode({ code: 'text("甲".repeat(3000)); return 42;' }, ctx);
    assert(out.output.includes('已截断'), '带截断标记');
    const match = out.output.match(/\[完整输出: (.+?)（用 read_file 分段读回）\]/);
    assert(match, '给出 spill 路径');
    const path = match[1];
    assert(existsSync(path), 'spill 文件确实落盘');
    assert(statSync(path).size > out.output.length, '全文比回给模型的截断文本长');
    assert(out.output.includes('—— 返回值 ——'), '返回值仍在');

    const small = await executeCodemode({ code: 'text("短");' }, ctx);
    assert(!small.output.includes('已截断'), '不超预算不截断');

    const budget = await executeCodemode({ code: '// @options: {"max_output_tokens": 200}\ntext("乙".repeat(3000));' }, ctx);
    assert(budget.output.includes('已截断'), 'options 覆盖输出预算');

    const spilled = await executeCodemode({ code: 'store("k", 1);' }, ctx);
    eq(stored.length, 1, 'store 写回 runtime');
    eq(stored[0].set.k, 1, '写回内容');
    const noWrites = await executeCodemode({ code: 'return 1;' }, ctx);
    eq(stored.length, 1, '没写就不回调');
  });

  await test('code: store 写入被 runtime 拒绝时不影响脚本结果', async () => {
    const ctx = {
      codemode: {
        cfg: parseCodeModeConfig(),
        tools: () => [],
        nested: async () => ({ ok: true }),
        event: () => {},
        store: { read: () => ({}), write: () => { throw new Error('盘满了'); } },
      },
    };
    const out = await executeCodemode({ code: 'store("k", 1); return "done";' }, ctx);
    assert(out.output.includes('—— 返回值 ——'), '脚本结果照常');
    assert(out.output.includes('store 的跨调用存取没能保存'), '保存失败要说清');
    assert(out.output.includes('盘满了'), '带失败原因');
    eq(out.extra.codeMode.ok, true, '不算脚本失败');
  });

  // ---------- Loop 端到端 ----------
  await test('code: Loop e2e——模型写脚本、嵌套工具调用不进转录但事件带 nested', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-codemode-'));
    try {
      const ws = join(dir, 'workspace');
      mkdirSync(ws, { recursive: true });
      writeFileSync(join(ws, 'a.txt'), 'AAA');
      writeFileSync(join(ws, 'b.txt'), 'BBB');
      const store = new SessionStore(dir);
      const usage = new UsageLedger(dir);
      const session = store.create({ name: '', model: 'm1', harness: 'standard', workspace: ws });
      const events = [];
      const requests = [];
      const provider = { id: 'p1', name: '测试提供方', protocol: 'openai', baseUrl: 'https://up.test', pathPrefix: '/v1', apiKey: 'k' };
      const realFetch = globalThis.fetch;
      let call = 0;
      globalThis.fetch = async (url, opts = {}) => {
        requests.push({ url: String(url), body: JSON.parse(opts.body || '{}') });
        const scripted = call++ === 0
          ? codeFrames('const names = ["a.txt", "b.txt"]; let total = 0; for (const n of names) { const t = await tools.read_file({ path: n }); total += t.length; } return total;')
          : textFrames('两个文件共 6 个字符。');
        return sseResp(scripted);
      };
      const controller = new AbortController();
      let result;
      try {
        result = await runAgentTurn({
          store, usage, session, input: '统计一下', provider, model: 'm1', harness: getHarness('standard'),
          builtinPrice: { input: 2, output: 8 },
          emit: (type, payload) => events.push({ type, ...payload }),
          controller,
          requestPermission: async () => 'allow',
          titleMode: 'local',
          log: () => {},
          codeMode: { enabled: true },
        });
      } finally {
        globalThis.fetch = realFetch;
      }
      eq(requests.length, 2, '两轮请求（工具轮 + 收尾轮）');
      const toolNames = requests[0].body.tools.map((t) => t.function.name);
      assert(toolNames.includes(CODE_TOOL_NAME), 'code 进了请求工具表');
      const toolMsg = requests[1].body.messages.find((m) => m.role === 'tool');
      assert(toolMsg, '工具结果回填');
      assert(String(toolMsg.content).includes('脚本已完成'), '回填的是脚本结果话术');
      assert(String(toolMsg.content).includes('—— 返回值 ——'), '带回显返回值');
      assert(String(toolMsg.content).includes('- read_file ') && String(toolMsg.content).includes('→ ok'), '嵌套调用清单（工具名 + 参数 + 状态）进模型上下文');
      eq(String(toolMsg.content).includes('AAA'), false, '文件内容本身不进上下文（脚本自己聚合）');
      const nested = events.filter((e) => e.type === 'tool_event' && e.nested === true);
      eq(nested.length, 4, '两次嵌套调用各出 started / completed');
      eq(new Set(nested.map((e) => e.toolName)).size, 1, '嵌套的都是 read_file');
      assert(nested.every((e) => e.toolId.startsWith('call_c1/')), '嵌套 id 挂在 code 调用下');
      const records = store.get(session.id).records ?? [];
      const nestedInTranscript = records.filter((r) => r.t === 'tool_call' && r.name === 'read_file');
      eq(nestedInTranscript.length, 0, '嵌套工具调用不写转录');
      eq(records.filter((r) => r.t === 'tool_call' && r.name === CODE_TOOL_NAME).length, 1, '只有 code 自己写转录');
      eq(result.text, '两个文件共 6 个字符。', '终稿照常');
      eq(result.tools, 1, '只记一次工具轮次');
      eq(toolLabel(CODE_TOOL_NAME), '脚本运行', '工具标签');
      eq(toolIconKey(CODE_TOOL_NAME), 'code', '图标键');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('code: Loop e2e——关掉 codeMode 后工具不进请求、模型调用即报未知', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-codemode-off-'));
    try {
      const ws = join(dir, 'workspace');
      mkdirSync(ws, { recursive: true });
      const store = new SessionStore(dir);
      const usage = new UsageLedger(dir);
      const session = store.create({ name: '', model: 'm1', harness: 'standard', workspace: ws });
      const requests = [];
      const provider = { id: 'p1', name: '测试提供方', protocol: 'openai', baseUrl: 'https://up.test', pathPrefix: '/v1', apiKey: 'k' };
      const realFetch = globalThis.fetch;
      let call = 0;
      globalThis.fetch = async (url, opts = {}) => {
        requests.push({ url: String(url), body: JSON.parse(opts.body || '{}') });
        return sseResp(call++ === 0 ? codeFrames('return 1;') : textFrames('好'));
      };
      const controller = new AbortController();
      try {
        await runAgentTurn({
          store, usage, session, input: '跑个脚本', provider, model: 'm1', harness: getHarness('standard'),
          builtinPrice: { input: 2, output: 8 },
          emit: () => {}, controller, requestPermission: async () => 'allow',
          titleMode: 'local', log: () => {}, codeMode: { enabled: false },
        });
      } finally {
        globalThis.fetch = realFetch;
      }
      const toolNames = requests[0].body.tools.map((t) => t.function.name);
      eq(toolNames.includes(CODE_TOOL_NAME), false, '关掉后不进请求');
      const toolMsg = requests[1].body.messages.find((m) => m.role === 'tool');
      assert(String(toolMsg.content).includes('未知工具'), '模型硬调时报未知工具');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
