/**
 * 自定义 Provider 存储（结构借鉴 dsh 的 llm-pi-ai 路由目录）：
 * 每个 Provider 自带端点、线路协议、API Key 与模型目录，代码不硬编码任何厂商清单。
 * 数据落 <数据目录>/providers.json（含 Key，已在 .gitignore），写盘先落临时文件再原子替换。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 支持的线路协议（与 dsh 的质问能力对齐：OpenAI 兼容 + Anthropic Messages） */
export const PROTOCOLS = [
  { id: 'openai', label: 'OpenAI 兼容' },
  { id: 'anthropic', label: 'Anthropic Messages' },
];
const PROTOCOL_IDS = new Set(PROTOCOLS.map((p) => p.id));
const ID_RE = /^[a-z][a-z0-9-]*$/;
const MODEL_ID_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const CAPACITY_RE = /^(\d+(?:\.\d+)?)([km])?$/i;
const CAPACITY_SCALE = { k: 1e3, m: 1e6 };
const MAX_MODELS = 200;
/** 内置提供方（美团 LongCat）的固定 ID：不可创建同名、不可删除 */
export const BUILTIN_ID = 'longcat';

/** 校验失败：message 说清原因 + 下一步动作，field 指向具体字段 */
export class ProviderError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'ProviderError';
    this.field = field || '';
  }
}

/** 读一个容量字段：留空返回 undefined（沿用提供方默认），不可解析返回 NaN */
export function parseCapacity(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return undefined;
  const m = CAPACITY_RE.exec(trimmed);
  if (!m) return NaN;
  const scale = CAPACITY_SCALE[m[2] ? m[2].toLowerCase() : ''] ?? 1;
  const scaled = Number(m[1]) * scale;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6 ? Math.round(scaled) : scaled;
}

/** 把容量写回最短形态：131072 -> "128K"，1000000 -> "1M" */
export function formatCapacity(value) {
  if (!Number.isInteger(value) || value <= 0) return String(value);
  if (value % CAPACITY_SCALE.m === 0) return `${value / CAPACITY_SCALE.m}M`;
  if (value % CAPACITY_SCALE.k === 0) return `${value / CAPACITY_SCALE.k}K`;
  return String(value);
}

/** 归一化 API 地址：必须可解析为 HTTP/HTTPS，容忍末尾斜杠；localhost / IP 字面量 / 自定义端口均合法 */
export function normalizeEndpoint(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: '请填写 API 地址，例如 https://api.example.com/v1' };
  let url;
  try { url = new URL(text); } catch { return { ok: false, error: 'API 地址无法解析：请补上协议头，例如 https://api.example.com/v1' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'API 地址只支持 HTTP 或 HTTPS，请检查协议头' };
  }
  if (url.username || url.password) return { ok: false, error: 'API 地址里不要带账号密码，Key 请填到下方「API 密钥」' };
  return { ok: true, url: text.replace(/\/+$/, '') };
}

/** 校验一份 Provider 草稿；taken 是已存在的 ID，用于拒绝重名 */
export function validateProviderDraft(draft, taken = []) {
  const errors = {};
  const id = String(draft.id ?? '').trim();
  if (!ID_RE.test(id)) errors.id = 'Provider ID 需以小写字母开头，之后可用小写字母、数字和短横线。';
  else if (taken.includes(id)) errors.id = '已有提供方使用了这个 ID，请换一个。';
  else if (id === BUILTIN_ID) errors.id = `${BUILTIN_ID} 是内置提供方的 ID，请换一个。`;

  const name = String(draft.name ?? '').trim();
  if (!name) errors.name = '请填写显示名称，用于界面标识这个提供方。';
  else if (name.length > 40) errors.name = '显示名称不能超过 40 个字符。';

  const endpoint = normalizeEndpoint(draft.baseUrl);
  if (!endpoint.ok) errors.baseUrl = endpoint.error;

  const protocol = String(draft.protocol ?? '').trim();
  if (!PROTOCOL_IDS.has(protocol)) errors.protocol = '请选择 API 协议。';

  const rawModels = Array.isArray(draft.models) ? draft.models : [];
  if (rawModels.length > MAX_MODELS) errors.models = `一个提供方最多添加 ${MAX_MODELS} 个模型，请删掉一些再保存。`;
  const models = [];
  const seen = new Set();
  for (const entry of rawModels) {
    if (!entry || typeof entry !== 'object') continue;
    const mid = String(entry.id ?? '').trim();
    if (!mid) continue; // 空行视为未填写，由下面的数量校验兜底
    if (!MODEL_ID_RE.test(mid)) { errors.models = `模型 ID「${mid}」含非法字符，只能用字母、数字、. _ : -`; break; }
    if (seen.has(mid)) { errors.models = `模型 ID「${mid}」重复了，每个模型 ID 只能出现一次。`; break; }
    seen.add(mid);
    const mname = String(entry.name ?? '').trim();
    if (mname.length > 60) { errors.models = `模型「${mid}」的显示名称不能超过 60 个字符。`; break; }
    const model = { id: mid };
    if (mname) model.name = mname;
    for (const [key, label] of [['contextWindow', '上下文窗口'], ['maxTokens', '最大输出 token 数']]) {
      const cap = parseCapacity(entry[key]);
      if (cap === undefined) continue;
      if (!(cap > 0)) { errors.models = `模型「${mid}」的${label}需为正数，例如 131072、256K 或 1M。`; break; }
      model[key] = cap;
    }
    if (errors.models) break;
    models.push(model);
  }
  if (!errors.models && !models.length) errors.models = '至少需要一个模型：点「获取可用模型」拉取，或手填一个模型 ID。';

  const value = { id, name, protocol, baseUrl: endpoint.ok ? endpoint.url : String(draft.baseUrl ?? '').trim(), models };
  const apiKey = String(draft.apiKey ?? '').trim();
  if (apiKey) value.apiKey = apiKey;
  return { ok: Object.keys(errors).length === 0, errors, value };
}

/** 把一条持久化记录规整成内存形态（容错旧数据 / 手改文件） */
function normalizeStored(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  if (!ID_RE.test(id)) return null;
  const endpoint = normalizeEndpoint(raw.baseUrl);
  if (!endpoint.ok) return null;
  const models = (Array.isArray(raw.models) ? raw.models : [])
    .filter((m) => m && MODEL_ID_RE.test(String(m.id ?? '').trim()))
    .map((m) => {
      const out = { id: String(m.id).trim() };
      const name = String(m.name ?? '').trim();
      if (name) out.name = name;
      for (const key of ['contextWindow', 'maxTokens']) {
        const cap = Number(m[key]);
        if (Number.isFinite(cap) && cap > 0) out[key] = Math.round(cap);
      }
      return out;
    });
  const protocol = PROTOCOL_IDS.has(raw.protocol) ? raw.protocol : 'openai';
  return {
    id,
    name: String(raw.name ?? id).trim() || id,
    protocol,
    baseUrl: endpoint.url,
    pathPrefix: typeof raw.pathPrefix === 'string' ? raw.pathPrefix : '',
    models,
    apiKey: String(raw.apiKey ?? '').trim(),
  };
}

/**
 * Provider 仓库：自定义提供方持久化 + 内置提供方（美团 LongCat）合成。
 * 内置提供方由 env / 配置派生，排在最前且只读，保证既有行为不变。
 */
export class ProviderStore {
  constructor(dataDir, builtin = {}, builtinModels = () => []) {
    this.path = join(dataDir, 'providers.json');
    this.builtin = {
      id: BUILTIN_ID,
      name: builtin.name || '美团 LongCat',
      protocol: 'openai',
      baseUrl: String(builtin.baseUrl || '').replace(/\/+$/, ''),
      pathPrefix: typeof builtin.pathPrefix === 'string' ? builtin.pathPrefix : '',
      apiKey: builtin.apiKey,
      model: builtin.model || '',
    };
    this.builtinModels = builtinModels;
    this.#load();
  }

  #load() {
    this.custom = [];
    try {
      const j = JSON.parse(readFileSync(this.path, 'utf8'));
      const list = Array.isArray(j.providers) ? j.providers : [];
      this.custom = list.map(normalizeStored).filter(Boolean);
    } catch { this.custom = []; }
  }

  #save() {
    const payload = JSON.stringify({ version: 1, providers: this.custom }, null, 2);
    const tmp = `${this.path}.tmp`;
    try {
      mkdirSync(join(this.path, '..'), { recursive: true });
      writeFileSync(tmp, payload);
      renameSync(tmp, this.path);
    } catch (e) {
      throw new ProviderError(`提供方配置写入失败：${e.message}（请检查数据目录权限）`);
    }
  }

  /** 内置提供方记录（模型目录由调用方按上游结果注入；apiKey 可为函数，便于跟随配置热更新） */
  builtinProvider() {
    const raw = this.builtin.apiKey;
    return {
      id: this.builtin.id,
      name: this.builtin.name,
      protocol: this.builtin.protocol,
      baseUrl: this.builtin.baseUrl,
      pathPrefix: this.builtin.pathPrefix || '',
      apiKey: typeof raw === 'function' ? raw() : raw,
      model: this.builtin.model,
      models: this.builtinModels(),
      builtin: true,
    };
  }

  /** 全部提供方（内置在前），含脱敏标记 hasKey */
  all() {
    return [this.builtinProvider(), ...this.custom.map((p) => ({ ...p, builtin: false }))];
  }

  /** 对外列表：绝不返回 apiKey 明文 */
  list() {
    return this.all().map((p) => ({
      id: p.id,
      name: p.name,
      protocol: p.protocol,
      baseUrl: p.baseUrl,
      pathPrefix: p.pathPrefix || '',
      builtin: Boolean(p.builtin),
      hasKey: Boolean(p.apiKey),
      model: p.model || '',
      models: p.models.map((m) => ({ ...m })),
    }));
  }

  get(id) {
    const key = String(id || '');
    if (key === this.builtin.id) return this.builtinProvider();
    const found = this.custom.find((p) => p.id === key);
    return found ? { ...found, builtin: false } : null;
  }

  /** 按模型 ID 反查提供方；找不到回退到内置（保持既有默认行为） */
  providerForModel(modelId) {
    const key = String(modelId || '');
    if (key) {
      for (const p of this.all()) if (p.models.some((m) => m.id === key)) return p;
    }
    return this.builtinProvider();
  }

  create(draft) {
    const checked = validateProviderDraft(draft, this.custom.map((p) => p.id));
    if (!checked.ok) throw new ProviderError(Object.values(checked.errors)[0], Object.keys(checked.errors)[0]);
    const value = checked.value;
    const existing = this.custom.find((p) => p.id === value.id);
    if (existing) throw new ProviderError('已有提供方使用了这个 ID，请换一个。', 'id');
    this.custom.push(value);
    this.#save();
    return this.get(value.id);
  }

  update(id, patch) {
    const key = String(id || '');
    if (key === this.builtin.id) throw new ProviderError('内置提供方由配置与上游目录决定，不能在此修改。', '');
    const idx = this.custom.findIndex((p) => p.id === key);
    if (idx < 0) throw new ProviderError('提供方不存在，可能已被删除，请刷新后重试。', '');
    const merged = {
      id: key,
      name: patch.name ?? this.custom[idx].name,
      protocol: patch.protocol ?? this.custom[idx].protocol,
      baseUrl: patch.baseUrl ?? this.custom[idx].baseUrl,
      models: patch.models ?? this.custom[idx].models,
      apiKey: patch.apiKey !== undefined ? patch.apiKey : this.custom[idx].apiKey,
    };
    const checked = validateProviderDraft(merged, this.custom.filter((p) => p.id !== key).map((p) => p.id));
    if (!checked.ok) throw new ProviderError(Object.values(checked.errors)[0], Object.keys(checked.errors)[0]);
    this.custom[idx] = checked.value;
    this.#save();
    return this.get(key);
  }

  remove(id) {
    const key = String(id || '');
    if (key === this.builtin.id) throw new ProviderError('内置提供方不能删除。', '');
    const idx = this.custom.findIndex((p) => p.id === key);
    if (idx < 0) throw new ProviderError('提供方不存在，可能已被删除。', '');
    this.custom.splice(idx, 1);
    this.#save();
    return true;
  }

  /** 文件是否存在（设置页用于提示「尚未添加自定义提供方」） */
  get exists() { return existsSync(this.path); }
}

/**
 * 线路地址拼装：自定义提供方的「API 地址」就是端点根，直接拼 /chat/completions；
 * 内置提供方多一段 /openai/v1 前缀（MODELTESTER_BASE_URL 仍按既有语义取站点根）。
 */
export function chatUrl(p) { return `${p.baseUrl}${p.pathPrefix || ''}/chat/completions`; }
export function modelsUrl(p) { return `${p.baseUrl}${p.pathPrefix || ''}/models`; }
export function messagesUrl(p) { return `${p.baseUrl}${p.pathPrefix || ''}/messages`; }

/** 上游返回的单个模型记录 -> 候选 { id, name?, contextWindow?, maxTokens? } */
function candidateFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? raw.name ?? '').trim();
  if (!id || !MODEL_ID_RE.test(id)) return null;
  const out = { id };
  const name = String(raw.display_name ?? raw.name ?? '').trim();
  if (name && name !== id) out.name = name;
  const ctx = Number(raw.context_window ?? raw.context_length ?? raw.max_context_length);
  if (Number.isFinite(ctx) && ctx > 0) out.contextWindow = Math.round(ctx);
  const cap = Number(raw.max_output_tokens ?? raw.max_completion_tokens ?? raw.max_tokens);
  if (Number.isFinite(cap) && cap > 0) out.maxTokens = Math.round(cap);
  return out;
}

/** 解析模型列表响应：兼容 {data:[...]}、{models:[...]} 与 {models:{id:...}} 三种形状 */
function parseModelList(j) {
  let rows = [];
  if (Array.isArray(j?.data)) rows = j.data;
  else if (Array.isArray(j?.models)) rows = j.models;
  else if (j?.models && typeof j.models === 'object') {
    rows = Object.entries(j.models).map(([id, v]) => (v && typeof v === 'object' ? { id, ...v } : { id }));
  }
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const c = candidateFrom(row);
    if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}

/**
 * 向提供方质问可用模型（只读，不落盘）。
 * @param provider { baseUrl, protocol, apiKey }
 * @returns Promise<{ models: candidate[] }>
 */
export async function fetchModelCandidates(provider) {
  const endpoint = normalizeEndpoint(provider.baseUrl);
  if (!endpoint.ok) throw new ProviderError(endpoint.error, 'baseUrl');
  const url = modelsUrl({ baseUrl: endpoint.url, pathPrefix: provider.pathPrefix });
  const headers = { 'Accept': 'application/json' };
  if (provider.apiKey) {
    if (provider.protocol === 'anthropic') {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }
  }
  let resp;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new ProviderError(`无法连接 ${url}：${e.message}（请检查 API 地址与网络，或改用「添加模型」手动填写）`, 'baseUrl');
  }
  const text = await resp.text();
  if (!resp.ok) {
    let detail = text.slice(0, 200);
    try { detail = JSON.parse(text).error?.message || JSON.parse(text).message || detail; } catch {}
    const hint = resp.status === 401 || resp.status === 403
      ? 'API 密钥无效：请检查后重试，或留空使用环境认证'
      : '请检查 API 地址与密钥，或改用「添加模型」手动填写';
    throw new ProviderError(`上游返回 ${resp.status}：${detail}。${hint}`, '');
  }
  let j;
  try { j = JSON.parse(text); } catch { throw new ProviderError('上游返回的不是 JSON，无法解析模型列表。', ''); }
  const models = parseModelList(j);
  if (!models.length) throw new ProviderError('该提供方没有列出任何模型，请手动添加。', '');
  return { models, url };
}
