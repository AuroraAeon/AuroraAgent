/** 提供方面板（设置弹层）：提供方列表 + 添加 / 编辑卡片 + 模型发现选择器 + 删除确认。
 *  逻辑自原 SettingsDialog 平移；内置提供方只读，自定义提供方存 providers.json（util/providers.mjs）。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IconAlert, IconArrowDown, IconArrowUp, IconCheck, IconClose, IconKey, IconPlus, IconSearch,
} from '../icons';
import {
  createProvider, deleteProvider, discoverModels, getFailoverQueue, getProviderCatalog, listProviders, saveFailoverQueue, updateProvider,
} from '../api';
import type { CatalogProvider, ProviderRow } from '../types';
import { ProviderEditor, DEFAULT_CONTEXT_WINDOW, draftToPayload, fmtCap, validateDraft, type Candidate, type Draft } from './ProviderEditor';
import { toast } from '../toast';

const emptyDraft = (protocol = 'openai'): Draft => ({
  id: '', name: '', protocol, baseUrl: '', pathPrefix: '', apiKey: '',
  inputPrice: '', outputPrice: '', supportsPromptCache: false, models: [],
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
  supportsPromptCache: p.capacity?.supportsPromptCache === true,
  models: (p.models || []).map((m) => ({ id: m.id, name: m.name || '', contextWindow: fmtCap(m.contextWindow), maxTokens: fmtCap(m.maxTokens) })),
});

type Props = {
  onProvidersChanged: () => void;
};

export function ProvidersPanel({ onProvidersChanged }: Props) {
  const pickRef = useRef<HTMLDialogElement>(null);
  const delRef = useRef<HTMLDialogElement>(null);
  const catRef = useRef<HTMLDialogElement>(null);

  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [protocols, setProtocols] = useState<{ id: string; label: string }[]>([]);
  const [card, setCard] = useState<null | { kind: 'add' } | { kind: 'edit'; id: string }>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState('');
  const [picker, setPicker] = useState<{ models: Candidate[]; picked: Set<string>; q: string } | null>(null);
  const [delTarget, setDelTarget] = useState<{ id: string; name: string } | null>(null);
  // 提供方目录（util/provider-catalog.mjs，迁移自 OBF #3186）：按厂商预填端点 / 协议 / 模型 ID
  const [catOpen, setCatOpen] = useState(false);
  const [catList, setCatList] = useState<CatalogProvider[]>([]);
  const [catError, setCatError] = useState('');
  const [catPick, setCatPick] = useState('');
  const [catEp, setCatEp] = useState('');
  // 故障转移队列（providers.json 顶层 failoverQueue）：顺序即优先级，内置提供方亦可入队
  const [queue, setQueue] = useState<string[]>([]);
  const [queuePick, setQueuePick] = useState('');
  const [queueBusy, setQueueBusy] = useState(false);

  const reload = useCallback(async () => {
    // 协议列表只有 /api/providers 给；队列单独一口（写队列的响应也带最新队列与提供方）
    const [pv, fq] = await Promise.all([listProviders(), getFailoverQueue()]);
    setProviders(pv.providers);
    setProtocols(pv.protocols);
    setQueue(fq.queue);
  }, []);

  useEffect(() => { reload().catch(() => {}); }, [reload]);

  useEffect(() => {
    const p = pickRef.current;
    if (!p) return;
    if (picker && !p.open) p.showModal();
    if (!picker && p.open) p.close();
  }, [picker]);

  useEffect(() => {
    const d = catRef.current;
    if (!d) return;
    if (catOpen && !d.open) d.showModal();
    if (!catOpen && d.open) d.close();
  }, [catOpen]);

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
      toast.success(card?.kind === 'edit' ? '提供方已更新' : '提供方已添加');
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
        if (!hit.contextWindow) hit.contextWindow = c.contextWindow ? fmtCap(c.contextWindow) : DEFAULT_CONTEXT_WINDOW;
        if (!hit.maxTokens && c.maxTokens) hit.maxTokens = fmtCap(c.maxTokens);
      } else {
        next.push({ id: c.id, name: c.name || '', contextWindow: c.contextWindow ? fmtCap(c.contextWindow) : DEFAULT_CONTEXT_WINDOW, maxTokens: fmtCap(c.maxTokens) });
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
      toast.success('提供方已删除');
      if (card?.kind === 'edit' && card.id === delTarget.id) resetCard();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setDelTarget(null);
    }
  };

  /** 队列变更：整队列替换 / 追加 / 移除 / 上移下移，后端返回最新队列与提供方列表 */
  const applyQueue = async (body: Parameters<typeof saveFailoverQueue>[0]) => {
    setQueueBusy(true);
    setFormError('');
    try {
      const r = await saveFailoverQueue(body);
      setQueue(r.queue);
      setProviders(r.providers);
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setQueueBusy(false);
    }
  };

  /** 打开目录：懒拉一次 catalog，默认选中首个可激活端点的提供方 */
  const openCatalog = async () => {
    setCatError('');
    setCatOpen(true);
    if (catList.length) return;
    try {
      const list = await getProviderCatalog();
      setCatList(list);
      pickCatalogProvider(list, list.find((p) => p.endpoints.some((e) => e.supported))?.id || '');
    } catch (e) {
      setCatError(e instanceof Error ? e.message : String(e));
    }
  };

  /** 选提供方时把端点选择切到它的默认可激活端点 */
  const pickCatalogProvider = (list: CatalogProvider[], id: string) => {
    setCatPick(id);
    const p = list.find((x) => x.id === id);
    const ep = p?.endpoints.find((e) => e.supported && e.isDefault) || p?.endpoints.find((e) => e.supported) || null;
    setCatEp(ep ? ep.id : '');
  };

  /** 目录预设 → 新提供方草稿：每个激活端点一条独立预设（Token Plan 因此是独立 Key，非双 Key 字段） */
  const applyCatalog = () => {
    const p = catList.find((x) => x.id === catPick);
    const ep = p?.endpoints.find((e) => e.id === catEp);
    if (!p || !ep || !ep.supported) return;
    const base = `${p.id}-${ep.id}`.replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'provider';
    let id = base;
    for (let n = 2; providers.some((x) => x.id === id); n += 1) id = `${base}-${n}`;
    const variant = ep.id === 'default' || ep.isDefault ? '' : `（${ep.label}）`;
    setDraft({
      id, name: `${p.name}${variant}`.slice(0, 40), protocol: ep.format, baseUrl: ep.baseUrl, pathPrefix: '',
      apiKey: '', inputPrice: '', outputPrice: '',
      // 目录里标了缓存的端点（Anthropic 线路）预设直接勾上，用户不必自己判断上游能力
      supportsPromptCache: ep.promptCache === true,
      models: p.models.map((m) => ({ id: m, name: '', contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: '' })),
    });
    setErrors({}); setFormError(''); setDiscoverError('');
    setCard({ kind: 'add' });
    setCatOpen(false);
  };

  const kw = (picker?.q || '').trim().toLowerCase();
  const shown = picker ? picker.models.filter((m) => !kw || m.id.toLowerCase().includes(kw) || (m.name || '').toLowerCase().includes(kw)) : [];

  return (
    <>
      <p className="pv-intro">填入各提供方的 API 密钥即可使用其模型；内置提供方只读。密钥与单价只存本机 <code>providers.json</code>，永不提交。</p>
      {formError ? <p className="pv-err" role="alert"><IconAlert size={12} /> {formError}</p> : null}
      <div className="pv-rows">
        {providers.map((p) => (
          <div className={`pv-row ${p.builtin ? 'builtin' : ''}`} key={p.id}>
            <div className="pv-row-main">
              <span className="pv-row-name">
                {p.name}
                {p.builtin ? <span className="pv-badge">内置</span> : null}
                {p.failoverIndex != null && p.failoverIndex >= 0 ? <span className="pv-badge">队列 #{p.failoverIndex + 1}</span> : null}
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
        <div className="pv-addrow">
          <button type="button" className="pv-add" onClick={openAdd}>
            <IconPlus size={14} />
            添加自定义提供方
          </button>
          <button type="button" className="pv-add" onClick={() => { void openCatalog(); }}>
            <IconSearch size={14} />
            从目录添加
          </button>
        </div>
      )}

      <div className="foq">
        <div className="foq-head">
          <span className="foq-t">故障转移队列</span>
          <span className="foq-d">主提供方不可用时按队列顺序挑选候选（提供同模型且有密钥）；队列为空时回退按模型目录匹配，内置提供方优先。</span>
        </div>
        {queue.length ? (
          <ol className="foq-list">
            {queue.map((id, i) => {
              const p = providers.find((x) => x.id === id);
              return (
                <li className="foq-item" key={id}>
                  <span className="foq-pos">{i + 1}</span>
                  <span className="foq-name">
                    {p?.name || id}
                    {p?.builtin ? <span className="pv-badge">内置</span> : null}
                    {p && !p.hasKey ? <span className="pv-badge warn">未配置密钥</span> : null}
                  </span>
                  <span className="foq-acts">
                    <button
                      type="button"
                      className="btn btn-link"
                      aria-label={`上移 ${p?.name || id}`}
                      disabled={queueBusy || i === 0}
                      onClick={() => applyQueue({ move: { id, delta: -1 } })}
                    >
                      <IconArrowUp size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-link"
                      aria-label={`下移 ${p?.name || id}`}
                      disabled={queueBusy || i === queue.length - 1}
                      onClick={() => applyQueue({ move: { id, delta: 1 } })}
                    >
                      <IconArrowDown size={13} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-link danger"
                      aria-label={`移出队列 ${p?.name || id}`}
                      disabled={queueBusy}
                      onClick={() => applyQueue({ remove: id })}
                    >
                      <IconClose size={13} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : <p className="foq-empty">队列为空：转移时按模型目录匹配挑候选（内置提供方优先）。</p>}
        <div className="foq-add">
          <select
            className="foq-select"
            aria-label="选择要加入队列的提供方"
            value={queuePick}
            disabled={queueBusy}
            onChange={(e) => setQueuePick(e.currentTarget.value)}
          >
            <option value="">选择要加入队列的提供方…</option>
            {providers.filter((p) => !queue.includes(p.id)).map((p) => (
              <option key={p.id} value={p.id}>{p.name}{p.builtin ? '（内置）' : ''}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn"
            disabled={queueBusy || !queuePick}
            onClick={() => { const id = queuePick; setQueuePick(''); applyQueue({ add: id }); }}
          >
            <IconPlus size={13} /> 加入队列
          </button>
        </div>
      </div>
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

      <dialog ref={catRef} className="dlg dlg-narrow" closedby="any" onClose={() => setCatOpen(false)} aria-label="从提供方目录添加">
        <div className="dlg-panel">
          <header className="dlg-head">
            <h2>从目录添加提供方</h2>
            <button type="button" className="iconbtn" aria-label="关闭" onClick={() => setCatOpen(false)}><IconClose size={15} /></button>
          </header>
          <div className="dlg-body">
            <p className="pv-intro">选一家提供方与端点，baseUrl、协议与模型 ID 自动预填，只需贴 API 密钥。内置 LongCat 只读，不受影响。</p>
            {catError ? <p className="pv-err" role="alert"><IconAlert size={12} /> {catError}</p> : null}
            <div className="pv-cat">
              <ul className="pv-cat-list" role="listbox" aria-label="提供方">
                {catList.map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={catPick === p.id}
                      className={`pv-cat-item ${catPick === p.id ? 'on' : ''}`}
                      onClick={() => pickCatalogProvider(catList, p.id)}
                    >
                      <span className="pv-cat-nm">{p.name}</span>
                      <span className="pv-cat-desc">{p.description}</span>
                    </button>
                  </li>
                ))}
                {!catList.length && !catError ? <li className="mpick-status">目录为空</li> : null}
              </ul>
              <div className="pv-cat-eps">
                {(catList.find((x) => x.id === catPick)?.endpoints || []).map((e) => (
                  <label className={`pv-cat-ep ${e.supported ? '' : 'off'} ${catEp === e.id ? 'on' : ''}`} key={e.id}>
                    <input
                      type="radio"
                      name="pv-cat-ep"
                      value={e.id}
                      checked={catEp === e.id}
                      disabled={!e.supported}
                      onChange={() => setCatEp(e.id)}
                    />
                    <span className="pv-cat-ep-main">
                      <span className="pv-cat-ep-label">
                        {e.label}
                        {e.isDefault ? <span className="pv-badge">默认</span> : null}
                        {e.supported ? null : <span className="pv-badge warn">协议未适配</span>}
                      </span>
                      <code>{e.baseUrl}</code>
                    </span>
                    <span className="pv-row-proto">{e.format === 'anthropic' ? 'Anthropic Messages' : e.format}</span>
                  </label>
                ))}
                <p className="pv-cat-models">
                  预填 {catList.find((x) => x.id === catPick)?.models.length || 0} 个模型，默认上下文窗口 300K
                </p>
              </div>
            </div>
          </div>
          <footer className="dlg-foot">
            <span className="composer-flex" />
            <button type="button" className="btn" onClick={() => setCatOpen(false)}>取消</button>
            <button type="button" className="btn btn-accent" disabled={!catEp} onClick={applyCatalog}><IconCheck size={13} /> 预填并继续</button>
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
