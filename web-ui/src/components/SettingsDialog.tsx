/** 设置弹层：提供方管理（移植自 public/providers.mjs）+ 开机自启 + 数据目录 / 版本。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IconAlert, IconCheck, IconClose, IconGear, IconKey, IconPlus, IconSearch,
} from '../icons';
import {
  createProvider, deleteProvider, discoverModels, getSettings, listProviders, setAutostart, updateProvider,
} from '../api';
import type { ProviderRow, SettingsInfo } from '../types';
import { ProviderEditor, draftToPayload, fmtCap, validateDraft, type Candidate, type Draft } from './ProviderEditor';
import { McpPanel } from './McpPanel';
import { SkillsPanel } from './SkillsPanel';
import { TuiPanel } from './TuiPanel';

const emptyDraft = (protocol = 'openai'): Draft => ({
  id: '', name: '', protocol, baseUrl: '', pathPrefix: '', apiKey: '',
  inputPrice: '', outputPrice: '', models: [],
});

const draftFrom = (p: ProviderRow): Draft => ({
  id: p.id,
  name: p.name,
  protocol: p.protocol,
  baseUrl: p.baseUrl,
  pathPrefix: p.pathPrefix || '',
  apiKey: '',
  inputPrice: p.price?.input != null ? String(p.price.input) : '',
  outputPrice: p.price?.output != null ? String(p.price.output) : '',
  models: (p.models || []).map((m) => ({ id: m.id, name: m.name || '', contextWindow: fmtCap(m.contextWindow), maxTokens: fmtCap(m.maxTokens) })),
});

type Props = {
  open: boolean;
  onClose: () => void;
  onProvidersChanged: () => void;
};

export function SettingsDialog({ open, onClose, onProvidersChanged }: Props) {
  const dlgRef = useRef<HTMLDialogElement>(null);
  const pickRef = useRef<HTMLDialogElement>(null);
  const delRef = useRef<HTMLDialogElement>(null);

  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [protocols, setProtocols] = useState<{ id: string; label: string }[]>([]);
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [card, setCard] = useState<null | { kind: 'add' } | { kind: 'edit'; id: string }>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState('');
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [picker, setPicker] = useState<{ models: Candidate[]; picked: Set<string>; q: string } | null>(null);
  const [delTarget, setDelTarget] = useState<{ id: string; name: string } | null>(null);

  const reload = useCallback(async () => {
    const [pv, st] = await Promise.all([listProviders(), getSettings()]);
    setProviders(pv.providers);
    setProtocols(pv.protocols);
    setSettings(st);
  }, []);

  useEffect(() => {
    const d = dlgRef.current;
    if (!d) return;
    if (open && !d.open) { reload().catch(() => {}); d.showModal(); }
    if (!open && d.open) d.close();
  }, [open, reload]);

  useEffect(() => {
    const p = pickRef.current;
    if (!p) return;
    if (picker && !p.open) p.showModal();
    if (!picker && p.open) p.close();
  }, [picker]);

  useEffect(() => {
    const d = delRef.current;
    if (!d) return;
    if (delTarget && !d.open) d.showModal();
    if (!delTarget && d.open) d.close();
  }, [delTarget]);

  const resetCard = () => { setCard(null); setDraft(null); setErrors({}); setFormError(''); setDiscoverError(''); };

  const openAdd = () => { setDraft(emptyDraft(protocols[0]?.id || 'openai')); setErrors({}); setFormError(''); setDiscoverError(''); setCard({ kind: 'add' }); };
  const openEdit = (p: ProviderRow) => { setDraft(draftFrom(p)); setErrors({}); setFormError(''); setDiscoverError(''); setCard({ kind: 'edit', id: p.id }); };

  const save = async () => {
    if (!draft) return;
    const errs = validateDraft(draft, providers.map((p) => p.id), card?.kind === 'edit' ? card.id : null);
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setSaving(true);
    setFormError('');
    try {
      if (card?.kind === 'edit') await updateProvider(card.id, draftToPayload(draft));
      else await createProvider(draftToPayload(draft));
      await reload();
      onProvidersChanged();
      resetCard();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const discover = async () => {
    if (!draft) return;
    setDiscovering(true);
    setDiscoverError('');
    try {
      const r = await discoverModels({
        baseUrl: draft.baseUrl.trim().replace(/\/+$/, ''),
        protocol: draft.protocol,
        apiKey: draft.apiKey.trim() || undefined,
        pathPrefix: draft.pathPrefix.trim() || undefined,
      });
      setPicker({ models: r.models, picked: new Set(r.models.map((m) => m.id)), q: '' });
    } catch (e) {
      setDiscoverError(e instanceof Error ? e.message : String(e));
    } finally {
      setDiscovering(false);
    }
  };

  const applyPicked = () => {
    if (!picker || !draft) return;
    const chosen = picker.models.filter((m) => picker.picked.has(m.id));
    const next = draft.models.slice();
    for (const c of chosen) {
      const hit = next.find((m) => m.id === c.id);
      if (hit) {
        if (!hit.name && c.name) hit.name = c.name;
        if (!hit.contextWindow && c.contextWindow) hit.contextWindow = fmtCap(c.contextWindow);
        if (!hit.maxTokens && c.maxTokens) hit.maxTokens = fmtCap(c.maxTokens);
      } else {
        next.push({ id: c.id, name: c.name || '', contextWindow: fmtCap(c.contextWindow), maxTokens: fmtCap(c.maxTokens) });
      }
    }
    setDraft({ ...draft, models: next });
    setPicker(null);
  };

  const confirmDelete = async () => {
    if (!delTarget) return;
    try {
      await deleteProvider(delTarget.id);
      await reload();
      onProvidersChanged();
      if (card?.kind === 'edit' && card.id === delTarget.id) resetCard();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setDelTarget(null);
    }
  };

  const toggleAutostart = async (v: boolean) => {
    setAutostartBusy(true);
    try {
      await setAutostart(v);
      const st = await getSettings();
      setSettings(st);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setAutostartBusy(false);
    }
  };

  const kw = (picker?.q || '').trim().toLowerCase();
  const shown = picker ? picker.models.filter((m) => !kw || m.id.toLowerCase().includes(kw) || (m.name || '').toLowerCase().includes(kw)) : [];

  return (
    <>
      <dialog ref={dlgRef} className="dlg" closedby="any" onClose={onClose} aria-label="设置">
        <div className="dlg-panel">
          <header className="dlg-head">
            <h2><IconGear size={16} /> 设置</h2>
            <button type="button" className="iconbtn" aria-label="关闭设置" onClick={() => dlgRef.current?.close()}>
              <IconClose size={15} />
            </button>
          </header>
          <div className="dlg-body">
            {formError ? <p className="pv-err" role="alert"><IconAlert size={12} /> {formError}</p> : null}

            <section className="pv-sec">
              <h3 className="pv-sec-t">提供方</h3>
              <p className="pv-intro">填入各提供方的 API 密钥即可使用其模型；内置提供方只读。</p>
              <div className="pv-rows">
                {providers.map((p) => (
                  <div className={`pv-row ${p.builtin ? 'builtin' : ''}`} key={p.id}>
                    <div className="pv-row-main">
                      <span className="pv-row-name">
                        {p.name}
                        {p.builtin ? <span className="pv-badge">内置</span> : null}
                        {p.hasKey ? <span className="pv-badge ok"><IconKey size={11} /> 已配置密钥</span> : <span className="pv-badge warn">未配置密钥</span>}
                      </span>
                      <span className="pv-row-meta">
                        <code>{p.baseUrl}</code>
                        <span className="pv-row-proto">{p.protocol === 'anthropic' ? 'Anthropic Messages' : 'OpenAI 兼容'}</span>
                        <span>{p.models?.length || 0} 个模型</span>
                        {p.price ? <span>输入 ¥{p.price.input ?? 0} / 输出 ¥{p.price.output ?? 0} 每百万 tokens</span> : null}
                      </span>
                    </div>
                    {p.builtin ? null : (
                      <div className="pv-row-acts">
                        <button type="button" className="btn btn-link" onClick={() => openEdit(p)}>编辑</button>
                        <button type="button" className="btn btn-link danger" onClick={() => setDelTarget({ id: p.id, name: p.name })}>删除</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
              {card ? null : (
                <button type="button" className="pv-add" onClick={openAdd}>
                  <IconPlus size={14} />
                  添加自定义提供方
                </button>
              )}
              {card && draft ? (
                <ProviderEditor
                  draft={draft}
                  errors={errors}
                  saving={saving}
                  discovering={discovering}
                  discoverError={discoverError}
                  protocols={protocols}
                  isNew={card.kind === 'add'}
                  onChange={(patch) => setDraft({ ...draft, ...patch })}
                  onSave={save}
                  onCancel={resetCard}
                  onDiscover={discover}
                />
              ) : null}
            </section>

            <McpPanel />

            <SkillsPanel />

            <TuiPanel />

            <section className="pv-sec">
              <h3 className="pv-sec-t">服务</h3>
              <label className="switch-row">
                <input
                  type="checkbox"
                  checked={Boolean(settings?.autostart)}
                  disabled={autostartBusy}
                  onChange={(e) => toggleAutostart(e.target.checked)}
                />
                <span>开机自动启动（LaunchAgent 常驻）</span>
              </label>
              <dl className="kv">
                <div><dt>运行状态</dt><dd>{settings?.managed ? (settings.serviceRunning ? 'LaunchAgent 托管中' : '托管中（未运行）') : '手动运行'}</dd></div>
                <div><dt>端口</dt><dd>{settings?.port ?? '-'}</dd></div>
                <div><dt>数据目录</dt><dd><code>{settings?.dataDir || '-'}</code></dd></div>
                <div><dt>版本</dt><dd>v{settings?.version || '-'}</dd></div>
              </dl>
            </section>
          </div>
        </div>
      </dialog>

      <dialog ref={pickRef} className="dlg dlg-narrow" closedby="any" onClose={() => setPicker(null)} aria-label="选择要添加的模型">
        <div className="dlg-panel">
          <header className="dlg-head">
            <h2>选择要添加的模型</h2>
            <button type="button" className="iconbtn" aria-label="关闭" onClick={() => setPicker(null)}><IconClose size={15} /></button>
          </header>
          <div className="dlg-body">
            <p className="pv-intro">以下是模型提供方的可用模型，勾选要添加的模型（默认全选）。</p>
            <div className="pv-pick-search">
              <IconSearch size={14} />
              <input type="search" placeholder="搜索模型" aria-label="搜索模型" value={picker?.q || ''} onChange={(e) => setPicker((p) => (p ? { ...p, q: e.target.value } : p))} />
            </div>
            <div className="pv-pick-list">
              {shown.map((m) => (
                <label className="pv-pick-item" key={m.id}>
                  <input
                    type="checkbox"
                    checked={picker?.picked.has(m.id) || false}
                    onChange={(e) => setPicker((p) => {
                      if (!p) return p;
                      const picked = new Set(p.picked);
                      if (e.target.checked) picked.add(m.id); else picked.delete(m.id);
                      return { ...p, picked };
                    })}
                  />
                  <span className="pv-pick-nm">{m.name || m.id}</span>
                  <span className="pv-pick-id">{m.id}</span>
                  {m.contextWindow ? <span className="pv-pick-cap">{fmtCap(m.contextWindow)}</span> : null}
                </label>
              ))}
              {!shown.length ? <div className="mpick-status">没有匹配的模型</div> : null}
            </div>
          </div>
          <footer className="dlg-foot">
            <button type="button" className="btn btn-link" onClick={() => setPicker((p) => (p ? { ...p, picked: new Set(shown.map((m) => m.id)) } : p))}>全选</button>
            <button type="button" className="btn btn-link" onClick={() => setPicker((p) => (p ? { ...p, picked: new Set<string>() } : p))}>清空</button>
            <span className="composer-flex" />
            <button type="button" className="btn" onClick={() => setPicker(null)}>取消</button>
            <button type="button" className="btn btn-accent" onClick={applyPicked}><IconCheck size={13} /> 添加所选</button>
          </footer>
        </div>
      </dialog>

      <dialog ref={delRef} className="dlg dlg-narrow" closedby="any" onClose={() => setDelTarget(null)} aria-label="删除提供方确认">
        <div className="dlg-panel">
          <header className="dlg-head">
            <h2>删除提供方</h2>
          </header>
          <div className="dlg-body">
            <p>确定删除「{delTarget?.name}」吗？该提供方的模型将从选择器中移除，此操作不可撤销。</p>
          </div>
          <footer className="dlg-foot">
            <span className="composer-flex" />
            <button type="button" className="btn" onClick={() => setDelTarget(null)}>取消</button>
            <button type="button" className="btn btn-danger" onClick={confirmDelete}>删除</button>
          </footer>
        </div>
      </dialog>
    </>
  );
}
