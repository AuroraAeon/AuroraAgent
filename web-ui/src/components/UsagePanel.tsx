/** 用量面板：账本汇总 + 近 30 天走势（零依赖 SVG 堆叠柱）+ 按模型 / 提供方 / 用途构成。 */
import { useCallback, useEffect, useState } from 'react';
import { IconRefresh } from '../icons';
import { getUsage } from '../api';
import { fmtCostYen } from '../projection';
import { toast } from '../toast';
import type { UsageBucket, UsageDay, UsageSummary } from '../types';

const fmtTok = (n: number): string => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)} 万` : String(n));

/** 缓存命中率：命中 /（命中 + 写入）。两者都为 0 时给「—」（分母为 0 的百分比是噪声） */
function cacheHitRate(t: { cachedTokens: number; cacheWriteTokens: number }): string {
  const denom = t.cachedTokens + t.cacheWriteTokens;
  if (denom <= 0) return '—';
  return `${((t.cachedTokens / denom) * 100).toFixed(1)}%`;
}

/** 逐日堆叠柱：输入 / 输出两段，柱子有最小可见高度（空天不断档也不消失） */
function DayBars({ days }: { days: UsageDay[] }) {
  const max = Math.max(1, ...days.map((d) => d.inputTokens + d.outputTokens));
  return (
    <div className="usage-chart" role="img" aria-label={`近 ${days.length} 天每日用量柱状图`}>
      {days.map((d) => {
        const total = d.inputTokens + d.outputTokens;
        const h = total ? Math.max(2, (total / max) * 100) : 0;
        const inH = total ? (d.inputTokens / total) * h : 0;
        return (
          <div className="usage-bar-col" key={d.day} title={`${d.day}：输入 ${fmtTok(d.inputTokens)} · 输出 ${fmtTok(d.outputTokens)} · ${d.requests} 次请求 · ${fmtCostYen(d.cost)}`}>
            <div className="usage-bar" style={{ height: `${h}%` }}>
              <span className="usage-bar-in" style={{ height: `${total ? (inH / h) * 100 : 0}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 构成占比条 + 明细列表（同一种形状复用四次） */
function Breakdown({ title, rows, unit }: { title: string; rows: UsageBucket[]; unit: 'cost' | 'count' }) {
  const sum = rows.reduce((a, r) => a + (unit === 'cost' ? r.cost : r.inputTokens + r.outputTokens), 0) || 1;
  return (
    <div className="usage-break">
      <h4 className="usage-break-t">{title}</h4>
      {rows.length ? (
        <>
          <div className="usage-stack" aria-hidden="true">
            {rows.map((r, i) => (
              <span key={r.key} className={`usage-stack-seg s${i % 6}`} style={{ width: `${((unit === 'cost' ? r.cost : r.inputTokens + r.outputTokens) / sum) * 100}%` }} />
            ))}
          </div>
          <ul className="usage-list">
            {rows.map((r) => (
              <li key={r.key}>
                <span className="usage-list-k" title={r.key}>{r.key}</span>
                <span className="usage-list-v">{r.requests} 次</span>
                <span className="usage-list-v">{fmtTok(r.inputTokens + r.outputTokens)}</span>
                <span className="usage-list-v">{fmtCostYen(r.cost)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : <p className="usage-empty">暂无记录</p>}
    </div>
  );
}

export function UsagePanel() {
  const [data, setData] = useState<UsageSummary | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setBusy(true);
    setErr('');
    try { setData(await getUsage()); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }, []);

  useEffect(() => { reload().catch(() => {}); }, [reload]);

  if (err) return <p className="pv-err" role="alert">{err}</p>;
  if (!data) return <p className="pv-intro">用量加载中…</p>;

  const t = data.totals;
  const st = data.stats;
  return (
    <>
      <div className="usage-head">
        <button type="button" className="btn btn-link" onClick={() => { reload().catch(() => {}); toast.info('已刷新用量统计'); }} disabled={busy}>
          <IconRefresh size={13} /> 刷新
        </button>
      </div>
      <p className="pv-intro">账本记录每一次模型请求，数据只存本机。</p>
      <dl className="kv usage-kv">
        <div><dt>请求数</dt><dd>{t.requests}</dd></div>
        <div><dt>输入</dt><dd>{fmtTok(t.inputTokens)}</dd></div>
        <div><dt>输出</dt><dd>{fmtTok(t.outputTokens)}</dd></div>
        <div><dt>累计费用</dt><dd>{fmtCostYen(t.cost)}</dd></div>
      </dl>
      {/* 提示缓存：命中 = 省下的输入，写入 = 为下次命中预付的输入。两者都不并进上面的
          「输入」列（那会让用量看起来比实际新增消耗更大）；提供方不支持时恒为 0，整块不显示 */}
      {t.cachedTokens > 0 || t.cacheWriteTokens > 0 ? (
        <dl className="kv usage-kv usage-kv-cache">
          <div><dt>缓存命中</dt><dd>{fmtTok(t.cachedTokens)}</dd></div>
          <div><dt>缓存写入</dt><dd>{fmtTok(t.cacheWriteTokens)}</dd></div>
          <div><dt>命中率</dt><dd>{cacheHitRate(t)}</dd></div>
        </dl>
      ) : null}
      {st ? (
        <>
          <div className="usage-legend" aria-hidden="true">
            <span><i className="dot dot-in" /> 输入</span>
            <span><i className="dot dot-out" /> 输出</span>
          </div>
          <DayBars days={st.byDay} />
          <div className="usage-breaks">
            <Breakdown title="按模型" rows={st.byModel} unit="cost" />
            <Breakdown title="按提供方" rows={st.byProvider} unit="cost" />
            <Breakdown title="按用途" rows={st.byPurpose} unit="cost" />
            <Breakdown title="按会话" rows={st.bySession} unit="cost" />
          </div>
          <h4 className="usage-break-t">最近请求</h4>
          <div className="usage-recent">
            <table>
              <thead><tr><th>时间</th><th>模型</th><th>输入 / 输出</th><th>缓存</th><th>费用</th></tr></thead>
              <tbody>
                {data.recent.slice(0, 8).map((r, i) => (
                  <tr key={`${r.ts}-${i}`}>
                    <td>{new Date(r.ts).toLocaleString('zh-CN', { hour12: false })}</td>
                    <td><code>{r.model || '-'}</code></td>
                    <td>{fmtTok(r.inputTokens)} / {fmtTok(r.outputTokens)}</td>
                    <td>{r.cachedTokens || r.cacheWriteTokens ? `命中 ${fmtTok(r.cachedTokens)}${r.cacheWriteTokens ? ` · 写 ${fmtTok(r.cacheWriteTokens)}` : ''}` : '-'}</td>
                    <td>{fmtCostYen(r.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}
