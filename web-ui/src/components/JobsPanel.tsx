/** 定时任务面板（util/jobs/*，本地化 #3149）：到期在目标会话把 prompt 作为用户消息跑一轮 Agent。
 *  后端 util/agent/http.mjs 持有唯一的 JobStore，REST 面与 cron 工具共享它；列表经
 *  GET /api/jobs/events 的 jobs_changed 信号重读——另一客户端（终端 / 模型自己用 cron 工具）
 *  刚建的任务这里即时可见，不必等下一次打开面板。 */
import { useCallback, useEffect, useState } from 'react';
import { IconAlert, IconCheck, IconClock, IconPlay, IconPlus, IconTrash } from '../icons';
import { Switch } from '../Switch';
import { createJob, deleteJob, listJobs, listSessions, runJobNow, toggleJob } from '../api';
import { connectJobEvents } from '../job-events';
import type { JobItem, SessionMeta } from '../types';

const STATUS_LABELS: Record<string, string> = {
  ok: '上次成功', failed: '上次失败', missed: '停机错过', running: '运行中',
};

function scheduleText(job: JobItem): string {
  return job.schedule.kind === 'cron' ? `cron ${job.schedule.expr}` : `每 ${Math.round(job.schedule.everyMs / 1000)} 秒`;
}

function fmtTime(ms: number | null): string {
  if (ms == null) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type Draft = { name: string; sessionId: string; prompt: string; kind: 'cron' | 'interval'; expr: string; everyMin: string };

const emptyDraft: Draft = { name: '', sessionId: '', prompt: '', kind: 'cron', expr: '0 9 * * *', everyMin: '60' };

export function JobsPanel() {
  const [jobs, setJobs] = useState<JobItem[] | null>(null);
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);

  const reload = useCallback(async () => {
    try {
      setJobs(await listJobs());
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { reload().catch(() => {}); }, [reload]);
  // 变更信号：cron 工具 / REST / 到期记账都推一帧，重读即同步（不轮询）
  useEffect(() => connectJobEvents(() => { reload().catch(() => {}); }), [reload]);
  useEffect(() => {
    listSessions().then(setSessions).catch(() => setSessions([]));
  }, []);

  const sessionName = (id: string) => sessions.find((s) => s.id === id)?.name || id.slice(0, 8);

  const submit = async () => {
    if (!draft) return;
    setBusy('save');
    setError('');
    try {
      await createJob({
        name: draft.name.trim(),
        sessionId: draft.sessionId,
        prompt: draft.prompt.trim(),
        schedule: draft.kind === 'cron'
          ? { kind: 'cron', expr: draft.expr.trim() }
          : { kind: 'interval', everyMs: Math.round(Number(draft.everyMin) * 60000) },
      });
      setDraft(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy('');
    }
  };

  const run = async (id: string) => {
    setBusy(`run:${id}`);
    try { await runJobNow(id); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  const toggle = async (job: JobItem) => {
    setBusy(`toggle:${job.id}`);
    try { await toggleJob(job.id, !job.enabled); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  const remove = async (job: JobItem) => {
    setBusy(`del:${job.id}`);
    try { await deleteJob(job.id); await reload(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(''); }
  };

  return (
    <>
      <p className="pv-intro">
        到期时在指定会话里把内容作为用户消息跑一轮 Agent。进程内 1 秒 ticker 调度，单实例 owner 锁防止端口交接期双跑；服务停机期间到期的任务会标记「停机错过」并补跑一次。
      </p>
      {error ? <p className="pv-err" role="alert"><IconAlert size={12} /> {error}</p> : null}

      {jobs === null ? <p className="pv-hint">正在读取…</p> : null}
      {jobs && jobs.length === 0 && !draft ? <p className="pv-hint">还没有定时任务。</p> : null}
      <div className="pv-rows">
        {(jobs || []).map((job) => (
          <div className={`pv-row${job.enabled ? '' : ' builtin'}`} key={job.id}>
            <div className="pv-row-main">
              <div className="pv-row-name">
                <IconClock size={13} />
                {job.name}
                <span className={`pv-badge${job.enabled ? ' ok' : ''}`}>{job.enabled ? '启用' : '停用'}</span>
                {job.lastStatus ? <span className={`pv-badge${job.lastStatus === 'ok' ? ' ok' : ' warn'}`}>{STATUS_LABELS[job.lastStatus] || job.lastStatus}</span> : null}
              </div>
              <div className="pv-row-meta">
                <code>{scheduleText(job)}</code>
                <span>下次 {fmtTime(job.nextRunAt)}</span>
                <span>会话 {sessionName(job.sessionId)}</span>
              </div>
              {job.lastError ? <div className="pv-row-meta"><span className="pv-row-proto">{job.lastError}</span></div> : null}
            </div>
            <div className="pv-row-acts">
              <Switch checked={job.enabled} onChange={() => toggle(job).catch(() => {})} ariaLabel={`${job.name} 启用开关`} disabled={busy === `toggle:${job.id}`} />
              <button type="button" className="iconbtn" title="立即运行一次" aria-label="立即运行一次" disabled={Boolean(busy)} onClick={() => run(job.id).catch(() => {})}>
                <IconPlay size={14} />
              </button>
              <button type="button" className="iconbtn" title="删除" aria-label="删除" disabled={Boolean(busy)} onClick={() => remove(job).catch(() => {})}>
                <IconTrash size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {draft ? (
        <div className="jb-form">
          <div className="pv-field">
            <label htmlFor="jb-name">任务名称</label>
            <input id="jb-name" className="np-input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="每天早报" />
          </div>
          <div className="pv-field">
            <label htmlFor="jb-session">在哪个会话里运行</label>
            <select id="jb-session" className="np-input" value={draft.sessionId} onChange={(e) => setDraft({ ...draft, sessionId: e.target.value })}>
              <option value="">选择会话…</option>
              {sessions.map((s) => <option value={s.id} key={s.id}>{s.name}</option>)}
            </select>
            <p className="pv-hint">到期内容会作为该会话的一条用户消息，会话历史与账本照常记录。</p>
          </div>
          <div className="pv-field">
            <label htmlFor="jb-prompt">到期内容</label>
            <textarea id="jb-prompt" className="np-input jb-textarea" rows={3} value={draft.prompt} onChange={(e) => setDraft({ ...draft, prompt: e.target.value })} placeholder="汇总今天的待办并发给我" />
          </div>
          <div className="jb-sched">
            <label className="switch-row">
              <input type="radio" name="jb-kind" checked={draft.kind === 'cron'} onChange={() => setDraft({ ...draft, kind: 'cron' })} />
              cron 表达式
            </label>
            <label className="switch-row">
              <input type="radio" name="jb-kind" checked={draft.kind === 'interval'} onChange={() => setDraft({ ...draft, kind: 'interval' })} />
              固定间隔
            </label>
          </div>
          {draft.kind === 'cron' ? (
            <div className="pv-field">
              <label htmlFor="jb-expr">分 时 日 月 周</label>
              <input id="jb-expr" className="np-input" value={draft.expr} onChange={(e) => setDraft({ ...draft, expr: e.target.value })} placeholder="0 9 * * *" />
              <p className="pv-hint">每天 9:00 为 <code>0 9 * * *</code>；每 5 分钟为 <code>*/5 * * * *</code>；周日可写 0 或 7。</p>
            </div>
          ) : (
            <div className="pv-field">
              <label htmlFor="jb-every">间隔（分钟，下限 1）</label>
              <input id="jb-every" className="np-input np-input-num" value={draft.everyMin} onChange={(e) => setDraft({ ...draft, everyMin: e.target.value })} />
            </div>
          )}
          <div className="pv-actions">
            <button type="button" className="btn btn-accent" disabled={busy === 'save'} onClick={() => submit().catch(() => {})}>
              {busy === 'save' ? '创建中…' : <><IconCheck size={13} /> 创建任务</>}
            </button>
            <button type="button" className="btn" onClick={() => setDraft(null)}>取消</button>
          </div>
        </div>
      ) : (
        <div className="pv-actions">
          <button type="button" className="btn" onClick={() => setDraft({ ...emptyDraft, sessionId: sessions[0]?.id || '' })}>
            <IconPlus size={13} /> 新建任务
          </button>
        </div>
      )}
    </>
  );
}
