/** 故障转移面板：主提供方限流 / 故障时自动切换到提供同一模型的其它提供方重试（用户无感知）。
 *  行形态对齐「外观 / 通用」面板（ap-block + ap-card + ap-row）：标题 + 描述 + 右控件；
 *  「最多尝试（含首次）」用 SegmentedControl（radiogroup 语义 + 滑块指示器）替换原先
 *  无样式的裸按钮组；保存即时生效，回执走在行内（设置弹层是模态 dialog，根级 toast 会被盖住）。 */
import { useCallback, useEffect, useState } from 'react';
import { IconAlert, IconCheck } from '../icons';
import { getFailoverSettings, saveFailoverSettings } from '../api';
import { SegmentedControl, type SegmentedOption } from '../SegmentedControl';
import { Switch } from '../Switch';

/** 最多尝试（含首次）：区间与后端 FAILOVER_ATTEMPT_LIMITS 一致（1..5），hint 即该项语义 */
const MAX_ATTEMPTS_OPTIONS: SegmentedOption[] = [
  { value: 1, label: '1', hint: '不转移，失败即报错' },
  { value: 2, label: '2', hint: '首次 + 1 次转移' },
  { value: 3, label: '3', hint: '首次 + 2 次转移' },
  { value: 4, label: '4', hint: '首次 + 3 次转移' },
  { value: 5, label: '5', hint: '首次 + 4 次转移' },
];
const DEFAULT_MAX_ATTEMPTS = 3;

export function FailoverPanel() {
  const [enabled, setEnabled] = useState(true);
  const [maxAttempts, setMaxAttempts] = useState(DEFAULT_MAX_ATTEMPTS);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const reload = useCallback(async () => {
    const r = await getFailoverSettings();
    setEnabled(r.providerFailover !== false);
    setMaxAttempts(r.providerFailoverMaxAttempts || DEFAULT_MAX_ATTEMPTS);
    setLoaded(true);
  }, []);
  useEffect(() => { reload().catch(() => setLoaded(true)); }, [reload]);

  /** 行内回执 1.8s 后自动消退，避免常驻抢注意力 */
  useEffect(() => {
    if (!saved) return;
    const t = window.setTimeout(() => setSaved(false), 1800);
    return () => window.clearTimeout(t);
  }, [saved]);

  const save = async (patch: { providerFailover?: boolean; providerFailoverMaxAttempts?: number }) => {
    setBusy(true);
    setError('');
    try {
      const r = await saveFailoverSettings(patch);
      setEnabled(r.providerFailover !== false);
      setMaxAttempts(r.providerFailoverMaxAttempts || DEFAULT_MAX_ATTEMPTS);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const current = MAX_ATTEMPTS_OPTIONS.find((o) => o.value === maxAttempts) || MAX_ATTEMPTS_OPTIONS[2];

  return (
    <div className="ap-block">
      <div className="ap-head">
        <h4 className="ap-title">多提供方故障转移</h4>
        <p className="ap-desc">
          主提供方返回限流（429）、服务端错误（5xx）或网络失败时，自动切换到提供同一模型的其它提供方重试，对话不中断、不弹错误。只在上游还没发出任何内容时切换；鉴权 / 计费类错误（401 / 402 等）不转移，原样报出。
        </p>
      </div>

      {error ? <p className="pv-err" role="alert"><IconAlert size={12} /> {error}</p> : null}

      <div className="ap-card">
        <div className="ap-row">
          <div className="ap-row-text">
            <span className="ap-row-t">启用多提供方故障转移</span>
            <span className="ap-row-d">关闭后主提供方出错直接报出，不再尝试其它提供方。</span>
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
                ? `当前 ${maxAttempts} 次尝试（${current.hint}）；失败的尝试不计费、不弹错误，切换成功后本轮沿用新提供方。`
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
      </div>

      <p className="ap-desc">
        候选为「设置 → 提供方」里模型目录包含当前模型、且配了 API 密钥的其它提供方（内置提供方优先）。同一轮对话内切换成功后沿用新提供方，避免来回抖动；用量记账归属真实产出内容的那一家。也可用环境变量 AURORAAGENT_FAILOVER=0 / AURORAAGENT_FAILOVER_MAX_ATTEMPTS=2 覆盖盘上配置。
      </p>
    </div>
  );
}
