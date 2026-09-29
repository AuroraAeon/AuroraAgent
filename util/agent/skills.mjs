/**
 * 技能系统（对齐 Agent Skills 规范的三层渐进式披露，零依赖）：
 *   L1 目录：name + description 常驻系统提示（受 token 预算治理），供模型与用户发现；
 *   L2 指令：SKILL.md 正文在被调用时整篇加载，结构化包裹 + 附属资源清单（不预读内容）；
 *   L3 资源：references/ scripts/ assets/ 等附属文件按正文引用读取，
 *            模型经只读白名单根（skillDirs）用 read_file / list_dir / grep / glob 访问。
 * frontmatter：name + description 必填；license / compatibility / metadata /
 * allowed-tools / implicit 可选。宽松校验——超限与命名不一致只告警，不拒绝加载。
 * 两个来源：仓库内置 skills/（随应用分发）与 <数据目录>/skills/（用户自建，同名覆盖内置）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from '../sse.mjs';

/** 小写字母 / 数字 / 连字符，首字符为字母或数字，总长 1~64（规范 name 约束） */
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESC = 1024;              // 规范上限：描述是模型唯一的触发路由信号
const MAX_BODY_LINES = 500;         // 规范建议值：超出应拆到 references/
const MAX_RESOURCE_DEPTH = 4;       // 附属文件枚举深度上限
const MAX_RESOURCE_FILES = 200;     // 单技能附属文件枚举条数上限
const CATALOG_BUDGET_TOKENS = 4000; // L1 目录常驻上下文的 token 预算
const RESOURCE_SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage', '.next', '.venv', '__pycache__', '.cache']);

/** 跨客户端工具名 → 本运行时工具名（allowed-tools 只取工具名，括号作用域不解析） */
const TOOL_ALIAS = {
  bash: 'shell', read: 'read_file', write: 'write_file', edit: 'edit_file',
  grep: 'grep', glob: 'glob', fetch: 'web_fetch', ls: 'list_dir',
};

const stripQuotes = (s) => String(s ?? '').trim().replace(/^['"]|['"]$/g, '');

/** `allowed-tools: Bash(git:*) Read` → ['shell', 'read_file']；括号作用域丢弃 */
function parseAllowedTools(value) {
  const out = [];
  for (const token of String(value || '').split(/[\s,]+/)) {
    const name = token.split('(')[0].trim();
    if (!name) continue;
    const mapped = TOOL_ALIAS[name.toLowerCase()] || name;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out;
}

const implicitOff = (v) => ['false', 'no', '0', 'off'].includes(String(v ?? '').trim().toLowerCase());

/**
 * 解析一份 SKILL.md：frontmatter 字段 + 正文 + 附属资源索引。
 * 硬拒：无 frontmatter / name 非法 / description 为空 / 正文为空（缺了任一项模型就无法发现或执行）。
 * 软告警（进 warnings，不阻塞）：description 超长、正文超行、name 与父目录名不一致。
 */
export function parseSkillSource(text, { source = '', path = '' } = {}) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return null;
  const fields = {};
  const metadata = {};
  let lastTop = '';
  for (const raw of m[1].split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const kv = /^-?[ \t]*([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(trimmed);
    if (!kv) continue;
    const value = stripQuotes(kv[2]);
    // 缩进行归属上一个顶层键：metadata 的 key: value 块
    if (/^[ \t]/.test(raw) && lastTop === 'metadata') { metadata[kv[1].toLowerCase()] = value; continue; }
    fields[kv[1].toLowerCase()] = value;
    lastTop = kv[1].toLowerCase();
  }
  const name = fields.name || '';
  const description = fields.description || '';
  const body = src.slice(m[0].length).trim();
  if (!NAME_RE.test(name)) return null;
  if (!description) return null;
  if (!body) return null;

  const warnings = [];
  if (description.length > MAX_DESC) warnings.push(`description ${description.length} 字符，超过规范上限 ${MAX_DESC}，会挤占目录空间`);
  const bodyLines = body.split('\n').length;
  if (bodyLines > MAX_BODY_LINES) warnings.push(`正文 ${bodyLines} 行，超过建议上限 ${MAX_BODY_LINES} 行，宜拆分到 references/`);
  const dir = path ? basename(dirname(path)) : '';
  if (dir && dir !== name) warnings.push(`name 与父目录名不一致（目录 ${dir}），规范要求二者相同`);

  return {
    name, description, body, source, path,
    dir: path ? dirname(path) : '',
    license: fields.license || '',
    compatibility: fields.compatibility || '',
    metadata,
    allowedTools: parseAllowedTools(fields['allowed-tools'] || fields.allowed_tools),
    implicit: !implicitOff(fields.implicit),
    bodyLines,
    files: [],
    warnings,
  };
}

/** 递归枚举技能目录内的附属文件（相对技能根的路径 + 字节数；只读元数据不读内容） */
function listResources(root, dir, depth, acc) {
  if (depth > MAX_RESOURCE_DEPTH || acc.length >= MAX_RESOURCE_FILES) return acc;
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const ent of entries) {
    if (acc.length >= MAX_RESOURCE_FILES) return acc;
    if (ent.isDirectory()) {
      if (RESOURCE_SKIP_DIRS.has(ent.name)) continue;
      listResources(root, join(dir, ent.name), depth + 1, acc);
    } else if (ent.isFile() && ent.name !== 'SKILL.md') {
      const abs = join(dir, ent.name);
      try {
        acc.push({ path: relative(root, abs).split('\\').join('/'), bytes: statSync(abs).size });
      } catch { /* 单个文件不影响其余 */ }
    }
  }
  return acc;
}

/** 读一个目录下的全部技能（一层子目录，各含 SKILL.md；坏文件跳过不阻塞） */
function loadDir(dir, source) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const file = join(dir, ent.name, 'SKILL.md');
    try {
      if (!statSync(file).isFile()) continue;
      const skill = parseSkillSource(readFileSync(file, 'utf8'), { source, path: file });
      if (!skill) continue;
      skill.files = listResources(skill.dir, skill.dir, 0, []);
      out.push(skill);
    } catch { /* 单个坏技能不影响其余 */ }
  }
  return out;
}

/** 内置 skills/ 目录（随仓库 / Bundle 分发） */
export function builtinSkillsDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
}

/** 内置 + 用户两个目录；同名用户覆盖内置；按名称排序 */
export function loadSkills({ builtinDir = builtinSkillsDir(), userDir = '' } = {}) {
  const byName = new Map();
  for (const s of loadDir(builtinDir, 'builtin')) byName.set(s.name, s);
  if (userDir) for (const s of loadDir(userDir, 'user')) byName.set(s.name, s);
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** 已加载技能的去重绝对目录：只读白名单根，供模型读取技能附属文件 */
export function skillDirs(skills = []) {
  const out = [];
  for (const s of skills) {
    const d = s?.dir || (s?.path ? dirname(s.path) : '');
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/** 目录排序：剔除 implicit:false（不进模型视野，仍可 /<名称> 显式调用），内置优先、再按名称 */
function catalogOrder(skills) {
  return skills
    .filter((s) => s && s.implicit !== false)
    .slice()
    .sort((a, b) => {
      if (a.source !== b.source) return a.source === 'builtin' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
}

/**
 * 系统提示里的技能目录块（L1，无技能返回 ''）：只放名称与描述，正文按需加载。
 * 受 token 预算约束：超预算的技能不进目录，只提示可用 /<名称> 显式调用。
 */
export function skillCatalogBlock(skills = [], { budgetTokens = CATALOG_BUDGET_TOKENS } = {}) {
  const visible = catalogOrder(skills);
  if (!visible.length) return '';
  const header = [
    '可用技能：下面是技能目录，只含名称与描述。',
    '当用户请求与某个技能的描述匹配时，调用 skill 工具，把返回的指令当作本次任务的规范执行；',
    '用户也可以直接输入 /<技能名> 显式调用。没有匹配的技能时不要强行使用。',
  ];
  let used = estimateTokens(header.join('\n'));
  const lines = [];
  const push = (s) => {
    const line = `- ${s.name}: ${s.description}`;
    lines.push(line);
    used += estimateTokens(line) + 1;
  };
  push(visible[0]); // 至少保留一个，避免预算过小导致目录空置
  let hidden = 0;
  for (const s of visible.slice(1)) {
    const cost = estimateTokens(`- ${s.name}: ${s.description}`) + 1;
    if (used + cost > budgetTokens) { hidden++; continue; }
    push(s);
  }
  const tail = hidden ? [`（另有 ${hidden} 个技能未列入目录：可用 /<技能名> 显式调用）`] : [];
  return [...header, ...lines, ...tail].join('\n');
}

const fmtBytes = (n) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);

/**
 * L2 激活包裹：正文 + 技能绝对目录 + 附属资源清单（不预读内容）。
 * 结构化标记让模型能区分技能指令与普通对话，也便于压缩期识别与保护。
 */
export function renderSkillContent(skill) {
  const out = [`<skill_content name="${skill.name}">`];
  if (skill.compatibility) out.push(`<compatibility>${skill.compatibility}</compatibility>`);
  if (skill.allowedTools?.length) out.push(`<allowed_tools>${skill.allowedTools.join(' ')}</allowed_tools>`);
  out.push('', skill.body, '');
  if (skill.dir) {
    out.push(`Skill directory: ${skill.dir}`);
    out.push('技能内的相对路径（references/x.md、scripts/y.mjs 等）相对该目录解析，用 read_file / shell 以绝对路径直接访问。');
  }
  if (skill.files?.length) {
    out.push('<skill_resources>');
    for (const f of skill.files) out.push(`<file>${f.path}（${fmtBytes(f.bytes)}）</file>`);
    out.push('</skill_resources>');
  }
  out.push('</skill_content>');
  return out.join('\n');
}

/** skill 工具返回正文后追加的遵循指令 */
export const SKILL_FOLLOWUP = '请按照上述技能规范处理用户请求。';

/** 斜杠命令触发的技能注入文本（正文包进用户消息，模型当轮即可遵循） */
export function skillInvocationText(skill, arg = '') {
  const ask = String(arg || '').trim();
  return [
    renderSkillContent(skill),
    '',
    ask || '请按照上述技能的规范处理当前任务。',
  ].join('\n');
}

/** 按名称取技能（大小写不敏感；implicit:false 的技能同样可取，供显式调用） */
export function findSkill(skills, name) {
  const n = String(name || '').trim().toLowerCase();
  return skills.find((s) => s.name === n) || null;
}
