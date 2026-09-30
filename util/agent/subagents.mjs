/**
 * 声明式子代理（源头 Cline 的 AgentConfigLoader）：把「常用子代理」写成配置文件，
 * 模型经 `task__<名称>` 工具直接派发，不必每次在 prompt 里描述一遍它该干什么。
 * 与既有 `task` 工具的分工：`task` 是「临场派一个通用子代理」；`task__<名称>` 是
 * 「派那个已经定义好角色、工具集与模型的专人」——两者并存，模型按需选。
 *
 * 配置形态（<数据目录>/agents/*.md，宽松 YAML frontmatter + 正文系统提示）：
 *   ---
 *   name: reviewer          # 必填；同时决定工具名 task__reviewer
 *   description: 代码审查    # 必填；模型唯一的选型信号
 *   model: <模型 ID>         # 可选；省略则随父会话
 *   tools: [read_file, grep] # 可选；省略则随派发时的模式（harness）
 *   skills: [code-review]   # 可选；随派发预载的技能
 *   ---
 *   你是一位严格的代码审查员……（正文即子代理系统提示）
 *
 * 零依赖：frontmatter 解析与 skills / rules 同规约的宽松 YAML 子集。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 声明式子代理的工具名前缀：`task__<name>`（双下划线与 MCP 的 `mcp__<server>__<tool>` 形态一致） */
export const SUBAGENT_PREFIX = 'task__';
/** 单个子代理正文（系统提示）行数上限 */
const MAX_PROMPT_LINES = 400;
/** 单个子代理 description 上限（它是模型唯一的选型信号，太长会挤占上下文） */
const MAX_DESC = 512;
/** 声明式子代理数量上限（每个都注册成一个工具，工具太多模型选不动） */
export const MAX_AGENT_CONFIGS = 24;
/** 递归列举 agents/ 的深度上限 */
const MAX_SCAN_DEPTH = 2;

const stripQuotes = (s) => String(s ?? '').trim().replace(/^['"]|['"]$/g, '');

/** `key: [a, b]` / `key: a, b` / `key: a` → 字符串数组；空值给空数组 */
function parseList(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return [];
  if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map((x) => stripQuotes(x)).filter(Boolean);
  if (v.includes(',')) return v.split(',').map((x) => stripQuotes(x)).filter(Boolean);
  return [stripQuotes(v)].filter(Boolean);
}

/**
 * 解析一份子代理配置。
 * 硬拒（返回 null）：无 frontmatter / name 或 description 为空 / 正文（系统提示）为空。
 * 软告警（进 warnings，不阻塞）：description 超长、正文超行。
 */
export function parseAgentSource(text, { path = '' } = {}) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return null;
  const fields = {};
  for (const raw of m[1].split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const kv = /^-?[ \t]*([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(trimmed);
    if (!kv) continue;
    fields[kv[1].toLowerCase()] = kv[2];
  }
  const name = stripQuotes(fields.name);
  const description = stripQuotes(fields.description);
  const systemPrompt = src.slice(m[0].length).trim();
  if (!name || !description || !systemPrompt) return null;

  const warnings = [];
  if (description.length > MAX_DESC) warnings.push(`description ${description.length} 字符，超过上限 ${MAX_DESC}，会挤占工具选择空间`);
  const lines = systemPrompt.split('\n').length;
  if (lines > MAX_PROMPT_LINES) warnings.push(`系统提示 ${lines} 行，超过建议上限 ${MAX_PROMPT_LINES} 行，宜精简`);

  // 工具名 / 技能名去重保序；工具名校验由调用方（harness.tools）做，这里只归一
  const uniq = (arr) => [...new Set(arr.map((x) => String(x).trim()).filter(Boolean))];
  return {
    name,
    description,
    model: stripQuotes(fields.model || fields['model-id'] || fields.modelId) || '',
    tools: uniq(parseList(fields.tools)),
    skills: uniq(parseList(fields.skills)),
    systemPrompt,
    path,
    warnings,
  };
}

/** 递归列举 agents/ 下的 .md（深度封顶；读不到的目录按空处理） */
function listAgentFiles(dir, depth = 0, out = []) {
  if (depth > MAX_SCAN_DEPTH) return out;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) { listAgentFiles(abs, depth + 1, out); continue; }
    if (e.name.toLowerCase().endsWith('.md')) out.push(abs);
  }
  return out;
}

/**
 * 发现声明式子代理：<数据目录>/agents/*.md。目录不存在 = 空清单，不算错。
 * @returns {{ agents: object[], warnings: string[] }}
 */
export function discoverAgentConfigs(dataDir = '') {
  const warnings = [];
  if (!dataDir) return { agents: [], warnings };
  const dir = join(resolve(dataDir), 'agents');
  if (!existsSync(dir)) return { agents: [], warnings };
  const byName = new Map();
  for (const abs of listAgentFiles(dir)) {
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const cfg = parseAgentSource(text, { path: abs });
    if (!cfg) { warnings.push(`子代理配置解析失败，已跳过：${abs}`); continue; }
    if (byName.has(cfg.name)) warnings.push(`子代理「${cfg.name}」重复定义（${byName.get(cfg.name).path} 与 ${abs}），后者生效`);
    byName.set(cfg.name, cfg);
    for (const w of cfg.warnings) warnings.push(`${abs}：${w}`);
  }
  const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_AGENT_CONFIGS);
  if (byName.size > MAX_AGENT_CONFIGS) warnings.push(`子代理配置超过 ${MAX_AGENT_CONFIGS} 个，仅加载前 ${MAX_AGENT_CONFIGS} 个`);
  return { agents, warnings };
}

/** 按名字取声明式子代理（大小写不敏感；找不到给 null） */
export function findAgentConfig(agents = [], name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  return agents.find((a) => a.name.toLowerCase() === key) || null;
}

/** 工具名 → 声明式子代理名（`task__reviewer` → `reviewer`）；不是该命名空间给 null */
export function subagentNameOf(toolName) {
  const n = String(toolName || '');
  if (!n.startsWith(SUBAGENT_PREFIX)) return null;
  return n.slice(SUBAGENT_PREFIX.length) || null;
}

/**
 * 声明式子代理 → 工具定义（与内置 task 并存）。
 * 参数只有一个 task：专人专用，不需要 tasks 数组（要并行就多调几次）。
 */
export function subagentTools(agents = []) {
  return agents.map((a) => ({
    name: `${SUBAGENT_PREFIX}${a.name}`,
    description: `派发「${a.name}」子代理：${a.description}`,
    action: 'subagent',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '子任务描述（自含：目标、范围、产出要求）' },
      },
      required: ['task'],
    },
    run(args, ctx) {
      const spawn = ctx?.spawn;
      if (typeof spawn !== 'function') throw new Error('子代理工具需要会话运行时上下文');
      return spawn(args.task, null, { agent: a.name });
    },
  }));
}

/**
 * 派发选项 → 子 turn 覆盖（swarm.mjs 消费）：专人专用的模型 / 工具集 / 系统提示。
 * 模型覆盖需要提供方解析器（http.mjs 注入）：解析不到就沿用父会话的并告警，
 * 绝不因为一条配置写错就让整个派发失败。
 * @returns {{ agent, model?, provider?, toolNames?, skills?, systemPrompt }}
 */
export function subagentOverrides(agent, { resolveProvider = null, harnessTools = [], log = () => {} } = {}) {
  if (!agent) return null;
  const out = { agent: agent.name, systemPrompt: agent.systemPrompt, skills: agent.skills };
  if (agent.model) {
    const hit = typeof resolveProvider === 'function' ? resolveProvider(agent.model) : null;
    if (hit?.provider && hit.model) {
      out.model = hit.model;
      out.provider = hit.provider;
    } else {
      log('warn', '声明式子代理的模型解析不到提供方，沿用父会话', { agent: agent.name, model: agent.model });
    }
  }
  if (agent.tools.length) {
    // 只保留当前模式允许的工具：专人也不能越过 harness 的权限边界
    const allowed = new Set(harnessTools);
    const kept = agent.tools.filter((t) => allowed.has(t));
    const dropped = agent.tools.filter((t) => !allowed.has(t));
    if (dropped.length) log('warn', '声明式子代理的工具被模式边界裁掉', { agent: agent.name, dropped });
    if (kept.length) out.toolNames = kept;
  }
  return out;
}
