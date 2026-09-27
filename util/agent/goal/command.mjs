/**
 * /goal 斜杠命令解析与用户面文案（单一事实源：终端 REPL 与网页 Composer 共用；
 * 语义对齐 MiniMax-code packages/tui/src/application/thread-goal-command.ts）。
 * 纯函数零依赖——解析出意图对象，执行由各客户端负责（终端走 actions.mjs，
 * 网页走 /api/agent/goal/* REST，两边共享同一套语义与文案）。
 *
 * 命令面：
 *   /goal                         查看当前目标摘要
 *   /goal <objective>             创建目标；已有未完成目标则改写目标文本
 *   /goal <objective> budget=50K  创建并设 token 预算（K / M 后缀）
 *   /goal budget=50K              改当前目标预算（也接受旧式 /goal budget 50K）
 *   /goal budget=clear            清除预算上限（clear / null / none / off / 0 同义）
 *   /goal clear                   移除目标（cancel / delete 同义别名）
 *   /goal edit                    把当前目标文本填回输入框续编
 *   /goal pause | resume | stop   暂停 / 恢复 / 停止（stop = 标记完成并停止追踪）
 *   /goal help                    命令帮助
 */
import { GOAL_STATUS_LABELS } from './types.mjs';
import { goalUsageChip } from './budget.mjs';

/** 预算指令与目标文本之间的边界字符：空白、中文与全角标点（ASCII 标点不算，技术文本保住尾巴） */
const RELAXED_BOUNDARY = '[\\s\\u2026\\u3000-\\u30FF\\u4E00-\\u9FFF\\uFF00-\\uFFEF]';
const LEADING_BUDGET_RE = new RegExp(`^budget=([A-Za-z0-9.]+)(?=$|${RELAXED_BOUNDARY})`, 'iu');
const TRAILING_BUDGET_RE = new RegExp(`(^|${RELAXED_BOUNDARY})budget=([A-Za-z0-9.]+)$`, 'iu');
const SEPARATOR_BEFORE_RE = /[\s…、。！，：；？]+$/u;
const SEPARATOR_AFTER_RE = /^[\s…、。！，：；？]+/u;

/** 预算值：正整数（可带 K / M 后缀）；clear / null / none / off / 0 表示清除；其余非法 */
export function parseGoalBudgetValue(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return 'invalid';
  const normalized = value.toLowerCase();
  if (['clear', 'null', 'none', 'off'].includes(normalized) || value === '0') return null;
  const match = normalized.match(/^([0-9]+(?:\.[0-9]+)?)([km])?$/);
  if (!match) return 'invalid';
  const parsed = Number(match[1]);
  if (!Number.isFinite(parsed) || parsed <= 0) return 'invalid';
  const multiplier = match[2] === 'k' ? 1000 : match[2] === 'm' ? 1000000 : 1;
  const result = Math.round(parsed * multiplier);
  return result > 0 ? result : 'invalid';
}

/** 严格尾随形态：最后一个空白分隔的 token 恰为 budget=... 时才识别 */
function parseTrailingBudget(body) {
  const trimmed = body.trimEnd();
  const lastSpace = trimmed.search(/\s\S*$/);
  const tail = lastSpace === -1 ? trimmed : trimmed.slice(lastSpace + 1);
  if (!/^budget=[A-Za-z0-9.]*$/i.test(tail)) return null;
  const head = lastSpace === -1 ? '' : trimmed.slice(0, lastSpace).trimEnd();
  return { value: parseGoalBudgetValue(tail.slice('budget='.length)), head };
}

/** 从目标文本头部或尾部抽取 budget= 指令：invalid / double / value / none */
function extractBudgetDirective(body) {
  const trimmed = body.trim();
  const strict = parseTrailingBudget(trimmed);
  if (strict?.value === 'invalid') return { kind: 'invalid' };

  let value;
  let head;
  if (strict) {
    value = strict.value;
    head = strict.head;
  } else {
    const relaxed = TRAILING_BUDGET_RE.exec(trimmed);
    if (relaxed) {
      const parsed = parseGoalBudgetValue(relaxed[2] ?? '');
      if (parsed !== 'invalid') {
        value = parsed;
        head = trimmed.slice(0, relaxed.index + (relaxed[1] ?? '').length);
      }
    }
  }
  if (head !== undefined && value !== undefined) {
    const objective = head.replace(SEPARATOR_BEFORE_RE, '').trim();
    const leftover = LEADING_BUDGET_RE.exec(objective);
    if (leftover && parseGoalBudgetValue(leftover[1] ?? '') !== 'invalid') return { kind: 'double' };
    return { kind: 'value', value, objective };
  }

  const leading = LEADING_BUDGET_RE.exec(trimmed);
  if (leading) {
    const parsed = parseGoalBudgetValue(leading[1] ?? '');
    if (parsed !== 'invalid') {
      const objective = trimmed.slice(leading[0].length).replace(SEPARATOR_AFTER_RE, '').trim();
      return { kind: 'value', value: parsed, objective };
    }
  }
  return { kind: 'none' };
}

export const GOAL_COMMAND_HELP =
  '/goal：查看当前目标与最新状态\n' +
  '/goal <目标内容>：设立跨轮次持久目标；已有未完成目标则改写目标文本\n' +
  '/goal <目标内容> budget=50K：设立目标并一并设置 token 预算（K / M 后缀）\n' +
  '/goal budget=50K：修改当前目标的 token 预算；budget=clear 清除上限\n' +
  '/goal budget 50000：旧式写法，与 budget=50000 等价\n' +
  '/goal clear：移除当前目标（cancel / delete 为同义别名）\n' +
  '/goal edit：把当前目标文本填回输入框续编\n' +
  '/goal pause：暂停自动续跑；/goal resume：恢复暂停或受阻的目标\n' +
  '/goal stop：把目标标记为已完成并停止追踪';

/**
 * 解析 /goal 的参数（不含 /goal 前缀本身）。
 * @returns intent：view | create | budget | clear | edit | pause | resume | stop | help | error
 */
export function parseGoalCommand(rawArgs) {
  const tail = String(rawArgs ?? '').trim();
  if (!tail) return { kind: 'view' };

  const firstSpace = tail.search(/\s/);
  const headRaw = firstSpace === -1 ? tail : tail.slice(0, firstSpace);
  const head = headRaw.toLowerCase();

  // 旧式空格写法（AuroraAgent 终端既有形态）：/goal budget 50000 | clear
  if (head === 'budget') {
    const rest = firstSpace === -1 ? '' : tail.slice(firstSpace + 1).trim();
    if (!rest) return { kind: 'budget', tokenBudget: null };
    const parsed = parseGoalBudgetValue(rest);
    if (parsed === 'invalid') {
      return { kind: 'error', message: '预算值需为正整数（可带 K / M 后缀）或 clear（清除上限）' };
    }
    return { kind: 'budget', tokenBudget: parsed };
  }
  // MiniMax 写法：/goal budget=50K（单独出现时只改预算）
  if (/^budget=[A-Za-z0-9.]*$/i.test(headRaw) && tail.length === headRaw.length) {
    const parsed = parseGoalBudgetValue(headRaw.slice('budget='.length));
    if (parsed === 'invalid') {
      return { kind: 'error', message: '预算值需为正整数（可带 K / M 后缀）或 clear（清除上限）' };
    }
    return { kind: 'budget', tokenBudget: parsed };
  }

  switch (head) {
    case 'clear':
    case 'cancel':
    case 'delete':
      return tail.length > headRaw.length ? { kind: 'error', message: '/goal clear 不接受参数' } : { kind: 'clear' };
    case 'edit':
      return tail.length > headRaw.length ? { kind: 'error', message: '/goal edit 不接受参数' } : { kind: 'edit' };
    case 'pause':
      return tail.length > headRaw.length ? { kind: 'error', message: '/goal pause 不接受参数' } : { kind: 'pause' };
    case 'resume':
      return tail.length > headRaw.length ? { kind: 'error', message: '/goal resume 不接受参数' } : { kind: 'resume' };
    case 'stop':
      return tail.length > headRaw.length ? { kind: 'error', message: '/goal stop 不接受参数' } : { kind: 'stop' };
    case 'help':
      return { kind: 'help' };
    default: {
      const extraction = extractBudgetDirective(tail);
      if (extraction.kind === 'invalid') {
        return { kind: 'error', message: '预算值需为正整数（可带 K / M 后缀）或 clear（清除上限）' };
      }
      if (extraction.kind === 'double') {
        return { kind: 'error', message: 'budget= 只能出现一次' };
      }
      if (extraction.kind === 'value') {
        return extraction.objective
          ? { kind: 'create', objective: extraction.objective, tokenBudget: extraction.value }
          : { kind: 'budget', tokenBudget: extraction.value };
      }
      return { kind: 'create', objective: tail };
    }
  }
}

/** 横幅 / 查看输出的可执行操作提示（随状态裁剪，与 canTransition 语义一致） */
export function goalActionHint(status) {
  if (status === 'active') return '/goal pause · /goal edit · /goal clear';
  if (status === 'complete') return '/goal <目标内容> 开始新目标';
  if (status === 'budget_limited') return '/goal budget=更大值 抬高预算可继续 · /goal clear 移除';
  if (status === 'usage_limited') return '/goal resume · /goal edit · /goal clear';
  return '/goal resume · /goal edit · /goal clear';
}

const VERDICT_LABELS = {
  met: '已达到', not_met: '未达到', impossible: '判定不可行', unavailable: '验证不可用', inconclusive: '无结论',
};

/** /goal 查看输出的摘要（多行文本；终端与网页系统消息同源） */
export function formatGoalSummary(goal) {
  const lines = [
    `目标 · ${GOAL_STATUS_LABELS[goal.status] || goal.status}`,
    `目标内容：${goal.objective || '（空）'}`,
    `已用：${goalUsageChip(goal)}`,
    `预算：${goal.tokenBudget != null ? `${goal.tokenBudget} tokens` : '无上限'}`,
  ];
  if (goal.lastVerification) {
    const v = goal.lastVerification;
    lines.push(`最近验证：${VERDICT_LABELS[v.verdict] || v.verdict}${v.verdict === 'not_met' && v.notMetStreak ? `（连续 ${v.notMetStreak} 次）` : ''}`);
  }
  lines.push(`可用操作：${goalActionHint(goal.status)}`);
  return lines.join('\n');
}

/** 完成回执（目标转 complete 时两端展示同源文案） */
export function formatGoalReceipt(goal) {
  return `目标完成 · 用时 ${goalUsageChip(goal).split(' · ')[1] || '0s'} · ${goal.tokensUsed} tokens · ${goal.turnsUsed} 轮`;
}
