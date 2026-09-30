/** @ 提及时调色板的候选组装（纯函数层）：工作目录文件 + 错误日志问题 + 跑过的命令 + 技能目录，
 *  四类按 file → problems → terminal → skill 同序合并，各自封顶。
 *  组件 MentionPalette.tsx 与 Node 测试共用本文件；零依赖，与 turn-nav / skill-rows 同组织方式。 */

export const MENTION_FILE_LIMIT = 12;
export const MENTION_OBSERVATION_LIMIT = 6;
export const MENTION_SKILL_LIMIT = 6;

/** 一条「观察」（问题 / 跑过的命令）：后端 /api/agent/observations 的行形状 */
export function normalizeObservation(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    id: String(o.id ?? ''),
    label: String(o.label ?? ''),
    at: String(o.at ?? ''),
    kind: String(o.kind ?? ''),
    text: String(o.text ?? ''),
  };
}

/** 候选项组装（调色板与键盘导航共用一份，避免两边过滤规则漂移） */
export function buildMentionItems(files, skills, problems, terminal, query) {
  const kw = String(query ?? '').trim().toLowerCase();
  const hit = (...fields) => !kw || fields.some((f) => String(f ?? '').toLowerCase().includes(kw));
  const fs = (Array.isArray(files) ? files : [])
    .filter((f) => hit(f))
    .slice(0, MENTION_FILE_LIMIT)
    .map((f) => ({ kind: 'file', key: `f:${f}`, label: String(f) }));
  const ps = (Array.isArray(problems) ? problems : [])
    .filter((p) => hit(p?.label, p?.text))
    .slice(0, MENTION_OBSERVATION_LIMIT)
    .map((p) => ({ kind: 'problems', key: `p:${p.id}`, label: p.label, at: p.at, errKind: p.kind, text: p.text }));
  const ts = (Array.isArray(terminal) ? terminal : [])
    .filter((t) => hit(t?.label, t?.text))
    .slice(0, MENTION_OBSERVATION_LIMIT)
    .map((t) => ({ kind: 'terminal', key: `t:${t.id}`, label: t.label, at: t.at, text: t.text }));
  const ss = (Array.isArray(skills) ? skills : [])
    .filter((s) => hit(s?.name, s?.description))
    .slice(0, MENTION_SKILL_LIMIT)
    .map((s) => ({ kind: 'skill', key: `s:${s.name}`, label: s.name, desc: s.description }));
  return [...fs, ...ps, ...ts, ...ss];
}
