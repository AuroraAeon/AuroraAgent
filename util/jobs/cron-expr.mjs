/**
 * 五段 cron 表达式解析与下次运行时刻计算（零依赖，纯函数）。
 * 段序：分 时 日 月 周（minute hour day-of-month month day-of-week），
 * 语法子集：星号 / 单值 / 区间 / 步进（星号或区间后接斜杠加步长）/ 逗号列表；周日同时接受 0 与 7。
 * 时间基准取本机本地时区（本地工具不该引入 tz 数据库依赖）。
 *
 * 只做「算下一次什么时候跑」，不内嵌调度器——调度在 util/jobs/schedule.mjs。
 */

const FIELD_SPEC = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'weekday', min: 0, max: 7 },
];

/** 解析单段为有序去重的合法值数组；失败返回 null */
function parseField(spec, raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const out = new Set();
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (!piece) return null;
    const stepMatch = /^(.+?)\/(\d+)$/.exec(piece);
    const base = stepMatch ? stepMatch[1].trim() : piece;
    const step = stepMatch ? Number(stepMatch[2]) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let lo;
    let hi;
    if (base === '*') { lo = spec.min; hi = spec.max; }
    else {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(base);
      if (rangeMatch) { lo = Number(rangeMatch[1]); hi = Number(rangeMatch[2]); }
      else if (/^\d+$/.test(base)) {
        lo = Number(base);
        // 单值带步长只有配范围才有意义（`5/10` 视作 5-max），与常见 cron 实现一致
        hi = stepMatch ? spec.max : lo;
      } else return null;
    }
    if (lo < spec.min || hi > spec.max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(spec.name === 'weekday' && v === 7 ? 0 : v);
  }
  return out.size ? [...out].sort((a, b) => a - b) : null;
}

/**
 * 解析 cron 表达式。
 * @returns {{ minutes:number[], hours:number[], days:number[], months:number[], weekdays:number[], dayAny:boolean, weekdayAny:boolean } | null}
 */
export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const parsed = FIELD_SPEC.map((spec, i) => parseField(spec, parts[i]));
  if (parsed.some((p) => p === null)) return null;
  const [minutes, hours, days, months, weekdays] = parsed;
  // 日与周都是具体值时按 OR 语义（Vixie cron 约定）：任一本段命中即算当天
  return {
    minutes, hours, days, months, weekdays,
    dayAny: parts[2].trim() === '*', weekdayAny: parts[4].trim() === '*',
  };
}

const MINUTE_MS = 60000;

function matchesDay(cron, d) {
  const dayHit = cron.days.includes(d.getDate());
  const weekdayHit = cron.weekdays.includes(d.getDay());
  if (cron.dayAny && cron.weekdayAny) return true;
  if (cron.dayAny) return weekdayHit;
  if (cron.weekdayAny) return dayHit;
  return dayHit || weekdayHit;
}

/**
 * 计算 from 之后（不含 from 所在分钟）的下一次运行时刻（epoch ms）。
 * 无解（例如 2 月 30 日）时搜索 4 年内的候选，仍无则返回 null。
 */
export function nextCronRun(expr, from = Date.now()) {
  const cron = typeof expr === 'string' ? parseCron(expr) : expr;
  if (!cron) return null;
  const cursor = new Date(Math.floor(Number(from) / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  const limit = cursor.getTime() + 366 * 4 * 24 * 60 * MINUTE_MS;
  for (let guard = 0; guard < 500000 && cursor.getTime() <= limit; guard += 1) {
    if (!cron.months.includes(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!matchesDay(cron, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!cron.hours.includes(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!cron.minutes.includes(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return cursor.getTime();
  }
  return null;
}

/** 表达式是否合法（工具与 HTTP 面复用同一判定） */
export function isValidCron(expr) { return parseCron(expr) !== null; }
