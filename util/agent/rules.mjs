/**
 * 规则（用户指令层）：把「项目约定」按条件注入系统提示，源头 Cline 的 rule-conditionals。
 * 与 skills 的分工：skills 是「按需触发的能力包」（模型或用户显式调用才加载正文）；
 * rules 是「常驻或按路径生效的规范」——只要当前上下文碰到它管的文件，它就全程在场。
 * 因此 rules 没有调用入口，只有激活判定；也正因常驻，它必须受 token 预算治理。
 *
 * 三个来源（同名时后者覆盖前者，项目约定优先于个人约定）：
 *   <数据目录>/rules/*.md                  个人规则
 *   <workspace>/.auroraagent/rules/*.md   项目规则
 *   <workspace>/AGENTS.md                 项目宪法（无 frontmatter 时整篇恒生效）
 *
 * frontmatter（宽松 YAML 子集，与 skills.mjs 同规约）：
 *   name / description  必填；description 是降级展示时唯一的识别信号
 *   paths               glob 数组，条件激活；语义对齐 Cline：
 *                        省略 = 恒生效（没有这个键就不会进入条件求值）
 *                        空数组 = 显式关闭（用户用 `paths: []` 单独关掉一条规则）
 *                        无候选路径 = 不激活（没有证据就不激活路径规则，保守）
 *                        类型非法 = fail-open（按恒生效处理，坏数据不该静默吞掉规则）
 *   always              true 时无视 paths 恒生效
 *
 * 零依赖：glob 匹配是本文件自实现的 picomatch 子集（`*` `**` `?` `[]`，dot:true）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { estimateTokens } from '../sse.mjs';

/** 规则正文常驻上下文的 token 预算：超出时降级为 name + description */
export const RULE_TOKEN_BUDGET = 4000;
/** 单条规则正文行数上限（超出应拆文件，与 skills 同纪律） */
const MAX_BODY_LINES = 500;
/** 单条规则 description 上限 */
const MAX_DESC = 1024;
/** 候选路径条数上限（用户一轮里提到的文件不会太多，封顶防呆） */
const MAX_CANDIDATES = 64;
/** 递归列举 .auroraagent/rules 的深度上限 */
const MAX_SCAN_DEPTH = 3;

const stripQuotes = (s) => String(s ?? '').trim().replace(/^['"]|['"]$/g, '');

/**
 * glob → RegExp（picomatch 子集）。语义：
 *   `**` 跨目录匹配任意层（含 0 层）；`*` 不跨 `/`；`?` 单字符；`[abc]` `[a-z]` `[!abc]` 字符类；
 *   以 `/` 开头锚定根；否则按「任意目录下」匹配（与 gitignore 的基名语义一致）；
 *   以 `/` 结尾表示目录，其下皆中；点文件默认参与匹配（dot:true）。
 */
export function globToRegExp(pattern) {
  let p = String(pattern ?? '').trim();
  if (!p) return /(?!)/; // 空模式不匹配任何路径
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const parts = p.split('/');
  // 非锚定且不含斜杠 = 基名模式，可在任意深度命中（src/**/foo.ts 这种显式写法的仍按原样）
  const baseName = !anchored && parts.length === 1;
  let re = '';
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const isLast = i === parts.length - 1;
    if (seg === '**') {
      // `**` 吞掉后面紧跟的分隔符，从而匹配 0 层（a/**/b 命中 a/b）
      re += '(?:.*/)?';
      if (isLast) re += '[^/]*';
      continue;
    }
    if (i > 0 && !re.endsWith('(?:.*/)?')) re += '/';
    else if (i > 0) { /* 上一段已自带分隔符 */ }
    re += segmentToRegExp(seg);
  }
  const body = baseName ? `(?:.*/)?${re}(?:/.*)?` : `${re}(?:/.*)?`;
  return new RegExp(`^${body}$`);
}

/**
 * 单个路径段 → 正则片段。字符类必须成对出现：`[` 找不到配对的 `]` 时按字面量处理
 * （否则 RegExp 构造抛异常，一条坏模式就能让整个规则模块失灵）。
 */
function segmentToRegExp(seg) {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '*') { out += '[^/]*'; continue; }
    if (ch === '?') { out += '[^/]'; continue; }
    if (ch === '[') {
      const close = seg.indexOf(']', i + 1);
      if (close < 0) { out += '\\['; continue; } // 未闭合：按字面量
      let cls = seg.slice(i + 1, close);
      if (cls.startsWith('!') || cls.startsWith('^')) cls = `^${cls.slice(1)}`;
      out += `[${cls}]`;
      i = close;
      continue;
    }
    out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return out;
}

/** 单模式匹配（路径统一为正斜杠、工作目录相对的 POSIX 形态） */
export function matchGlob(pattern, path) {
  try { return globToRegExp(pattern).test(String(path || '')); } catch { return false; }
}

/** 字符串值是否「不是模式」：流式映射 / 块标量 / 明显不是 glob 的形态 */
function normalizePaths(value) {
  if (value === undefined) return { kind: 'omitted' };
  if (Array.isArray(value)) return { kind: 'array', value: value.map((v) => String(v ?? '').trim()).filter(Boolean) };
  if (typeof value === 'string') {
    const v = value.trim();
    // 流式映射 / 块标量不是模式清单：判非法走 fail-open，别把它当成一个奇怪的文件名
    if (!v || v.startsWith('{') || v.startsWith('|') || v.startsWith('>')) return { kind: 'invalid' };
    return { kind: 'array', value: v.split(',').map((x) => stripQuotes(x)).filter(Boolean) };
  }
  return { kind: 'invalid' };
}

/**
 * 解析一份规则 markdown：frontmatter + 正文。
 * 硬拒（返回 null）：无 frontmatter / name 或 description 为空 / 正文为空。
 * 软告警（进 warnings，不阻塞）：description 超长、正文超行。
 */
export function parseRuleSource(text, { source = '', path = '' } = {}) {
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
  // paths 是唯一可能带数组字面量的字段，单独解析（宽松 YAML 子集：`key: [a, b]`）
  const rawPaths = fields.paths;
  if (rawPaths !== undefined) fields.paths = parseInlineList(rawPaths);
  const name = stripQuotes(fields.name);
  const description = stripQuotes(fields.description);
  const body = src.slice(m[0].length).trim();
  if (!name || !description || !body) return null;

  const warnings = [];
  if (description.length > MAX_DESC) warnings.push(`description ${description.length} 字符，超过上限 ${MAX_DESC}，会挤占规则预算`);
  const bodyLines = body.split('\n').length;
  if (bodyLines > MAX_BODY_LINES) warnings.push(`正文 ${bodyLines} 行，超过建议上限 ${MAX_BODY_LINES} 行，宜拆分文件`);

  const paths = normalizePaths(fields.paths);
  const always = ['true', 'yes', '1', 'on'].includes(String(fields.always ?? '').trim().toLowerCase());
  return {
    name, description, body, source, path,
    dir: path ? path.replace(/\/[^/]*$/, '') : '',
    paths: paths.kind === 'array' ? paths.value : null,
    pathsKind: paths.kind,
    always,
    warnings,
  };
}

/** `key: [a, b]` / `key: a, b` / `key:` → 数组；其余形态原样返回字符串 */
function parseInlineList(raw) {
  const v = String(raw ?? '').trim();
  if (!v) return [];
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((s) => stripQuotes(s)).filter(Boolean);
  }
  if (v.includes(',')) return v.split(',').map((s) => stripQuotes(s)).filter(Boolean);
  return v;
}

/**
 * 条件激活判定（四态，语义对齐 Cline 的 evaluatePathsConditional）。
 * @returns {{ active: boolean, reason: string, matched?: string[] }}
 */
export function ruleActive(rule, { paths = [] } = {}) {
  if (!rule) return { active: false, reason: '空规则' };
  if (rule.always) return { active: true, reason: 'always' };
  if (rule.pathsKind === 'omitted') return { active: true, reason: '省略 paths，恒生效' };
  if (rule.pathsKind === 'invalid') return { active: true, reason: 'paths 类型非法，fail-open 按恒生效' };
  const patterns = rule.paths || [];
  if (!patterns.length) return { active: false, reason: 'paths 为空数组，显式关闭' };
  const candidates = (paths || []).map((p) => String(p || '').replace(/\\/g, '/')).filter(Boolean).slice(0, MAX_CANDIDATES);
  if (!candidates.length) return { active: false, reason: '无候选路径，不激活' };
  const matched = patterns.filter((pat) => candidates.some((c) => matchGlob(pat, c)));
  if (!matched.length) return { active: false, reason: '候选路径未命中任何模式' };
  return { active: true, reason: '命中路径模式', matched };
}

/** 递归列举目录下的 .md（深度封顶；读不到的目录按空处理） */
function listRuleFiles(dir, depth = 0, out = []) {
  if (depth > MAX_SCAN_DEPTH) return out;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) { listRuleFiles(abs, depth + 1, out); continue; }
    if (e.name.toLowerCase().endsWith('.md')) out.push(abs);
  }
  return out;
}

/**
 * 发现规则：项目 → 个人，后者同名覆盖前者（项目约定优先于个人约定，与 Cline 相反——
 * 本地单用户场景下「这个仓库怎么干活」比「我个人的习惯」更该说话）。
 * @param {{ workspace?: string, dataDir?: string }} opts
 * @returns {{ rules: object[], warnings: string[] }}
 */
export function discoverRules({ workspace = '', dataDir = '' } = {}) {
  const warnings = [];
  const byName = new Map();
  // 顺序即优先级：先个人、后项目（.auroraagent/rules）、最后仓库根 AGENTS.md——
  // 同名时后写的覆盖先写的，于是「这个仓库怎么干活」压倒「我个人的习惯」
  const sources = [];
  if (dataDir) sources.push({ dir: join(resolve(dataDir), 'rules'), source: 'data' });
  if (workspace) {
    const ws = resolve(workspace);
    sources.push({ dir: join(ws, '.auroraagent', 'rules'), source: 'workspace-rules' });
    sources.push({ dir: ws, source: 'workspace' });
  }

  // AGENTS.md 是单文件，其余是目录
  const files = [];
  for (const s of sources) {
    if (s.source === 'workspace') {
      const f = join(s.dir, 'AGENTS.md');
      if (existsSync(f)) files.push({ abs: f, source: s.source });
      continue;
    }
    for (const abs of listRuleFiles(s.dir)) files.push({ abs, source: s.source });
  }

  for (const { abs, source } of files) {
    let text = '';
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    const rule = parseRuleSource(text, { source, path: abs });
    if (!rule) {
      // 单文件宪法没有 frontmatter：整篇当作恒生效规则（name 取文件名）
      const body = String(text || '').trim();
      if (body && source === 'workspace') {
        byName.set('AGENTS.md', {
          name: 'AGENTS.md', description: '项目宪法（仓库根 AGENTS.md，无 frontmatter，整篇恒生效）',
          body, source, path: abs, dir: abs.replace(/\/[^/]*$/, ''),
          paths: null, pathsKind: 'omitted', always: true, warnings: [],
        });
        continue;
      }
      warnings.push(`规则文件解析失败，已跳过：${abs}`);
      continue;
    }
    const prev = byName.get(rule.name);
    if (prev && prev.source !== source) warnings.push(`规则「${rule.name}」在 ${prev.path} 与 ${abs} 同名，后者生效`);
    byName.set(rule.name, rule);
    for (const w of rule.warnings) warnings.push(`${abs}：${w}`);
  }
  // 稳定排序：同名时后来的覆盖先前的，输出顺序按名字定，保证两次组装的字节一致
  const rules = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { rules, warnings };
}

/**
 * 激活的规则 → 注入系统提示的文本块。
 * 预算治理：总 token 超预算时，超出的规则降级为「name + description」一行
 * （模型至少知道有这条规范、能主动去读文件），而不是整块丢弃或把上下文撑爆。
 * @returns {{ block: string, active: object[], degraded: object[], tokens: number }}
 */
export function rulesBlock(rules = [], { paths = [], budget = RULE_TOKEN_BUDGET, toggles = null } = {}) {
  const active = [];
  const degraded = [];
  let tokens = 0;
  const lines = [];
  for (const rule of rules) {
    const verdict = ruleActive(rule, { paths });
    if (!verdict.active) continue;
    // 用户显式关闭的规则不注入（toggle 表存在且该项为 false）
    if (toggles && Object.prototype.hasOwnProperty.call(toggles, rule.name) && toggles[rule.name] === false) continue;
    const cost = estimateTokens(rule.body) + 8;
    if (tokens + cost <= budget) {
      tokens += cost;
      lines.push(`### ${rule.name}\n${rule.description}\n\n${rule.body}`);
      active.push({ rule, mode: 'full', tokens: cost });
    } else {
      const lite = `### ${rule.name}\n${rule.description}`;
      tokens += estimateTokens(lite) + 4;
      lines.push(lite);
      degraded.push({ rule, mode: 'lite' });
    }
  }
  return { block: lines.length ? `【项目规则】\n${lines.join('\n\n')}` : '', active, degraded, tokens };
}

/** toggle 表解析：`{ [name]: boolean }`，坏值忽略（单叶容错） */
export function parseRulesConfig(saved) {
  const seg = saved?.rules;
  if (!seg || typeof seg !== 'object') return { toggles: {} };
  const toggles = {};
  for (const [k, v] of Object.entries(seg)) {
    if (typeof v === 'boolean') toggles[k] = v;
  }
  return { toggles };
}

/**
 * 收集候选路径（规则条件激活的「当前上下文」）：用户本轮发言 + 会话里出现过的文件路径。
 * 与 Cline 的 extractPathLikeStrings 同思路但更保守：先剥掉代码围栏与 URL，再只认
 * 「看起来像路径」的 token（含 / 或带常见后缀），最后并入会话记录里工具真正碰过的路径——
 * 后者是硬证据（读过 / 改过的文件就在管辖区里），比自然语言猜测可靠得多。
 */
export function collectCandidatePaths({ input = '', records = [] } = {}) {
  const out = new Set();
  const text = String(input || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\b\w+:\/\/[^\s]+/g, ' ');
  // 直接按「合法路径字符」切分：中英文标点、空白、emoji 全都当分隔符，天然兼容 CJK 语境
  for (const token of text.split(/[^A-Za-z0-9._@~/-]+/)) {
    const t = token.replace(/^[./]+/, '').replace(/[.,;:!?]+$/, '');
    if (!t || t.length > 300) continue;
    if (!(t.includes('/') || /\.[A-Za-z0-9]{1,12}$/.test(t))) continue;
    out.add(t);
  }
  for (const r of records || []) {
    if (r.t !== 'tool_call') continue;
    const a = r.args || {};
    for (const key of ['path', 'file', 'dir', 'pattern']) {
      const v = a[key];
      if (typeof v === 'string' && v && v.length <= 300 && !/[*?\[\]]/.test(v)) out.add(v);
    }
  }
  return [...out].slice(0, MAX_CANDIDATES);
}
