/**
 * 终端 /cron 家族命令的纯函数层（与网页设置页「定时任务」面板同源同语义）：
 * 解析子命令、把任务格式化成可读行。终端 REPL 与测试直接 import 同一份，
 * 颜色由调用方按需上色（util/tui/theme.mjs 是唯一允许原始 SGR 的文件）。
 *
 * 子命令：
 *   /cron                      列出当前会话的定时任务
 *   /cron add <名称> | <表达式> | <到期内容>   新建；表达式写 cron 五段，或 every <分钟>
 *   /cron remove <id 前缀>      删除
 *   /cron run <id 前缀>         立即跑一次（把到期内容作为一条用户消息发出去）
 *   /cron on|off <id 前缀>      启用 / 停用
 *
 * id 允许只写前缀：任务 id 是 UUID，终端里敲全串不现实。
 */
import { isValidCron } from '../jobs/cron-expr.mjs';

/** 把「表达式或 every N」解析成 schedule；失败返回 null */
export function parseScheduleText(raw) {
  const text = String(raw || '').trim();
  const every = /^every\s+(\d+)$/i.exec(text);
  if (every) {
    const minutes = Number(every[1]);
    if (!Number.isInteger(minutes) || minutes < 1) return null;
    return { kind: 'interval', everyMs: minutes * 60000 };
  }
  return isValidCron(text) ? { kind: 'cron', expr: text } : null;
}

/** 任务 → 单行展示（名称 + 计划 + 状态 + id 前缀） */
export function formatJobLine(job) {
  const when = job.schedule?.kind === 'cron'
    ? `cron ${job.schedule.expr}`
    : `每 ${Math.round((job.schedule?.everyMs || 0) / 60000)} 分钟`;
  const next = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString('zh-CN', { hour12: false }) : '—';
  const state = job.enabled ? `下次 ${next}` : '已停用';
  const last = job.lastStatus ? ` · 上次 ${job.lastStatus}` : '';
  return `${job.name} · ${when} · ${state}${last} · ${String(job.id).slice(0, 8)}`;
}

/** 任务列表 → 展示行；空列表给一句可操作提示 */
export function formatJobLines(jobs) {
  if (!jobs || !jobs.length) return ['当前会话没有定时任务：/cron add <名称> | <表达式> | <到期内容>'];
  return jobs.map(formatJobLine);
}

/**
 * 解析 /cron 参数。
 * @returns {{ action:'list' } | { action:'add', name, schedule, prompt } | { action:'remove'|'run'|'on'|'off', id }
 *          | { action:'error', message: string }}
 */
export function parseCronArg(raw) {
  const arg = String(raw || '').trim();
  if (!arg) return { action: 'list' };
  const verb = /^(\S+)/.exec(arg)?.[1].toLowerCase() || '';
  const rest = arg.slice(verb.length).trim();
  if (verb === 'add') {
    const parts = rest.split('|').map((s) => s.trim());
    if (parts.length < 3 || !parts[0] || !parts[2]) {
      return { action: 'error', message: '用法: /cron add <名称> | <表达式> | <到期内容>（表达式写 cron 五段或 every 30）' };
    }
    const schedule = parseScheduleText(parts[1]);
    if (!schedule) {
      return { action: 'error', message: `执行计划无法解析：${parts[1]}（cron 五段「分 时 日 月 周」，或 every <分钟>）` };
    }
    return { action: 'add', name: parts[0], schedule, prompt: parts.slice(2).join(' | ') };
  }
  if (['remove', 'rm', 'run', 'on', 'off'].includes(verb)) {
    if (!rest) return { action: 'error', message: `用法: /cron ${verb} <id 前缀>（id 见 /cron 列表）` };
    const action = verb === 'rm' ? 'remove' : verb;
    return { action, id: rest };
  }
  if (verb === 'help') return { action: 'help' };
  return { action: 'error', message: '用法: /cron [add <名称> | <表达式> | <内容>|remove <id>|run <id>|on|off <id>]' };
}

/** 按 id 前缀取任务：唯一命中返回 { job }，无命中 / 多命中都给中文原因 */
export function pickJob(jobs, prefix) {
  const p = String(prefix || '').trim().toLowerCase();
  if (!p) return { error: '请给出任务 id（/cron 列表里每行末尾那一段）' };
  const hits = (jobs || []).filter((j) => String(j.id).toLowerCase().startsWith(p));
  if (!hits.length) return { error: `没有 id 以 ${p} 开头的任务` };
  if (hits.length > 1) return { error: `id 前缀 ${p} 命中 ${hits.length} 个任务，请多写几位` };
  return { job: hits[0] };
}
