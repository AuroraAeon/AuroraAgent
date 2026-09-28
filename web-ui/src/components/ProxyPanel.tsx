/** 网络面板：Agent 沙箱出站代理（web_fetch 等工具用）——本机直连被重置的站点（如维基百科）的出路。 */
import { useCallback, useEffect, useState } from 'react';
import { IconAlert, IconCheck } from '../icons';
import { getAgentProxy, setAgentProxy } from '../api';
import { validateProxyInput } from '../proxy-input';

export function ProxyPanel() {
  const [current, setCurrent] = useState('');
  const [draft, setDraft] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const reload = useCallback(async () => {
    const r = await getAgentProxy();
    setCurrent(r.agentProxy || '');
    setDraft(r.agentProxy || '');
    setLoaded(true);
  }, []);
  useEffect(() => { reload().catch(() => setLoaded(true)); }, [reload]);

  const save = async () => {
    const invalid = validateProxyInput(draft);
    if (invalid) { setError(invalid); return; }
    setBusy(true);
    setError('');
    try {
      const r = await setAgentProxy(draft.trim());
      setCurrent(r.agentProxy || '');
      setDraft(r.agentProxy || '');
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
        Agent 沙箱内的出站请求（抓取网页等工具）默认直连；本机直连被重置的站点（如维基百科）可经本机 HTTP 代理访问。保存后即时生效，不影响模型上游请求。
      </p>
      {error ? <p className="pv-err" role="alert"><IconAlert size={12} /> {error}</p> : null}
      <div className="np-row">
        <input
          type="text"
          className="np-input"
          aria-label="本机代理地址"
          placeholder="http://127.0.0.1:7890"
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setSaved(false); setError(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') save().catch(() => {}); }}
        />
        <button type="button" className="btn btn-accent" disabled={busy || !loaded} onClick={() => save().catch(() => {})}>
          {saved ? <><IconCheck size={13} /> 已保存</> : '保存'}
        </button>
      </div>
      <p className="np-hint">
        常见本机代理端口：Clash / mihomo 7890、Surge 6152、V2Ray 10809。留空 = 直连。当前生效：{current || '直连'}
      </p>
    </>
  );
}
