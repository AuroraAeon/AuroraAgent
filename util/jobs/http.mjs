/**
 * 定时任务 HTTP 面：GET/POST /api/jobs（列表 / 新建）、DELETE /api/jobs/<id>、
 * POST /api/jobs/<id>/run（立即跑一次）与 /toggle（启停开关）、GET /api/jobs/events（jobs_changed 长连接）。
 * 从 web.mjs 拆出以守住房「单文件约 500 行」预算——web.mjs 只保留一行委派。
 *
 * 迁移 OpenBitFun v1.0.2 #3149 的 cron 能力本地化落地。与 /api/agent/* 的关系：
 *  - 数据（jobs.json）由 util/jobs/store.mjs 单点持有，store 实例由 util/agent/http.mjs 创建后注入——
 *    cron 工具与 REST 面必须共享同一个 store，否则两处各写一份 jobs.json 会互相覆盖；
 *  - 「到期跑什么」由 util/jobs/schedule.mjs 的 onDue 注入（在目标会话跑注入式 turn），
 *    本模块只暴露「立即跑一次」这一个手动入口，同样复用那个执行器。
 */
import { JobStore, JobValidationError } from './store.mjs';
import { subscribeJobEvents, publishJobEvent } from './bus.mjs';

// id 段后可选 /run 与 /toggle 两个手动入口；events 是 SSE 长连接，靠精确路径先判
const JOB_ID_RE = /^\/api\/jobs\/([0-9a-f-]{36})(?:\/(run|toggle))?$/;

function readBody(req, limit) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/**
 * @param deps { jobs: JobStore, log, runJob: (job) => Promise<void> }
 * @returns {(req, res, url) => Promise<boolean>} 只处理 /api/jobs 前缀；未命中返回 false
 */
export function createJobsApi(deps) {
  const { jobs, log = () => {}, runJob = null } = deps;

  /** 变更后统一走总线广播：让设置面板 / 终端 / 在跑的 turn 都重读，而不是等下次切分类才发现列表是旧的 */
  const changed = (sessionId = '') => publishJobEvent({ sessionId, jobs: jobs.list() });

  return async function handleJobsApi(req, res, url) {
    if (req.method === 'GET' && url === '/api/jobs') {
      const qs = new URL(req.url, 'http://localhost').searchParams;
      const sid = String(qs.get('sessionId') || '');
      json(res, 200, { jobs: sid ? jobs.forSession(sid) : jobs.list() });
      return true;
    }

    if (req.method === 'POST' && url === '/api/jobs') {
      const body = await readBody(req, 256 * 1024);
      try {
        const job = jobs.create(body);
        log('info', '定时任务已创建', { jobId: job.id, sessionId: job.sessionId });
        changed(job.sessionId);
        json(res, 200, { job });
      } catch (e) {
        if (!(e instanceof JobValidationError)) throw e;
        json(res, 400, { error: { message: e.message, code: e.code } });
      }
      return true;
    }

    const match = JOB_ID_RE.exec(url);
    if (match) {
      const id = match[1];
      const sub = match[2] || '';
      if (!sub && req.method === 'DELETE') {
        const job = jobs.get(id);
        const removed = jobs.remove(id);
        if (removed) {
          log('info', '定时任务已删除', { jobId: id });
          changed(job?.sessionId || '');
        }
        json(res, 200, { removed });
        return true;
      }
      if (sub === 'run' && req.method === 'POST') {
        const job = jobs.get(id);
        if (!job) { json(res, 404, { error: { message: '任务不存在或已删除' } }); return true; }
        if (!runJob) { json(res, 501, { error: { message: '当前运行时不支持立即执行（缺少执行器）' } }); return true; }
        try {
          await runJob(job);
          jobs.recordRun(id, { status: 'ok' });
        } catch (e) {
          jobs.recordRun(id, { status: 'failed', error: String(e) });
          log('error', '定时任务执行失败', { jobId: id, error: String(e) });
          json(res, 500, { error: { message: `执行失败：${e.message || String(e)}` } });
          return true;
        }
        changed(job.sessionId);
        json(res, 200, { ok: true, job: jobs.get(id) });
        return true;
      }
      if (sub === 'toggle' && req.method === 'POST') {
        const body = await readBody(req, 1024);
        if (typeof body.enabled !== 'boolean') { json(res, 400, { error: { message: 'enabled 必须是布尔值' } }); return true; }
        try {
          const job = jobs.update(id, () => ({ enabled: body.enabled }));
          log('info', body.enabled ? '定时任务已启用' : '定时任务已停用', { jobId: id });
          changed(job.sessionId);
          json(res, 200, { job });
        } catch (e) {
          if (!(e instanceof JobValidationError)) throw e;
          json(res, 404, { error: { message: e.message, code: e.code } });
        }
        return true;
      }
    }

    // 任务变更长连接：cron 工具 / REST / 到期记账都经总线推一帧，客户端据此重读列表
    if (req.method === 'GET' && url === '/api/jobs/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
      // 订阅即写一条 SSE 注释冲掉响应头：否则无事件时头部滞留，客户端 fetch 永远等不到 headers
      res.write(': job-event-stream connected\n\n');
      const unsubscribe = subscribeJobEvents((frame) => { if (!res.writableEnded) res.write(frame); });
      // 连接关闭必须无条件退订：泄漏的订阅会随进程生命周期累积
      res.on('close', () => unsubscribe());
      return true;
    }

    return false;
  };
}

export { JobStore, JobValidationError, subscribeJobEvents, publishJobEvent };
