/**
 * 声明式子代理单元测试（util/agent/subagents.mjs + swarm.mjs 的派发接线）：
 * frontmatter 解析与硬拒、工具注册、模型 / 工具集覆盖、模式边界裁剪、
 * 以及经 stub fetch 跑通一次 task__<名称> 派发。
 * 数据隔离：全部用临时目录当数据目录，绝不碰真实数据目录。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseAgentSource, discoverAgentConfigs, findAgentConfig, subagentNameOf,
  subagentTools, subagentOverrides, SUBAGENT_PREFIX,
} from '../util/agent/subagents.mjs';
import { toolLabel, toolIconKey, toolResourceOf } from '../util/agent/transcript.mjs';
import { defaultRules, PermissionPolicy } from '../util/agent/policy.mjs';
import { SessionStore } from '../util/agent/session.mjs';
import { getHarness } from '../util/agent/harness.mjs';

function dataDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurora-agents-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  return dir;
}

export async function runSubagentTests(test, assert, eq) {
  console.log('\n声明式子代理单元测试');

  await test('subagents: frontmatter 解析与硬拒', () => {
    const a = parseAgentSource('---\nname: reviewer\ndescription: 代码审查专家\nmodel: m-fast\ntools: [read_file, grep, glob]\nskills: [code-review]\n---\n你是一位严格的审查员。');
    eq(a.name, 'reviewer');
    eq(a.description, '代码审查专家');
    eq(a.model, 'm-fast');
    eq(a.tools.join(','), 'read_file,grep,glob', '数组字面量解析');
    eq(a.skills.join(','), 'code-review');
    eq(a.systemPrompt, '你是一位严格的审查员。');
    const comma = parseAgentSource('---\nname: n\ndescription: d\ntools: read_file, shell\n---\n提示');
    eq(comma.tools.join(','), 'read_file,shell', '逗号分隔也按数组');
    const single = parseAgentSource('---\nname: n\ndescription: d\ntools: read_file\n---\n提示');
    eq(single.tools.join(','), 'read_file', '单值也归一为数组');
    const noModel = parseAgentSource('---\nname: n\ndescription: d\n---\n提示');
    eq(noModel.model, '', '省略 model 即随父会话');
    eq(noModel.tools.length, 0, '省略 tools 即随模式');
    eq(parseAgentSource('没有 frontmatter'), null, '无 frontmatter 硬拒');
    eq(parseAgentSource('---\nname: x\n---\n提示'), null, '缺 description 硬拒');
    eq(parseAgentSource('---\nname: x\ndescription: d\n---\n'), null, '缺系统提示硬拒');
  });

  await test('subagents: 目录发现、按名取用与工具名前缀', () => {
    const dir = dataDir({
      'agents/reviewer.md': '---\nname: reviewer\ndescription: 代码审查\n---\n审查要点',
      'agents/writer.md': '---\nname: writer\ndescription: 文档撰写\n---\n写作规范',
      'agents/broken.md': '坏文件',
      'agents/notes.txt': '不是 md',
    });
    try {
      const { agents, warnings } = discoverAgentConfigs(dir);
      eq(agents.map((a) => a.name).join(','), 'reviewer,writer', '按名排序、只收 .md');
      assert(warnings.some((w) => w.includes('broken.md')), '坏文件告警不阻断');
      eq(findAgentConfig(agents, 'reviewer').description, '代码审查');
      eq(findAgentConfig(agents, 'REVIEWER').name, 'reviewer', '大小写不敏感');
      eq(findAgentConfig(agents, 'nope'), null, '找不到给 null');
      eq(subagentNameOf('task__reviewer'), 'reviewer', '工具名还原子代理名');
      eq(subagentNameOf('task'), null, '内置 task 不属于该命名空间');
      eq(subagentNameOf('mcp__x__y'), null, 'MCP 工具不属于该命名空间');
      const tools = subagentTools(agents);
      eq(tools.length, 2);
      eq(tools[0].name, 'task__reviewer');
      eq(tools[0].action, 'subagent');
      eq(tools[0].parameters.required.join(','), 'task');
      assert(tools[0].description.includes('代码审查'), '描述带选型信号');
      eq(discoverAgentConfigs('').agents.length, 0, '空数据目录给空清单');
      eq(discoverAgentConfigs(join(dir, 'nope')).agents.length, 0, '目录缺失给空清单');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('subagents: 覆盖解析——模型 / 工具集收窄与模式边界裁剪', () => {
    const cfg = parseAgentSource('---\nname: r\ndescription: d\nmodel: m-fast\ntools: [read_file, grep, computer_use]\n---\n提示');
    const withModel = subagentOverrides(cfg, {
      resolveProvider: (m) => ({ model: m, provider: { id: 'p-fast', name: '快' } }),
      harnessTools: ['read_file', 'grep', 'shell'],
      log: () => {},
    });
    eq(withModel.model, 'm-fast', '模型被覆盖');
    eq(withModel.provider.id, 'p-fast', '提供方随模型重新解析');
    eq(withModel.toolNames.join(','), 'read_file,grep', '超出模式边界的工具被裁掉');
    const noResolver = subagentOverrides(cfg, { harnessTools: ['read_file', 'grep', 'computer_use'], log: () => {} });
    eq(noResolver.model, undefined, '解析不到提供方就不覆盖模型（沿用父会话）');
    eq(noResolver.toolNames.join(','), 'read_file,grep,computer_use', '模式允许的工具全部保留');
    const bare = subagentOverrides(parseAgentSource('---\nname: b\ndescription: d\n---\n提示'), {});
    eq(bare.toolNames, undefined, '未声明工具集就不收窄');
    eq(bare.systemPrompt, '提示');
    eq(subagentOverrides(null), null, '空配置给 null');
  });

  await test('subagents: 工具名渲染与权限默认姿态', () => {
    eq(toolLabel('task__reviewer'), 'reviewer（子代理）');
    eq(toolIconKey('task__reviewer'), 'task');
    eq(toolResourceOf('task__reviewer', { task: '审查 src' }), '审查 src');
    eq(toolLabel('task'), '派发子代理', '内置 task 标签不变');
    const policy = new PermissionPolicy(defaultRules(), { permissionMode: 'ask_when_needed' });
    eq(policy.evaluate('subagent', 'task__reviewer'), 'allow', '声明式子代理与 task 同姿态');
  });

  await test('subagents: 派发接线——子会话用专人的模型与系统提示', async () => {
    const dir = dataDir({
      'agents/reviewer.md': '---\nname: reviewer\ndescription: 代码审查\nmodel: m-fast\ntools: [read_file]\n---\n你是审查员 REPRO_MARK',
    });
    try {
      const { agents } = discoverAgentConfigs(dir);
      const cfg = findAgentConfig(agents, 'reviewer');
      const store = new SessionStore(dir);
      const harness = getHarness('standard');
      const override = subagentOverrides(cfg, {
        resolveProvider: (m) => ({ model: m, provider: { id: 'p-fast', name: '快' } }),
        harnessTools: harness.tools,
        log: () => {},
      });
      eq(override.model, 'm-fast');
      eq(override.toolNames.join(','), 'read_file');
      assert(override.systemPrompt.includes('REPRO_MARK'), '专人系统提示可用');
      // 工具定义真的能跑：spawn 注入假派发器，断言 agent 名被带到 opts
      const tool = subagentTools(agents)[0];
      let seen = null;
      const out = await tool.run({ task: '审查这段代码' }, { spawn: (task, tasks, opts) => { seen = { task, tasks, opts }; return { output: 'ok', extra: { children: [] } }; } });
      eq(out.output, 'ok');
      eq(seen.task, '审查这段代码');
      eq(seen.opts.agent, 'reviewer', '派发时带上声明式子代理名');
      let threw = null;
      try { await tool.run({ task: 'x' }, {}); } catch (e) { threw = e; }
      assert(threw && threw.message.includes('运行时上下文'), '缺 ctx 应报可读错误');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
