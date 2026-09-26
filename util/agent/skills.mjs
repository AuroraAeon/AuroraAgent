/**
 * 技能系统（对齐 kimi-code 的 Skill 理念，零依赖）：一个技能 = 一个目录下的 SKILL.md——
 * YAML frontmatter 提供 name + description，Markdown 正文是完整指令。
 *   目录清单（name + description）常驻系统提示，供模型与用户发现；
 *   正文按需加载：用户输入 /<name>（终端斜杠命令，TUI 与 Web 同源）或模型调用 skill 工具。
 * 两个来源：仓库内置 skills/（随应用分发）与 <数据目录>/skills/（用户自建，同名覆盖内置）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_DESC = 200;

/** 解析一份 SKILL.md：frontmatter 的 name / description + 正文；任一不合法返回 null */
export function parseSkillSource(text, { source = '', path = '' } = {}) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z][\w-]*)[ \t]*:[ \t]*(.*)$/.exec(line.trim());
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^['"]|['"]$/g, '');
  }
  const name = fields.name || '';
  const description = fields.description || '';
  const body = src.slice(m[0].length).trim();
  if (!NAME_RE.test(name)) return null;
  if (!description || description.length > MAX_DESC) return null;
  if (!body) return null;
  return { name, description, body, source, path };
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
      if (skill) out.push(skill);
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

/** 系统提示里的技能清单块（无技能返回 ''）；只放名称与描述，正文按需加载 */
export function skillCatalogBlock(skills = []) {
  if (!skills.length) return '';
  return [
    '可用技能：下面是技能目录，只含名称与描述。',
    '当用户请求与某个技能的描述匹配时，调用 skill 工具，把返回的指令当作本次任务的规范执行；',
    '用户也可以直接输入 /<技能名> 显式调用。没有匹配的技能时不要强行使用。',
    ...skills.map((s) => `- ${s.name}: ${s.description}`),
  ].join('\n');
}

/** 斜杠命令触发的技能注入文本（正文包进用户消息，模型当轮即可遵循） */
export function skillInvocationText(skill, arg = '') {
  const ask = String(arg || '').trim();
  return [
    `[技能：${skill.name}]`,
    skill.body,
    '[技能结束]',
    '',
    ask || '请按照上述技能的规范处理当前任务。',
  ].join('\n');
}

/** 按名称取技能（大小写不敏感） */
export function findSkill(skills, name) {
  const n = String(name || '').trim().toLowerCase();
  return skills.find((s) => s.name === n) || null;
}
