/** 上下文窗口占用：条 / 环二态。窄容器（侧栏收回 + 小窗）走环，宽容器走条——
 *  同一份数据两种呈现，靠容器查询切换，不靠 JS 量宽度（省一次 resize 监听与一次重排）。
 *  数据是估算口径（与后端压缩阈值同一把尺子），故文案说「约」。 */
type Props = {
  tokens: number;
  window: number;
  /** 提示缓存命中量：省下来的那部分单独标出来，别和新增占用混在一起 */
  cached?: number;
};

function fmtK(n: number): string {
  if (n >= 10000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

const RING_R = 7;
const RING_C = 2 * Math.PI * RING_R;

export function ContextMeter({ tokens, window, cached = 0 }: Props) {
  if (!(window > 0) || !(tokens > 0)) return null;
  const pct = Math.max(1, Math.min(100, Math.round((tokens / window) * 100)));
  const level = pct >= 85 ? 'crit' : pct >= 60 ? 'warn' : 'ok';
  const detail = `约 ${tokens.toLocaleString('zh-CN')} / ${window.toLocaleString('zh-CN')} token（${pct}%）`;
  return (
    <div className="ctxmeter-wrap">
      <div
        className={`ctxmeter ${level}`}
        role="status"
        aria-label={`上下文窗口占用 ${pct}%`}
        title={`上下文窗口占用：${detail}${cached ? `，其中缓存命中约 ${cached.toLocaleString('zh-CN')}` : ''}`}
      >
        {/* 环：窄容器时显示 */}
        <svg className="ctxmeter-ring" viewBox="0 0 18 18" aria-hidden="true">
          <circle className="ctxmeter-ring-track" cx="9" cy="9" r={RING_R} />
          <circle
            className="ctxmeter-ring-fill"
            cx="9" cy="9" r={RING_R}
            strokeDasharray={`${(RING_C * pct) / 100} ${RING_C}`}
          />
        </svg>
        {/* 条：宽容器时显示 */}
        <span className="ctxmeter-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
        <span className="ctxmeter-label">上下文 {detail}</span>
        {cached ? <span className="ctxmeter-cache">缓存命中 {fmtK(cached)}</span> : null}
      </div>
    </div>
  );
}
