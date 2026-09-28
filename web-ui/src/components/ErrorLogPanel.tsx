/** 错误日志面板：查看前端崩溃 / 未捕获错误与本机记录（GET /api/logs/errors），可清空。 */
import { useCallback, useEffect, useState } from 'react';
import { IconRefresh, IconTrash } from '../icons';
import { clearErrorLogs, listErrorLogs } from '../api';
import { toast } from '../toast';
import type { ErrorLogEntry } from '../types';

const KIND_LABELS: Record<string, string> = {
  frontend_crash: '界面崩溃',
  frontend_unhandled: '未捕获错误',
  backend: '服务端',
  backend_request: '服务端',
};

export function ErrorLogPanel() {
  const [entries, setEntries] = useState<ErrorLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await listErrorLogs(50);
      setEntries(r.entries);
      setTotal(r.total);
      setErr('');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  }, []);

  useEffect(() => { reload().catch(() => {}); }, [reload]);

  const clear = async () => {
    try {
      const r = await clearErrorLogs();
      toast.success(`已清空 ${r.cleared} 条错误日志`);
      await reload();
    } catch (e) { toast.error('清空失败', { description: e instanceof Error ? e.message : String(e) }); }
  };

  if (err) return <p className="pv-err" role="alert">{err}</p>;

  return (
    <>
      <div className="usage-head">
        <span className="usage-head-acts">
          <button type="button" className="btn btn-link" onClick={() => { reload().catch(() => {}); }} aria-label="刷新错误日志"><IconRefresh size={13} /></button>
          <button type="button" className="btn btn-link danger" onClick={() => void clear()} disabled={!total}>
            <IconTrash size={13} /> 清空
          </button>
        </span>
      </div>
      <p className="pv-intro">
        界面崩溃与未捕获的 JS 错误会写进数据目录 <code>logs/errors.log</code>（环形保留最近 200 条），
        用于事后核对「当时到底出了什么问题」。提交 issue 时附上这里的时间与摘要会很有帮助。
      </p>
      {entries.length ? (
        <ul className="errlog">
          {entries.map((e, i) => (
            <li key={`${e.ts}-${i}`}>
              <button type="button" className="errlog-head" onClick={() => setOpen(open === `${e.ts}-${i}` ? null : `${e.ts}-${i}`)}>
                <span className={`errlog-kind k-${e.kind}`}>{KIND_LABELS[e.kind] || e.kind}</span>
                <span className="errlog-msg">{e.message}</span>
                <span className="errlog-ts">{new Date(e.ts).toLocaleString('zh-CN', { hour12: false })}</span>
              </button>
              {open === `${e.ts}-${i}` && e.detail ? <pre className="errlog-detail">{e.detail}</pre> : null}
            </li>
          ))}
        </ul>
      ) : <p className="usage-empty">暂无错误记录，很好。</p>}
    </>
  );
}
