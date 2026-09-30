/**
 * 终端 /rules 家族命令的纯函数层（与网页设置页「规则」section 同源同语义）：
 * 解析子命令、把已发现的规则格式化成可读行。终端 REPL 与测试直接 import 同一份，
 * 颜色由调用方按需上色（util/tui/theme.mjs 是唯一允许原始 SGR 的文件）。
 *
 * 子命令：
 *   /rules                 列出已发现的规则（来源 / 条件形态 / 开关 / 告警）
 *   /rules on <名称>       开启某条规则（整表替换语义，与 REST 面一致）
 *   /rules off <名称>      关闭某条规则
 *
 * 规则文件本身的编辑在文件系统里做（<workspace>/AGENTS.md、
 * <workspace>/.auroraagent/rules/*.md、<数据目录>/rules/*.md），这里只管「开 / 关」。
 */
import { collectCandidatePaths, ruleActive } from './rules.mjs';

/**
 * 解析 /rules 参数。
 * @returns {{ action:'list' } | { action:'on'|'off', name: string }
 *          | { action:'error', message: string }}
 */
export function parseRulesArg(raw) {
  const text = String(raw || '').trim();
  if (!text) return { action: 'list' };
  const m = /^(\S+)(?:\s+(.*))?$/.exec(text);
  const sub = (m?.[1] || '').toLowerCase();
  if (sub === 'list' || sub === 'ls') return { action: 'list' };
  if (sub === 'on' || sub === 'off') {
    const name = String(m?.[2] || '').trim();
    if (!name) return { action: 'error', message: `用法: /rules ${sub} <规则名>（无参列出全部规则名）` };
    return { action: sub, name };
  }
  return { action: 'error', message: `未知子命令「${sub}」：/rules [list|on <名称>|off <名称>]` };
}

/** 来源标识 → 中文标签 */
const SOURCE_LABELS = {
  data: '个人',
  'workspace-rules': '项目',
  workspace: '宪法',
};

/** 条件形态 → 中文一句话（与 ruleActive 的 reason 同口径，但补上模式本身） */
function conditionText(rule, verdict) {
  if (rule.always) return '恒生效';
  if (rule.pathsKind === 'omitted') return '恒生效（未写 paths）';
  if (rule.pathsKind === 'invalid') return '恒生效（paths 写法非法，按恒生效处理）';
  if (!(rule.paths || []).length) return '已单独关闭（paths: []）';
  return `路径条件：${rule.paths.join('、')}${verdict.active ? '' : '（当前未命中）'}`;
}

/** 单条规则 → 单行展示（名称 + 来源 + 条件 + 开关 + 一句话说明） */
export function formatRuleLine(rule, { toggles = {}, paths = [] } = {}) {
  const off = Object.prototype.hasOwnProperty.call(toggles, rule.name) && toggles[rule.name] === false;
  const verdict = ruleActive(rule, { paths });
  const src = SOURCE_LABELS[rule.source] || rule.source || '未知';
  const state = off ? '已关闭' : (verdict.active ? '生效中' : '待命中');
  return `${rule.name} · ${src} · ${conditionText(rule, verdict)} · ${state}${rule.description ? ` — ${rule.description}` : ''}`;
}

/**
 * 规则清单 → 展示行。空清单给可操作指引（告诉用户文件该放哪儿），
 * 告警紧随其后——同名覆盖 / 解析失败这类事用户必须看得见。
 * @param {{ rules: object[], warnings?: string[], toggles?: object, paths?: string[] }} state
 */
export function formatRuleLines(state) {
  const rules = state?.rules || [];
  if (!rules.length) {
    return [
      '尚未发现规则：在 <工作目录>/AGENTS.md、<工作目录>/.auroraagent/rules/*.md 或 <数据目录>/rules/*.md 写约定即生效',
      'frontmatter 写 name / description（必填）与 paths（glob 条件激活，省略即恒生效）',
    ];
  }
  const lines = rules.map((r) => formatRuleLine(r, { toggles: state.toggles || {}, paths: state.paths || [] }));
  for (const w of state.warnings || []) lines.push(`告警：${w}`);
  lines.push('/rules off <名称> 关闭 · /rules on <名称> 重新开启');
  return lines;
}

/** 开关动作的结果 → 展示行（找不到名字时把可用名字列出来，用户不用回去再 /rules 一遍） */
export function formatRuleToggleLines(action, name, state) {
  const names = (state?.rules || []).map((r) => r.name);
  if (!names.includes(name)) {
    return [`没有名为「${name}」的规则（可用：${names.join('、') || '无'}）`];
  }
  return [`✓ 规则「${name}」已${action === 'on' ? '开启' : '关闭'}（下一轮生效）`];
}

/** 列规则时的候选路径：用户当前输入 + 会话里工具真正碰过的路径 */
export function ruleCandidatePaths({ input = '', records = [] } = {}) {
  return collectCandidatePaths({ input, records });
}
