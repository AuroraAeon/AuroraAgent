/**
 * 自定义 Provider 存储（结构借鉴 dsh 的 llm-pi-ai 路由目录）：
 * 每个 Provider 自带端点、线路协议、API Key 与模型目录，代码不硬编码任何厂商清单。
 * 数据落 <数据目录>/providers.json（含 Key，已在 .gitignore），写盘先落临时文件再原子替换。
 * 顶层 failoverQueue 是用户编排的故障转移优先级（P1 → Pn，可含内置提供方）：
 * 与 llm/failover-state.mjs 的运行时观测（熔断 / 热切换偏好）分工，互不覆盖。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { writeFileAtomic } from './atomic.mjs';
import { join } from 'node:path';
import { catalogProviders, catalogPresetDraft, SUPPORTED_FORMATS } from './provider-catalog.mjs';

// 提供方预设目录（数据迁移自 OpenBitFun v1.0.2 #3186）：目录只是端点 / 模型 ID 的预设数据，
// 协议门控与 Token Plan 的「一家族一预设一密钥」映射都在 provider-catalog.mjs
export { catalogProviders, catalogPresetDraft, SUPPORTED_FORMATS };

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
/**
 * API 密钥格式校验（与 dsh 的 apiKeyFailure 同规约，镜像自其 llm 层 normalizeApiKey）：
 * 只含可见 ASCII（不含空格）；拒绝整行 NAME=value 环境变量写法与成对引号包裹，
 * 这两类形状几乎总是粘贴失误，放行只会让上游以 401 拒绝。
 */
const LEGAL_API_KEY = /^[\x21-\x7E]+$/;
const ENV_LINE = /^[A-Z][A-Z0-9_]*=[^=]/;
function isQuoted(value) {
  const first = value[0];
  if (first !== '"' && first !== "'" && first !== '`') return false;
  return value.length > 1 && value.endsWith(first);
}
/** 校验一个密钥原文；不合法返回中文错误消息（说清原因 + 下一步），合法返回 undefined */
export function apiKeyFailure(raw) {
  const value = String(raw ?? '');
  if (value.length === 0) return undefined; // 留空 = 保持不变，由调用方决定语义
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'API 密钥不能全是空格：请输入密钥，或留空保持不变。';
  if (ENV_LINE.test(trimmed) || isQuoted(trimmed) || !LEGAL_API_KEY.test(trimmed)) {
    return 'API 密钥含不支持的字符：只能使用英文可见字符（不含空格），也不要粘贴 NAME=value 环境变量行或带引号的值。';
  }
  return undefined;
}
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
  // API 密钥：非空才校验格式（留空表示保持不变）；全空格视为输入失误，不静默丢弃
  const rawKey = typeof draft.apiKey === 'string' ? draft.apiKey : '';
  if (rawKey.length > 0) {
    const keyError = apiKeyFailure(rawKey);
    if (keyError) errors.apiKey = keyError;
    else value.apiKey = rawKey.trim();
  }
  // 计费单价（¥/百万 tokens）可选：只填一侧也接受，未填侧计价时回退内置价；传空对象表示清空
  if (draft.price !== undefined && draft.price !== null) {
    const price = {};
    for (const key of ['input', 'output']) {
      const raw = draft.price?.[key];
      if (raw === undefined || raw === null || raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) { errors[`price.${key}`] = `计费单价的${key === 'input' ? '输入' : '输出'}需为不小于 0 的数字，例如 ${key === 'input' ? 2 : 8}。`; break; }
      price[key] = n;
    }
    if (!errors['price.input'] && !errors['price.output']) value.price = price;
  }
  if (draft.thinking === true) value.thinking = true;
  const maxTokens = Number(draft.maxTokens);
  if (Number.isFinite(maxTokens) && maxTokens > 0) value.maxTokens = Math.round(maxTokens);
  // 提供方能力声明（capacity）：上游是否支持提示缓存。缺省不写——多数 OpenAI 兼容线路
  // 不认 prompt_cache_key，多发一个字段就是 400；要开由用户在提供方编辑器里显式勾选
  if (draft.capacity && typeof draft.capacity === 'object') {
    const capacity = {};
    if (draft.capacity.supportsPromptCache !== undefined) capacity.supportsPromptCache = draft.capacity.supportsPromptCache === true;
    if (Object.keys(capacity).length) value.capacity = capacity;
  }
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
  const price = {};
  for (const key of ['input', 'output']) {
    const n = Number(raw.price?.[key]);
    if (Number.isFinite(n) && n >= 0) price[key] = n;
  }
  const maxTokens = Number(raw.maxTokens);
  const capacity = {};
  const capWindow = Number(raw.capacity?.contextWindow);
  if (Number.isFinite(capWindow) && capWindow > 0) capacity.contextWindow = Math.round(capWindow);
  if (raw.capacity?.supportsPromptCache === true) capacity.supportsPromptCache = true;
  return {
    id,
    name: String(raw.name ?? id).trim() || id,
    protocol,
    baseUrl: endpoint.url,
    pathPrefix: typeof raw.pathPrefix === 'string' ? raw.pathPrefix : '',
    models,
    price: Object.keys(price).length ? price : undefined,
    thinking: raw.thinking === true,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.round(maxTokens) : undefined,
    capacity: Object.keys(capacity).length ? capacity : undefined,
    // 非法密钥直接丢弃：与 dsh 的解析层一致——这类形状永远无法通过上游鉴权，
    // 留在这里只会在下次保存时炸出难懂的错误，不如让界面回到「未配置」让用户重填
    apiKey: (() => { const k = String(raw.apiKey ?? '').trim(); return k && !apiKeyFailure(k) ? k : ''; })(),
  };
}

/**
 * Provider 仓库：自定义提供方持久化 + 内置提供方（美团 LongCat）合成。
 * 内置提供方由 env / 配置派生，排在最前且只读，保证既有行为不变。
 */
export class ProviderStore {
  /**
   * @param dataDir 数据目录
   * @param builtin  内置提供方合成参数（env / 配置派生）
   * @param builtinModels 内置模型目录（上游结果注入）
   * @param deps { prefFor(modelId) => providerId|null, failoverEnabled() => boolean }
   *             故障转移依赖：偏好来自 llm/failover-state.mjs（转移成功后写入），
   *             这里只读不写，避免 providers.mjs 反向依赖 llm 层
   */
  constructor(dataDir, builtin = {}, builtinModels = () => [], deps = {}) {
    this.path = join(dataDir, 'providers.json');
    this.deps = deps && typeof deps === 'object' ? deps : {};
    this.failoverQueue = [];
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
    this.failoverQueue = [];
    try {
      const j = JSON.parse(readFileSync(this.path, 'utf8'));
      const list = Array.isArray(j.providers) ? j.providers : [];
      this.custom = list.map(normalizeStored).filter(Boolean);
      if (Array.isArray(j.failoverQueue)) {
        this.failoverQueue = j.failoverQueue.map((id) => String(id || '').trim()).filter(Boolean);
      }
    } catch { this.custom = []; }
  }

  #save() {
    const payload = JSON.stringify({ version: 1, providers: this.custom, failoverQueue: this.failoverQueue }, null, 2);
    try {
      writeFileAtomic(this.path, payload); // tmp + fsync + rename + 0600（util/atomic.mjs）
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
      price: p.price || null,
      thinking: Boolean(p.thinking),
      maxTokens: p.maxTokens || null,
      capacity: p.capacity ? { ...p.capacity } : null,
      models: p.models.map((m) => ({ ...m })),
      // 队列位置（-1 = 不在队列）：设置页「故障转移队列」区据此渲染顺序与加入 / 移除态
      failoverIndex: this.failoverQueue.indexOf(p.id),
    }));
  }

  get(id) {
    const key = String(id || '');
    if (key === this.builtin.id) return this.builtinProvider();
    const found = this.custom.find((p) => p.id === key);
    return found ? { ...found, builtin: false } : null;
  }

  /** 按模型 ID 反查提供方；找不到回退到内置（保持既有默认行为）。
   *  热切换偏好优先：上次真正接通过该模型的提供方排在最前（仅故障转移开启时生效），
   *  偏好提供方已不可用（删了 / 没 Key / 不含该模型）时静默回退默认顺序 */
  providerForModel(modelId) {
    const key = String(modelId || '');
    if (key) {
      if (this.deps.failoverEnabled?.() !== false) {
        const preferred = this.deps.prefFor?.(key);
        if (preferred) {
          const hit = this.get(preferred);
          if (hit && hit.apiKey && Array.isArray(hit.models) && hit.models.some((m) => m.id === key)) return hit;
        }
      }
      for (const p of this.all()) if (p.models.some((m) => m.id === key)) return p;
    }
    return this.builtinProvider();
  }

  /** 故障转移队列（用户编排的优先级顺序，可含内置提供方）；返回副本防外部改坏内部态 */
  failoverQueueIds() {
    return [...this.failoverQueue];
  }

  /** 整队列替换（设置页拖拽 / 上移下移后一次性提交）；校验 id 必须存在 */
  setFailoverQueue(ids) {
    const known = new Set(this.all().map((p) => p.id));
    const next = [];
    for (const raw of Array.isArray(ids) ? ids : []) {
      const id = String(raw || '').trim();
      if (!known.has(id) || next.includes(id)) throw new ProviderError(`提供方不存在：${id || '(空)'}`, 'queue');
      next.push(id);
    }
    this.failoverQueue = next;
    this.#save();
    return this.failoverQueueIds();
  }

  /** 入队（追加到末尾）；已在队列里则保持原位不动 */
  addToFailoverQueue(id) {
    const key = String(id || '').trim();
    if (!this.all().some((p) => p.id === key)) throw new ProviderError('提供方不存在', 'queue');
    if (this.failoverQueue.includes(key)) return this.failoverQueueIds();
    this.failoverQueue.push(key);
    this.#save();
    return this.failoverQueueIds();
  }

  removeFromFailoverQueue(id) {
    const key = String(id || '').trim();
    const idx = this.failoverQueue.indexOf(key);
    if (idx < 0) return this.failoverQueueIds();
    this.failoverQueue.splice(idx, 1);
    this.#save();
    return this.failoverQueueIds();
  }

  /** 队列内上移 / 下移一步；已在端点或不在队列里则原样返回 */
  moveInFailoverQueue(id, delta) {
    const key = String(id || '').trim();
    const idx = this.failoverQueue.indexOf(key);
    const to = idx + Number(delta || 0);
    if (idx < 0 || to < 0 || to >= this.failoverQueue.length) return this.failoverQueueIds();
    const next = [...this.failoverQueue];
    next.splice(idx, 1);
    next.splice(to, 0, key);
    this.failoverQueue = next;
    this.#save();
    return this.failoverQueueIds();
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
      thinking: patch.thinking !== undefined ? patch.thinking : this.custom[idx].thinking,
      maxTokens: patch.maxTokens !== undefined ? patch.maxTokens : this.custom[idx].maxTokens,
      price: patch.price !== undefined ? patch.price : this.custom[idx].price,
      capacity: patch.capacity !== undefined && patch.capacity !== null ? patch.capacity : this.custom[idx].capacity,
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
    this.failoverQueue = this.failoverQueue.filter((qid) => qid !== key); // 队列里的孤儿一并清掉
    this.#save();
    return true;
  }

  /** 文件是否存在（设置页用于提示「尚未添加自定义提供方」） */
  get exists() { return existsSync(this.path); }
}

/**
 * 线路地址拼装：自定义提供方的「API 地址」就是端点根，直接拼 /chat/completions；
 * 内置提供方多一段 /openai/v1 前缀（AURORAAGENT_BASE_URL 仍按既有语义取站点根）。
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

/** 脱敏后的单个提供方（供保存后回显，形状与列表接口一致） */
function redact(store, p) {
  const row = store.list().find((x) => x.id === p.id);
  if (row) return row;
  return {
    id: p.id, name: p.name, protocol: p.protocol, baseUrl: p.baseUrl,
    builtin: Boolean(p.builtin), hasKey: Boolean(p.apiKey), model: p.model || '', models: p.models || [],
    price: p.price || null, thinking: Boolean(p.thinking), maxTokens: p.maxTokens || null,
  };
}

const json = (res, status, payload) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
};

/** 读取 JSON 请求体（带上限，超限直接掐断）；解析失败返回 null */
function readBody(req, limit) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > limit) req.destroy(); });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); }
    });
  });
}

/**
 * /api/providers* 路由（借鉴 dsh Models 设置页：行 + 编辑器卡片 + 添加卡片 + 模型质问）。
 * web.mjs 只保留一行分发，具体动作都在这里，避免单文件继续膨胀。
 * @returns Promise<boolean> 是否已处理（true 时 web.mjs 直接 return）
 */
export async function handleProviderApi(req, res, url, ctx) {
  const store = ctx.store;
  const log = ctx.log;
  const fail = (status, message, field) => json(res, status, { ok: false, error: message, field: field || '' });

  if (req.method === 'GET' && url === '/api/providers') {
    json(res, 200, { ok: true, protocols: PROTOCOLS, providers: store.list() });
    return true;
  }

  // 提供方预设目录（只读）：供设置页「从目录添加」预填端点 / 协议 / 模型 ID
  if (req.method === 'GET' && url === '/api/providers/catalog') {
    json(res, 200, { ok: true, supportedFormats: SUPPORTED_FORMATS, providers: catalogProviders() });
    return true;
  }

  if (req.method === 'POST' && url === '/api/providers') {
    const draft = await readBody(req, 256 * 1024);
    if (!draft) { fail(400, '请求体不是合法 JSON'); return true; }
    try {
      const created = store.create(draft);
      log('info', '已创建自定义提供方', { id: created.id, protocol: created.protocol });
      json(res, 200, { ok: true, provider: redact(store, created), providers: store.list() });
    } catch (e) {
      fail(e instanceof ProviderError ? 400 : 500, e.message, e.field);
    }
    return true;
  }

  // 模型质问与提供方 ID 无关：地址、协议、密钥都由请求体给出，新建与编辑共用一条路由
  if (req.method === 'POST' && url === '/api/providers/discover') {
    const want = (await readBody(req, 64 * 1024)) || {};
    try {
      const found = await fetchModelCandidates({
        baseUrl: want.baseUrl, protocol: want.protocol, apiKey: want.apiKey, pathPrefix: want.pathPrefix,
      });
      log('info', '已拉取提供方模型目录', { count: found.models.length, url: found.url });
      json(res, 200, { ok: true, url: found.url, models: found.models });
    } catch (e) {
      log('warn', '拉取提供方模型目录失败', { error: e.message });
      fail(e instanceof ProviderError ? 400 : 500, e.message, e.field);
    }
    return true;
  }

  // 故障转移队列（用户编排的优先级）：读队列 + 提供方列表；写支持整队列替换与增删移
  if (url === '/api/providers/failover-queue') {
    if (req.method === 'GET') {
      json(res, 200, { ok: true, queue: store.failoverQueueIds(), providers: store.list() });
      return true;
    }
    if (req.method !== 'POST') { json(res, 405, { ok: false, error: '仅支持 GET / POST' }); return true; }
    const body = await readBody(req, 64 * 1024);
    if (!body) { fail(400, '请求体不是合法 JSON'); return true; }
    try {
      let queue;
      if (Array.isArray(body.queue)) queue = store.setFailoverQueue(body.queue);
      else if (body.add !== undefined) queue = store.addToFailoverQueue(body.add);
      else if (body.remove !== undefined) queue = store.removeFromFailoverQueue(body.remove);
      else if (body.move && typeof body.move === 'object') queue = store.moveInFailoverQueue(body.move.id, body.move.delta);
      else { fail(400, '请提供 queue（整队列数组）、add、remove 或 move'); return true; }
      log('info', '已更新故障转移队列', { queue });
      json(res, 200, { ok: true, queue, providers: store.list() });
    } catch (e) { fail(400, e.message, e.field); }
    return true;
  }

  const one = /^\/api\/providers\/([a-z0-9-]+)$/.exec(url);
  if (one && one[1] === 'discover') return false;
  if (one && req.method === 'DELETE') {
    try {
      store.remove(one[1]);
      log('info', '已删除自定义提供方', { id: one[1] });
      json(res, 200, { ok: true, providers: store.list() });
    } catch (e) { fail(400, e.message, e.field); }
    return true;
  }
  if (one && req.method === 'PUT') {
    const patch = await readBody(req, 256 * 1024);
    if (!patch) { fail(400, '请求体不是合法 JSON'); return true; }
    try {
      const updated = store.update(one[1], patch);
      log('info', '已更新自定义提供方', { id: one[1] });
      json(res, 200, { ok: true, provider: redact(store, updated), providers: store.list() });
    } catch (e) { fail(e instanceof ProviderError ? 400 : 500, e.message, e.field); }
    return true;
  }

  return false;
}
