/**
 * cron 工具（迁移 OpenBitFun v1.0.2 #3149 的 cron 工具本地化）：
 * 让模型自己在会话里创建 / 改写 / 查询 / 删除 / 立即运行定时任务，
 * 以及读取当前时间（排障「现在几点」类提问）。
 *
 * 与内置工具同形态入列：{ name, description, parameters, action, run }，
 * 经 harness.tools 门控（仅 standard / ultimate 收录）+ policy 默认 ask。
 * 执行副作用（到期在目标会话跑注入式 turn）由调用方经 runJob 注入，
 * 工具本身只做存储与校验——测试可注入假执行器，不打真上游。
 */
import { JobValidationError, computeNextRunAt } from '../jobs/store.mjs';
import { isValidCron } from '../jobs/cron-expr.mjs';

export const CRON_TOOL_NAME = 'cron';

const SCHEDULE_DESC = '执行计划：{ kind:"cron", expr:"分 时 日 月 周" } 或 { kind:"interval", everyMs:毫秒 }（间隔下限 60 秒）';

export const CRON_TOOL_DEF = {
  name: CRON_TOOL_NAME,
  description: '管理本机定时任务：add 新建、update 改写、list 列出、remove 删除、run 立即跑一次、get_time 读当前时间。'
    + '任务到期时会在指定会话里以 prompt 作为用户消息跑一轮 Agent。',
  action: 'cron',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'update', 'list', 'remove', 'run', 'get_time'],
        description: '要执行的操作',
      },
      job_id: { type: 'string', description: '任务 ID（update / remove / run 必填；add 不需要）' },
      name: { type: 'string', description: '任务名称（add 必填，update 可选改写）' },
      session_id: { type: 'string', description: '到期时在哪个会话里运行（add 必填；默认当前会话）' },
      prompt: { type: 'string', description: '到期时要发给模型的内容（add 必填）' },
      schedule: { type: 'object', description: SCHEDULE_DESC },
      enabled: { type: 'boolean', description: '是否启用（update 可切换；false 即暂停）' },
    },
    required: ['action'],
  },
};

function fmtJob(job, now) {
  const when = job.schedule.kind === 'cron' ? `cron ${job.schedule.expr}` : `每 ${Math.round(job.schedule.everyMs / 1000)} 秒`;
  const next = job.nextRunAt ? new Date(job.nextRunAt).toLocaleString('zh-CN', { hour12: false }) : '已停用';
  const last = job.lastRunAt ? new Date(job.lastRunAt).toLocaleString('zh-CN', { hour12: false }) : '从未';
  return `[${job.name}] id=${job.id} ${when} ${job.enabled ? '启用' : '停用'} 下次 ${next} 上次 ${last}${job.lastStatus ? `（${job.lastStatus}）` : ''} 会话 ${job.sessionId}`;
}

/**
 * 建 cron 工具运行时。
 * @param jobs JobStore 实例
 * @param opts { sessionId, runJob: (job) => Promise<void>, publish: () => void }
 */
export function createCronRuntime(jobs, { sessionId = '', runJob = null, publish = () => {} } = {}) {
  const tools = [{
    ...CRON_TOOL_DEF,
    run: async (args) => {
      const action = String(args.action || '').trim();
      const sid = String(args.session_id || '').trim() || sessionId;
      if (action === 'get_time') {
        const now = new Date();
        return `当前时间 ${now.toLocaleString('zh-CN', { hour12: false })}（${now.getTime()} ms，本地时区 UTC${-now.getTimezoneOffset() / 60 >= 0 ? '+' : ''}${-now.getTimezoneOffset() / 60}）`;
      }
      if (action === 'list') {
        const rows = sid ? jobs.forSession(sid) : jobs.list();
        if (!rows.length) return '当前没有定时任务。';
        return rows.map((j) => fmtJob(j)).join('\n');
      }
      if (action === 'add') {
        if (!String(args.session_id || '').trim() && !sid) return '缺少 session_id：请指定任务在哪个会话里运行。';
        let job;
        // 校验失败回中文原因而非抛异常：模型看得懂「间隔下限 60 秒」就能自己改对重试
        try {
          job = jobs.create({
            name: args.name, sessionId: sid, prompt: args.prompt,
            schedule: args.schedule, enabled: args.enabled !== false,
          });
        } catch (e) {
          return e instanceof JobValidationError ? `创建失败：${e.message}` : `创建失败：${e.message || String(e)}`;
        }
        publish();
        return `已创建定时任务「${job.name}」：${job.schedule.kind === 'cron' ? job.schedule.expr : `每 ${Math.round(job.schedule.everyMs / 1000)} 秒`}，下次 ${new Date(job.nextRunAt).toLocaleString('zh-CN', { hour12: false })}（id=${job.id}）`;
      }
      if (!['remove', 'update', 'run'].includes(action)) {
        return `未知操作 ${action}；可用：add / update / list / remove / run / get_time`;
      }
      const id = String(args.job_id || '').trim();
      if (!id) return `操作 ${action} 需要 job_id（先用 list 查）。`;
      if (action === 'remove') {
        const ok = jobs.remove(id);
        if (ok) publish();
        return ok ? `已删除定时任务 ${id}` : `没有 id 为 ${id} 的任务`;
      }
      if (action === 'update') {
        const before = jobs.get(id);
        if (!before) return `没有 id 为 ${id} 的任务`;
        let job;
        try {
          job = jobs.update(id, (cur) => {
            const patch = {};
            if (args.name !== undefined) patch.name = String(args.name);
            if (args.prompt !== undefined) patch.prompt = String(args.prompt);
            if (args.session_id !== undefined) patch.sessionId = String(args.session_id);
            if (args.schedule !== undefined) patch.schedule = args.schedule;
            if (args.enabled !== undefined) patch.enabled = args.enabled === true;
            return Object.keys(patch).length ? patch : null;
          });
        } catch (e) {
          return e instanceof JobValidationError ? `更新失败：${e.message}` : `更新失败：${e.message || String(e)}`;
        }
        publish();
        return `已更新定时任务「${job.name}」：下次 ${job.nextRunAt ? new Date(job.nextRunAt).toLocaleString('zh-CN', { hour12: false }) : '已停用'}`;
      }
      if (action === 'run') {
        const job = jobs.get(id);
        if (!job) return `没有 id 为 ${id} 的任务`;
        if (!runJob) return '当前运行时不支持立即执行（缺少执行器）。';
        try {
          await runJob(job);
          jobs.recordRun(id, { status: 'ok' });
        } catch (e) {
          jobs.recordRun(id, { status: 'failed', error: String(e) });
          return `立即执行失败：${e.message || String(e)}`;
        }
        publish();
        return `已立即执行「${job.name}」（会话 ${job.sessionId}）`;
      }
    },
  }];
  return { tools, name: CRON_TOOL_NAME };
}

export { JobValidationError, computeNextRunAt, isValidCron };
