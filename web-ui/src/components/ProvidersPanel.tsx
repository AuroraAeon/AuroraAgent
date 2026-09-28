/** 提供方面板（设置弹层）：提供方列表 + 添加 / 编辑卡片 + 模型发现选择器 + 删除确认。
 *  逻辑自原 SettingsDialog 平移；内置提供方只读，自定义提供方存 providers.json（util/providers.mjs）。 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IconAlert, IconArrowDown, IconArrowUp, IconCheck, IconClose, IconKey, IconPlus, IconSearch,
} from '../icons';
import {
  createProvider, deleteProvider, discoverModels, getFailoverQueue, listProviders, saveFailoverQueue, updateProvider,
} from '../api';
import type { ProviderRow } from '../types';
import { ProviderEditor, draftToPayload, fmtCap, validateDraft, type Candidate, type Draft } from './ProviderEditor';
import { toast } from '../toast';

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
  onProvidersChanged: () => void;
};

export function ProvidersPanel({ onProvidersChanged }: Props) {
  const pickRef = useRef<HTMLDialogElement>(null);
  const delRef = useRef<HTMLDialogElement>(null);

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
        <button type="button" className="pv-add" onClick={openAdd}>
          <IconPlus size={14} />
          添加自定义提供方
        </button>
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
