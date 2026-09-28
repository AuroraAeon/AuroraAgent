/** 故障转移面板：主提供方限流 / 故障时自动切换到提供同一模型的其它提供方重试（用户无感知）。
 *  行形态对齐「外观 / 通用」面板（ap-block + ap-card + ap-row）：标题 + 描述 + 右控件；
 *  「最多尝试（含首次）」用 SegmentedControl（radiogroup 语义 + 滑块指示器）；
 *  超时三件套用 NumberField（ms 后缀，0 = 禁用）；熔断健康芯片按三态着色，
 *  支持单家 / 全量重置（对齐 CC Switch 的熔断器与手动恢复）。保存即时生效，
 *  回执走在行内（设置弹层是模态 dialog，根级 toast 会被盖住）。 */
import { useCallback, useEffect, useState } from 'react';
import { IconAlert, IconCheck, IconRefresh } from '../icons';
import { getFailoverSettings, listProviders, resetFailoverState, saveFailoverSettings } from '../api';
import type { CircuitHealth, FailoverSettings } from '../types';
import { SegmentedControl, type SegmentedOption } from '../SegmentedControl';
import { Switch } from '../Switch';
import { NumberField } from '../NumberField';

/** 最多尝试（含首次）：区间与后端 FAILOVER_ATTEMPT_LIMITS 一致（1..5），hint 即该项语义 */
const MAX_ATTEMPTS_OPTIONS: SegmentedOption[] = [
  { value: 1, label: '1', hint: '不转移，失败即报错' },
  { value: 2, label: '2', hint: '首次 + 1 次转移' },
  { value: 3, label: '3', hint: '首次 + 2 次转移' },
  { value: 4, label: '4', hint: '首次 + 3 次转移' },
  { value: 5, label: '5', hint: '首次 + 4 次转移' },
];
const DEFAULT_MAX_ATTEMPTS = 3;
/** 超时钳制上限（与后端 FAILOVER_TIMEOUT_LIMITS 一致：0..1 小时，0 = 禁用） */
const TIMEOUT_MAX_MS = 3_600_000;

/** 熔断三态的中文与语义色（closed=ok / open=danger / half_open=warn，走 tokens.css 令牌） */
const STATE_LABEL: Record<CircuitHealth['state'], string> = { closed: '正常', open: '已开闸', half_open: '探测中' };
const STATE_CLASS: Record<CircuitHealth['state'], string> = { closed: 'ok', open: 'danger', half_open: 'warn' };
/** 展示序：不健康的排前面，用户一眼看到要处理的那家 */
const STATE_ORDER: Record<CircuitHealth['state'], number> = { open: 0, half_open: 1, closed: 2 };

/** 开闸时刻的人类可读化 */
function relTime(ts: number): string {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

/** 健康行的一句话摘要：状态 + 连续失败 + 错误率 + 最近错误（截断防撑行） */
function healthDetail(h: CircuitHealth): string {
  const parts: string[] = [];
  if (h.state === 'open') parts.push(`${relTime(h.openedAt) || '已'}开闸，期间不再尝试`);
  else if (h.state === 'half_open') parts.push('探测中：放行一次请求验证是否恢复');
  if (h.consecutiveFailures > 0) parts.push(`连续失败 ${h.consecutiveFailures} 次`);
  if (h.totalRequests > 0) parts.push(`错误率 ${Math.round(h.errorRate * 100)}%（${h.failedRequests}/${h.totalRequests}）`);
  if (!parts.length) parts.push('暂无失败记录');
  if (h.lastError) {
    const text = h.lastError.length > 60 ? `${h.lastError.slice(0, 60)}…` : h.lastError;
    parts.push(`最近：${text}`);
  }
  return parts.join('；');
}

export function FailoverPanel() {
  const [settings, setSettings] = useState<FailoverSettings | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const reload = useCallback(async () => {
    const [r, pv] = await Promise.all([getFailoverSettings(), listProviders()]);
    setSettings(r);
    setNames(Object.fromEntries(pv.providers.map((p) => [p.id, p.name])));
    setLoaded(true);
  }, []);
  useEffect(() => { reload().catch((e) => { setLoaded(true); setError(e instanceof Error ? e.message : String(e)); }); }, [reload]);

  /** 行内回执 1.8s 后自动消退，避免常驻抢注意力 */
  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(false), 1800);
    return () => window.clearTimeout(t);
  }, [saved]);

  const save = async (patch: Parameters<typeof saveFailoverSettings>[0]) => {
    setBusy(true);
    setError('');
    try {
      setSettings(await saveFailoverSettings(patch));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** 手动恢复熔断器：providerId 缺省重置全部并清空热切换偏好 */
  const reset = async (providerId?: string) => {
    setBusy(true);
    setError('');
    try {
      const r = await resetFailoverState(providerId);
      setSettings((s) => (s ? { ...s, health: r.health } : s));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const enabled = settings ? settings.providerFailover !== false : true;
  const maxAttempts = settings?.providerFailoverMaxAttempts || DEFAULT_MAX_ATTEMPTS;
  const fo = settings?.failover;
  const current = MAX_ATTEMPTS_OPTIONS.find((o) => o.value === maxAttempts) || MAX_ATTEMPTS_OPTIONS[2];
  const health = [...(settings?.health || [])].sort((a, b) =>
    STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.consecutiveFailures - a.consecutiveFailures || a.providerId.localeCompare(b.providerId));

  return (
    <div className="ap-block">
      <div className="ap-head">
        <h4 className="ap-title">多提供方故障转移</h4>
        <p className="ap-desc">
          主提供方返回限流（429）、服务端错误（5xx）、超时或网络失败时，自动切换到提供同一模型的其它提供方重试，对话不中断、不弹错误。只在上游还没发出任何内容时切换；鉴权 / 计费类错误（401 / 402 等）与请求体问题（400 / 422 等）不转移，也不计入健康度，原样报出。
        </p>
      </div>

      {error ? <p className="pv-err" role="alert"><IconAlert size={12} /> {error}</p> : null}

      <div className="ap-card">
        <div className="ap-row">
          <div className="ap-row-text">
            <span className="ap-row-t">启用多提供方故障转移</span>
            <span className="ap-row-d">关闭后主提供方出错直接报出，不再尝试其它提供方；超时与熔断也一并停用。</span>
          </div>
          <Switch
            checked={enabled}
            onChange={(v) => { setSaved(false); save({ providerFailover: v }).catch(() => {}); }}
            ariaLabel="启用多提供方故障转移"
            disabled={!loaded || busy}
          />
        </div>

        <div className="ap-row" data-off={enabled ? undefined : ''}>
          <div className="ap-row-text">
            <span className="ap-row-t">最多尝试（含首次）</span>
            <span className="ap-row-d">
              {enabled
                ? `当前 ${maxAttempts} 次尝试（${current.hint}）；开启后每家只试一次，失败的尝试不计费、不弹错误，切换成功后本轮沿用新提供方。`
                : '启用故障转移后生效：1 = 不转移，失败即报错；数值越大越肯换路，也越容易把配额摊到多家。'}
            </span>
          </div>
          <div className="fo-seg-cell">
            <SegmentedControl
              value={maxAttempts}
              options={MAX_ATTEMPTS_OPTIONS}
              onChange={(n) => { setSaved(false); save({ providerFailoverMaxAttempts: n }).catch(() => {}); }}
              ariaLabel="最多尝试（含首次）"
              disabled={!loaded || busy || !enabled}
            />
            <span className="fo-status" aria-live="polite">
              {busy ? '保存中…' : null}
              {!busy && saved ? <><IconCheck size={12} /> 已保存</> : null}
            </span>
          </div>
        </div>

        <div className="ap-row" data-off={enabled ? undefined : ''}>
          <div className="ap-row-text">
            <span className="ap-row-t">首包超时</span>
            <span className="ap-row-d">上游接受请求后多久没吐出第一个字节即判失败并换路（尚未向用户发出内容，可透明切换）。0 = 禁用。</span>
          </div>
          <NumberField
            value={fo?.firstByteMs ?? 0}
            min={0}
            max={TIMEOUT_MAX_MS}
            suffix="ms"
            ariaLabel="首包超时（毫秒，0 = 禁用）"
            onChange={(n) => { setSaved(false); save({ failover: { firstByteMs: n } }).catch(() => {}); }}
          />
        </div>

        <div className="ap-row" data-off={enabled ? undefined : ''}>
          <div className="ap-row-text">
            <span className="ap-row-t">空闲超时</span>
            <span className="ap-row-d">流式回答途中多久没有新内容即中断本次回答（已收到的内容保留，不换路）。0 = 禁用。</span>
          </div>
          <NumberField
            value={fo?.idleMs ?? 0}
            min={0}
            max={TIMEOUT_MAX_MS}
            suffix="ms"
            ariaLabel="空闲超时（毫秒，0 = 禁用）"
            onChange={(n) => { setSaved(false); save({ failover: { idleMs: n } }).catch(() => {}); }}
          />
        </div>

        <div className="ap-row" data-off={enabled ? undefined : ''}>
          <div className="ap-row-text">
            <span className="ap-row-t">响应超时</span>
            <span className="ap-row-d">上游多久没返回响应头的总时限，避免界面永久转圈；超时按可转移错误换路。0 = 禁用。</span>
          </div>
          <NumberField
            value={fo?.nonStreamMs ?? 0}
            min={0}
            max={TIMEOUT_MAX_MS}
            suffix="ms"
            ariaLabel="响应超时（毫秒，0 = 禁用）"
            onChange={(n) => { setSaved(false); save({ failover: { nonStreamMs: n } }).catch(() => {}); }}
          />
        </div>
      </div>

      <div className="ap-card">
        <div className="ap-row">
          <div className="ap-row-text">
            <span className="ap-row-t">熔断健康</span>
            <span className="ap-row-d">连续失败或错误率超阈值的提供方会被临时跳过（熔断），冷却后自动放行一次探测；重置立即恢复并清空热切换偏好。</span>
          </div>
          <button
            type="button"
            className="btn btn-link"
            onClick={() => { setSaved(false); reset().catch(() => {}); }}
            disabled={!loaded || busy}
          >
            <IconRefresh size={12} /> 全部重置
          </button>
        </div>
        {health.map((h) => (
          <div className="ap-row fo-health-row" key={h.providerId}>
            <div className="ap-row-text">
              <span className="ap-row-t">
                {names[h.providerId] || h.providerId}
                <span className={`fo-chip ${STATE_CLASS[h.state]}`}>{STATE_LABEL[h.state]}</span>
              </span>
              <span className="ap-row-d">{healthDetail(h)}</span>
            </div>
            {h.state !== 'closed' || h.consecutiveFailures > 0 ? (
              <button
                type="button"
                className="btn btn-link"
                onClick={() => { setSaved(false); reset(h.providerId).catch(() => {}); }}
                disabled={!loaded || busy}
              >
                重置
              </button>
            ) : null}
          </div>
        ))}
        {!health.length ? (
          <div className="ap-row">
            <div className="ap-row-text"><span className="ap-row-d">还没有提供方健康数据。</span></div>
          </div>
        ) : null}
      </div>

      <p className="ap-desc">
        候选按「设置 → 提供方 → 故障转移队列」的编排顺序优先，队列为空时回退按模型目录匹配（内置提供方在前）；队列成员无密钥、不含当前模型或已熔断时自动跳过。同一轮对话内切换成功后沿用新提供方，避免来回抖动；用量记账归属真实产出内容的那一家。转移成功后会记住这家（偏好有效期内同模型优先走它，超时自动回退默认顺序）。也可用环境变量 AURORAAGENT_FAILOVER=0 / AURORAAGENT_FAILOVER_MAX_ATTEMPTS=2 覆盖盘上配置。
      </p>
    </div>
  );
}
