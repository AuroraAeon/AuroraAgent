/** 故障转移面板：主提供方限流 / 故障时自动切换到提供同一模型的其它提供方重试（用户无感知）。 */
import { useCallback, useEffect, useState } from 'react';
import { IconAlert, IconCheck } from '../icons';
import { getFailoverSettings, saveFailoverSettings } from '../api';

const MAX_ATTEMPTS_OPTIONS = [1, 2, 3, 4, 5];

export function FailoverPanel() {
  const [enabled, setEnabled] = useState(true);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const reload = useCallback(async () => {
    const r = await getFailoverSettings();
    setEnabled(r.providerFailover !== false);
    setMaxAttempts(r.providerFailoverMaxAttempts || 3);
    setLoaded(true);
  }, []);
  useEffect(() => { reload().catch(() => setLoaded(true)); }, [reload]);

  const save = async (patch: { providerFailover?: boolean; providerFailoverMaxAttempts?: number }) => {
    setBusy(true);
    setError('');
    try {
      const r = await saveFailoverSettings(patch);
      setEnabled(r.providerFailover !== false);
      setMaxAttempts(r.providerFailoverMaxAttempts || 3);
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="pv-intro">
        主提供方返回限流（429）、服务端错误（5xx）或网络失败时，自动切换到提供同一模型的其它提供方重试，对话不中断、不弹错误。只在上游还没发出任何内容时切换；鉴权 / 计费类错误（401 / 402 等）不转移，原样报出。
      </p>
      {error ? <p className="pv-err" role="alert"><IconAlert size={12} /> {error}</p> : null}
      <label className="switch-row">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!loaded || busy}
          onChange={(e) => { setSaved(false); save({ providerFailover: e.target.checked }).catch(() => {}); }}
        />
        <span>启用多提供方故障转移</span>
      </label>
      <div className="np-row" style={{ marginTop: 10 }}>
        <span className="np-hint" style={{ marginTop: 0 }}>最多尝试（含首次）</span>
        <div className="mode-seg" role="group" aria-label="最多尝试次数">
          {MAX_ATTEMPTS_OPTIONS.map((n) => (
            <button
              key={n}
              type="button"
              className={`mode-btn ${maxAttempts === n ? 'on' : ''}`}
              aria-pressed={maxAttempts === n}
              disabled={!loaded || busy}
              onClick={() => { setSaved(false); save({ providerFailoverMaxAttempts: n }).catch(() => {}); }}
            >
              {n}
            </button>
          ))}
        </div>
        {saved ? <span className="np-hint" style={{ marginTop: 0 }}><IconCheck size={12} /> 已保存</span> : null}
      </div>
      <p className="np-hint">
        候选为「设置 → 提供方」里模型目录包含当前模型、且配了 API 密钥的其它提供方（内置提供方优先）。同一轮对话内切换成功后沿用新提供方，避免来回抖动；用量记账归属真实产出内容的那一家。也可用环境变量 AURORAAGENT_FAILOVER=0 / AURORAAGENT_FAILOVER_MAX_ATTEMPTS=2 覆盖。
      </p>
    </>
  );
}
