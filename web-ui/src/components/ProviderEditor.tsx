/** 自定义提供方编辑器卡片：校验规则镜像 util/providers.mjs（同一份中文话术），模型行可编辑。 */
import type { ReactNode } from 'react';
import { IconAlert, IconPlus, IconRefresh, IconTrash } from '../icons';

export type Draft = {
  id: string; name: string; protocol: string; baseUrl: string; pathPrefix: string;
  apiKey: string; inputPrice: string; outputPrice: string;
  models: { id: string; name: string; contextWindow: string; maxTokens: string }[];
};

export type Candidate = { id: string; name?: string; contextWindow?: number; maxTokens?: number };

const ID_RE = /^[a-z][a-z0-9-]*$/;
const MODEL_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const LEGAL_API_KEY = /^[\x21-\x7e]+$/;
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/;
const BUILTIN_ID = 'longcat';
const MAX_MODELS = 200;

function isQuoted(value: string): boolean {
  const first = value[0];
  if (first !== '"' && first !== "'" && first !== '`') return false;
  return value.length > 1 && value.endsWith(first);
}

/** 读容量字段：留空 undefined（沿用默认），不可解析 NaN */
export function parseCap(text: string): number | undefined {
  const t = String(text ?? '').trim();
  if (!t) return undefined;
  const m = /^(\d+(?:\.\d+)?)([km])?$/i.exec(t);
  if (!m) return NaN;
  const scale = m[2] ? (m[2].toLowerCase() === 'k' ? 1e3 : 1e6) : 1;
  return Number(m[1]) * scale;
}

/** 容量写回最短形态：131072 -> 128K */
export function fmtCap(v?: number): string {
  if (!v || !Number.isFinite(v)) return '';
  if (v % 1e6 === 0) return `${v / 1e6}M`;
  if (v % 1e3 === 0) return `${v / 1e3}K`;
  return String(v);
}

/** 客户端预校验：与服务端 validateProviderDraft 同规则，保存时一次性展示全部错误 */
export function validateDraft(d: Draft, taken: string[], editingId: string | null): Record<string, string> {
  const errors: Record<string, string> = {};
  const id = d.id.trim();
  if (!ID_RE.test(id)) errors.id = 'Provider ID 需以小写字母开头，之后可用小写字母、数字和短横线。';
  else if (id === BUILTIN_ID) errors.id = `${BUILTIN_ID} 是内置提供方的 ID，请换一个。`;
  else if (id !== editingId && taken.includes(id)) errors.id = '已有提供方使用了这个 ID，请换一个。';

  const name = d.name.trim();
  if (!name) errors.name = '请填写显示名称，用于界面标识这个提供方。';
  else if (name.length > 40) errors.name = '显示名称不能超过 40 个字符。';

  const raw = d.baseUrl.trim();
  if (!raw) errors.baseUrl = '请填写 API 地址，例如 https://api.example.com/v1';
  else {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.baseUrl = 'API 地址只支持 HTTP 或 HTTPS，请检查协议头。';
      else if (u.username || u.password) errors.baseUrl = 'API 地址里不要带账号密码，Key 请填到下方「API 密钥」。';
    } catch { errors.baseUrl = 'API 地址无法解析：请补上协议头，例如 https://api.example.com/v1。'; }
  }

  if (d.protocol !== 'openai' && d.protocol !== 'anthropic') errors.protocol = '请选择 API 协议。';

  const filled = d.models.filter((m) => m.id.trim());
  if (d.models.length > MAX_MODELS) errors.models = `一个提供方最多添加 ${MAX_MODELS} 个模型，请删掉一些再保存。`;
  else if (!filled.length) errors.models = '至少需要一个模型：点「获取可用模型」拉取，或手填一个模型 ID。';
  else {
    const seen = new Set<string>();
    for (const m of d.models) {
      const mid = m.id.trim();
      if (!mid) continue;
      if (!MODEL_ID_RE.test(mid)) { errors.models = `模型 ID「${mid}」含非法字符，只能用字母、数字、. _ : -。`; break; }
      if (seen.has(mid)) { errors.models = `模型 ID「${mid}」重复了，每个模型 ID 只能出现一次。`; break; }
      seen.add(mid);
      if (m.name.trim().length > 60) { errors.models = `模型「${mid}」的显示名称不能超过 60 个字符。`; break; }
      for (const [key, label] of [['contextWindow', '上下文窗口'], ['maxTokens', '最大输出 token 数']] as const) {
        const cap = parseCap(m[key]);
        if (cap === undefined) continue;
        if (!(cap > 0)) { errors.models = `模型「${mid}」的${label}需为正数，例如 131072、256K 或 1M。`; break; }
      }
      if (errors.models) break;
    }
  }

  if (d.apiKey.length > 0) {
    const t = d.apiKey.trim();
    if (!t) errors.apiKey = 'API 密钥不能全是空格：请输入密钥，或留空保持不变。';
    else if (ENV_LINE.test(t) || isQuoted(t) || !LEGAL_API_KEY.test(t)) {
      errors.apiKey = 'API 密钥含不支持的字符：只能使用英文可见字符（不含空格），也不要粘贴 NAME=value 环境变量行或带引号的值。';
    }
  }

  for (const key of ['inputPrice', 'outputPrice'] as const) {
    const p = d[key].trim();
    if (!p) continue;
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0) errors[key] = `计费单价的${key === 'inputPrice' ? '输入' : '输出'}需为不小于 0 的数字，例如 ${key === 'inputPrice' ? 2 : 8}。`;
  }
  return errors;
}

/** 草稿 → 服务端载荷（apiKey 留空表示保持不变；单价只提交非空侧） */
export function draftToPayload(d: Draft): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: d.id.trim(),
    name: d.name.trim(),
    protocol: d.protocol,
    baseUrl: d.baseUrl.trim().replace(/\/+$/, ''),
    models: d.models.filter((m) => m.id.trim()).map((m) => {
      const out: Record<string, unknown> = { id: m.id.trim() };
      if (m.name.trim()) out.name = m.name.trim();
      const cw = parseCap(m.contextWindow);
      if (cw && cw > 0) out.contextWindow = Math.round(cw);
      const mt = parseCap(m.maxTokens);
      if (mt && mt > 0) out.maxTokens = Math.round(mt);
      return out;
    }),
  };
  if (d.apiKey.trim()) payload.apiKey = d.apiKey.trim();
  const price: Record<string, number> = {};
  if (d.inputPrice.trim()) price.input = Number(d.inputPrice);
  if (d.outputPrice.trim()) price.output = Number(d.outputPrice);
  if (Object.keys(price).length) payload.price = price;
  return payload;
}

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className={`pv-field ${error ? 'has-err' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error ? <p className="pv-hint">{hint}</p> : null}
      {error ? <p className="pv-err" role="alert"><IconAlert size={12} /> {error}</p> : null}
    </div>
  );
}

type Props = {
  draft: Draft;
  errors: Record<string, string>;
  saving: boolean;
  discovering: boolean;
  discoverError: string;
  protocols: { id: string; label: string }[];
  isNew: boolean;
  onChange: (patch: Partial<Draft>) => void;
  onSave: () => void;
  onCancel: () => void;
  onDiscover: () => void;
};

export function ProviderEditor({
  draft, errors, saving, discovering, discoverError, protocols, isNew, onChange, onSave, onCancel, onDiscover,
}: Props) {
  const setModel = (idx: number, patch: Partial<Draft['models'][number]>) => {
    const models = draft.models.map((m, i) => (i === idx ? { ...m, ...patch } : m));
    onChange({ models });
  };
  const addModel = () => onChange({ models: [...draft.models, { id: '', name: '', contextWindow: '', maxTokens: '' }] });
  const delModel = (idx: number) => onChange({ models: draft.models.filter((_, i) => i !== idx) });

  return (
    <form
      className="pv-card"
      aria-label={isNew ? '添加自定义提供方' : `编辑提供方 ${draft.id}`}
      onSubmit={(e) => { e.preventDefault(); onSave(); }}
    >
      <h3 className="pv-card-t">{isNew ? '添加自定义提供方' : `编辑提供方：${draft.name || draft.id}`}</h3>
      {isNew ? (
        <Field id="pvId" label="Provider ID" error={errors.id} hint="小写字母开头，可用小写字母、数字、短横线；保存后不可更改。">
          <input id="pvId" value={draft.id} autoComplete="off" spellCheck={false} onChange={(e) => onChange({ id: e.target.value })} />
        </Field>
      ) : null}
      <Field id="pvName" label="显示名称" error={errors.name}>
        <input id="pvName" value={draft.name} autoComplete="off" onChange={(e) => onChange({ name: e.target.value })} />
      </Field>
      <Field id="pvProto" label="API 协议" error={errors.protocol}>
        <select id="pvProto" value={draft.protocol} onChange={(e) => onChange({ protocol: e.target.value })}>
          {protocols.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </Field>
      <Field id="pvBase" label="API 地址" error={errors.baseUrl} hint="例如 https://api.example.com/v1；不要带账号密码。">
        <input id="pvBase" value={draft.baseUrl} autoComplete="off" spellCheck={false} inputMode="url" onChange={(e) => onChange({ baseUrl: e.target.value })} />
      </Field>
      <Field id="pvPrefix" label="路径前缀（可选）" error={errors.pathPrefix} hint="拼接在 /chat/completions 前的额外路径，一般留空。">
        <input id="pvPrefix" value={draft.pathPrefix} autoComplete="off" spellCheck={false} onChange={(e) => onChange({ pathPrefix: e.target.value })} />
      </Field>
      <Field id="pvKey" label="API 密钥" error={errors.apiKey} hint={isNew ? '只含英文可见字符，不含空格。' : '留空表示保持不变。'}>
        <input id="pvKey" type="password" value={draft.apiKey} autoComplete="off" spellCheck={false} onChange={(e) => onChange({ apiKey: e.target.value })} />
      </Field>
      <div className="pv-price-row">
        <Field id="pvIn" label="输入单价（¥/百万 tokens，可选）" error={errors.inputPrice}>
          <input id="pvIn" value={draft.inputPrice} inputMode="decimal" autoComplete="off" onChange={(e) => onChange({ inputPrice: e.target.value })} />
        </Field>
        <Field id="pvOut" label="输出单价（¥/百万 tokens，可选）" error={errors.outputPrice}>
          <input id="pvOut" value={draft.outputPrice} inputMode="decimal" autoComplete="off" onChange={(e) => onChange({ outputPrice: e.target.value })} />
        </Field>
      </div>

      <div className="pv-models">
        <div className="pv-models-head">
          <span>模型目录</span>
          <button type="button" className="btn btn-link" onClick={onDiscover} disabled={discovering}>
            <IconRefresh size={13} />
            {discovering ? '正在获取…' : '获取可用模型'}
          </button>
        </div>
        {discoverError ? <p className="pv-err" role="alert"><IconAlert size={12} /> {discoverError}</p> : null}
        {errors.models ? <p className="pv-err" role="alert"><IconAlert size={12} /> {errors.models}</p> : null}
        <div className="pv-mrow pv-mrow-head">
          <span>模型 ID</span><span>显示名（可选）</span><span>上下文</span><span>最大输出</span><span />
        </div>
        {draft.models.map((m, idx) => (
          <div className="pv-mrow" key={idx}>
            <input value={m.id} spellCheck={false} autoComplete="off" aria-label={`模型 ID 第 ${idx + 1} 行`} onChange={(e) => setModel(idx, { id: e.target.value })} />
            <input value={m.name} autoComplete="off" aria-label={`显示名 第 ${idx + 1} 行`} onChange={(e) => setModel(idx, { name: e.target.value })} />
            <input value={m.contextWindow} placeholder="128K" inputMode="text" autoComplete="off" aria-label={`上下文窗口 第 ${idx + 1} 行`} onChange={(e) => setModel(idx, { contextWindow: e.target.value })} />
            <input value={m.maxTokens} placeholder="8K" inputMode="text" autoComplete="off" aria-label={`最大输出 第 ${idx + 1} 行`} onChange={(e) => setModel(idx, { maxTokens: e.target.value })} />
            <button type="button" className="iconbtn danger" title="删除该模型" aria-label={`删除模型第 ${idx + 1} 行`} onClick={() => delModel(idx)}>
              <IconTrash size={13} />
            </button>
          </div>
        ))}
        <button type="button" className="btn" onClick={addModel}>
          <IconPlus size={13} />
          添加一行模型
        </button>
      </div>

      <div className="pv-actions">
        <button type="submit" className="btn btn-accent" disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        <button type="button" className="btn" onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}
