/**
 * 定时任务存储：<数据目录>/jobs.json，原子落盘 + 更新纪元严格推进。
 * 迁移 OpenBitFun v1.0.2 #3149 的 cron 能力本地化落地。
 *
 * 任务形状：
 *   { id, name, sessionId, prompt, schedule, enabled, createdAt, updatedAt,
 *     lastRunAt, lastStatus, lastError, nextRunAt }
 *   schedule = { kind:'cron', expr } | { kind:'interval', everyMs }
 *
 * 约定：
 *  - updatedAt 兼作纪元：任何写操作都严格 +1（同毫秒也算），陈旧快照必然失配；
 *  - nextRunAt 由 store 统一重算（enabled 切换 / 表达式改写都走 update），
 *    调度器只读不改，避免两处各算一套；
 *  - 文件损坏 / 缺失按空任务表处理并告警，绝不因为 jobs.json 坏掉挡住服务启动。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { nextCronRun } from './cron-expr.mjs';

const MAX_JOBS = 200;
const MAX_PROMPT = 8000;
const MAX_EVERY_MS = 366 * 24 * 60 * 60 * 1000;
const MIN_EVERY_MS = 60 * 1000;

export class JobValidationError extends Error {
  constructor(message) { super(message); this.code = 'JOB_BAD_INPUT'; }
}

/** 按任务定义算下一次运行时刻；非法定义返回 null */
export function computeNextRunAt(schedule, from = Date.now()) {
  if (!schedule || typeof schedule !== 'object') return null;
  if (schedule.kind === 'interval') {
    const every = Number(schedule.everyMs);
    if (!Number.isFinite(every) || every < MIN_EVERY_MS || every > MAX_EVERY_MS) return null;
    return Math.floor(Number(from)) + Math.floor(every);
  }
  if (schedule.kind === 'cron') return nextCronRun(schedule.expr, from);
  return null;
}

/** 服务端侧校验（HTTP 面与 cron 工具共用同一套中文话术） */
export function validateJobDraft(draft, { taken = [], id = null } = {}) {
  const errors = {};
  const name = String(draft.name ?? '').trim();
  if (!name) errors.name = '请填写任务名称。';
  else if (name.length > 60) errors.name = '任务名称不能超过 60 个字符。';

  const sessionId = String(draft.sessionId ?? '').trim();
  if (!sessionId) errors.sessionId = '请指定任务在哪个会话里运行。';

  const prompt = String(draft.prompt ?? '').trim();
  if (!prompt) errors.prompt = '请填写到期时要发给模型的内容。';
  else if (prompt.length > MAX_PROMPT) errors.prompt = `到期内容不能超过 ${MAX_PROMPT} 个字符。`;

  const schedule = draft.schedule && typeof draft.schedule === 'object' ? draft.schedule : null;
  if (!schedule) errors.schedule = '请提供执行计划（cron 表达式或固定间隔）。';
  else if (schedule.kind === 'interval') {
    const every = Number(schedule.everyMs);
    if (!Number.isInteger(every) || every < MIN_EVERY_MS || every > MAX_EVERY_MS) {
      errors.schedule = `固定间隔需为 ${MIN_EVERY_MS / 1000} 秒 ~ ${MAX_EVERY_MS / 86400000} 天之间的整数毫秒。`;
    }
  } else if (schedule.kind === 'cron') {
    if (computeNextRunAt(schedule) === null) errors.schedule = 'cron 表达式无法解析或永远不触发（五段：分 时 日 月 周）。';
  } else errors.schedule = '执行计划类型只支持 cron 与 interval。';

  const enabled = draft.enabled === undefined ? true : draft.enabled === true;
  return { errors, value: { name, sessionId, prompt, schedule, enabled } };
}

function normalizeJob(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const sessionId = String(raw.sessionId || '').trim();
  const prompt = String(raw.prompt || '').trim();
  if (!id || !sessionId || !prompt) return null;
  const schedule = raw.schedule && typeof raw.schedule === 'object'
    ? (raw.schedule.kind === 'interval'
      ? { kind: 'interval', everyMs: Number(raw.schedule.everyMs) || MIN_EVERY_MS }
      : { kind: 'cron', expr: String(raw.schedule.expr || '') })
    : { kind: 'interval', everyMs: 60 * 60 * 1000 };
  return {
    id,
    name: String(raw.name || '').slice(0, 60),
    sessionId,
    prompt,
    schedule,
    enabled: raw.enabled !== false,
    createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : Date.now(),
    updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : Date.now(),
    lastRunAt: Number.isFinite(raw.lastRunAt) ? Number(raw.lastRunAt) : null,
    lastStatus: ['ok', 'failed', 'missed', 'running'].includes(raw.lastStatus) ? raw.lastStatus : null,
    lastError: raw.lastError ? String(raw.lastError).slice(0, 500) : '',
    nextRunAt: Number.isFinite(raw.nextRunAt) ? Number(raw.nextRunAt) : null,
  };
}

export class JobStore {
  constructor(dataDir, { warn = () => {} } = {}) {
    this.file = join(dataDir, 'jobs.json');
    this.warn = warn;
    /** id -> job（内存为权威视图，落盘只是崩溃恢复用） */
    this.jobs = new Map();
    this.#load();
  }

  #load() {
    let rows = [];
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      rows = Array.isArray(j.jobs) ? j.jobs : [];
    } catch { rows = []; }
    for (const raw of rows) {
      const job = normalizeJob(raw);
      if (job) this.jobs.set(job.id, job);
    }
  }

  #flush() {
    const jobs = [...this.jobs.values()];
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ version: 1, jobs }, null, 2));
      renameSync(tmp, this.file);
    } catch (e) {
      this.warn('jobs 落盘失败（不影响本次变更）', { error: String(e) });
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    }
  }

  list() { return [...this.jobs.values()].sort((a, b) => a.createdAt - b.createdAt); }
  get(id) { return this.jobs.get(String(id || '')) || null; }
  forSession(sessionId) { return this.list().filter((j) => j.sessionId === String(sessionId || '')); }

  /** 新建；expectedUpdatedAt 语义不适用（没有既有任务可冲突），重名只查 id */
  create(draft) {
    const { errors, value } = validateJobDraft(draft);
    if (Object.keys(errors).length) throw new JobValidationError(Object.values(errors)[0]);
    if (this.jobs.size >= MAX_JOBS) throw new JobValidationError(`任务数量已达上限 ${MAX_JOBS} 个，请先删掉一些。`);
    const now = Date.now();
    const job = normalizeJob({
      id: randomUUID(), ...value, createdAt: now, updatedAt: now,
      nextRunAt: value.enabled ? computeNextRunAt(value.schedule, now) : null,
    });
    this.jobs.set(job.id, job);
    this.#flush();
    return job;
  }

  /**
   * 应用一次变更。mutate(job) 返回新任务对象（或 null 表示不变）。
   * expectedUpdatedAt 传入时做纪元校验，不符抛错——用户界面上的旧快照不得覆盖新状态。
   */
  update(id, mutate, { expectedUpdatedAt } = {}) {
    const cur = this.get(id);
    if (!cur) throw new JobValidationError('任务不存在或已删除。');
    if (expectedUpdatedAt !== undefined && Number(expectedUpdatedAt) !== cur.updatedAt) {
      throw new JobValidationError('任务已被其他操作修改，请重新读取后再试。');
    }
    const next = mutate(cur);
    if (!next) return cur;
    const merged = normalizeJob({ ...cur, ...next, id: cur.id, createdAt: cur.createdAt });
    if (!merged) throw new JobValidationError('任务变更后形状不合法。');
    merged.updatedAt = Math.max(Date.now(), cur.updatedAt + 1);
    // 计划或开关变了就重算下次运行；只记运行结果时不动（避免把刚到点的下次又推远）
    const scheduleChanged = JSON.stringify(merged.schedule) !== JSON.stringify(cur.schedule);
    if (scheduleChanged || merged.enabled !== cur.enabled) {
      merged.nextRunAt = merged.enabled ? computeNextRunAt(merged.schedule, merged.updatedAt) : null;
    }
    this.jobs.set(cur.id, merged);
    this.#flush();
    return merged;
  }

  remove(id) {
    const key = String(id || '');
    if (!this.jobs.has(key)) return false;
    this.jobs.delete(key);
    this.#flush();
    return true;
  }

  /** 记录一次运行结果（lastRunAt / lastStatus / lastError），并重算下次运行 */
  recordRun(id, { status, error = '', ranAt = Date.now() }) {
    return this.update(id, (job) => ({
      lastRunAt: Number(ranAt),
      lastStatus: status,
      lastError: error,
      nextRunAt: job.enabled ? computeNextRunAt(job.schedule, Number(ranAt)) : null,
    }));
  }

  /** 到期任务（enabled 且 nextRunAt <= now），按计划时刻升序 */
  due(now = Date.now()) {
    return this.list()
      .filter((j) => j.enabled && j.nextRunAt != null && j.nextRunAt <= now)
      .sort((a, b) => a.nextRunAt - b.nextRunAt);
  }
}
