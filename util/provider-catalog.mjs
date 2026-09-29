/**
 * 提供方预设目录（数据完整迁移自 OpenBitFun v1.0.2 #3186 的 ai-provider-catalog；
 * 上游自家托管网关 openbitfun 条目剔除，reasoning_catalog_bindings 未迁——本地无推理目录绑定）。
 *
 * 定位：catalog 只是「端点与模型 ID 的预设数据」，不改变「代码不绑定厂商」的底线——
 * 用户仍可完全手填任意 OpenAI 兼容 / Anthropic Messages 提供方（providers.mjs），
 * 目录只是把常见厂商的 baseUrl / 协议 / 模型 ID 预填好，省掉手工拼装与拼错。
 *
 * 协议门控：本地 wire.mjs 只实现 OpenAI 兼容与 Anthropic Messages 两种协议，
 * 因此 gemini / responses 格式的端点入数据但不激活（supported=false）；
 * 将来补齐协议适配器，只需往 SUPPORTED_FORMATS 加一项，数据侧零改动。
 *
 * Token Plan 语义（小米）：上游用「同一家族、独立密钥」表达——API Key 与 Token Plan Key
 * 不通用。本地映射为同家族两条独立提供方预设（各自 baseUrl 与 apiKey），
 * 与 providers.json「一个提供方一把 Key」的既有模型一致，不引入双 Key 字段。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本地 wire 层已实现的线路协议；catalog 里其它格式的端点只入数据、不开放激活 */
export const SUPPORTED_FORMATS = ['openai', 'anthropic'];
const DEFAULT_LANG = 'zh-CN';

const __dirname = dirname(fileURLToPath(import.meta.url));

let cached = null;

/** 读目录（进程内缓存一次；文件缺失 / 损坏按空目录处理，不阻塞启动） */
function load() {
  if (cached) return cached;
  try {
    const j = JSON.parse(readFileSync(join(__dirname, 'provider-catalog.json'), 'utf8'));
    cached = Array.isArray(j.providers) ? j.providers : [];
  } catch { cached = []; }
  return cached;
}

/** 三语标签取用：首选 zh-CN，缺失回落 en-US，再缺失回落端点 / 提供方 ID */
export function catalogLabel(labels, fallback = '') {
  const row = labels && typeof labels === 'object' ? labels : {};
  const pick = (lang) => (typeof row[lang] === 'string' && row[lang].trim() ? row[lang].trim() : '');
  return pick(DEFAULT_LANG) || pick('en-US') || fallback;
}

/** 对外目录形状：提供方 + 端点（含协议门控与默认标记）+ 预置模型 ID 列表 */
export function catalogProviders() {
  return load().map((p) => {
    const endpoints = (Array.isArray(p.endpoints) ? p.endpoints : []).map((e) => ({
      id: String(e.id || ''),
      baseUrl: String(e.baseUrl || ''),
      format: String(e.format || 'openai'),
      label: catalogLabel(e.label, e.id),
      isDefault: e.default === true,
      supported: SUPPORTED_FORMATS.includes(String(e.format || '')),
    }));
    return {
      id: String(p.id || ''),
      name: catalogLabel(p.name, p.id),
      description: catalogLabel(p.description, ''),
      endpoints,
      models: (Array.isArray(p.models) ? p.models : []).map((m) => String(m || '')).filter(Boolean),
    };
  });
}

/** 单个提供方；找不到返回 null */
export function catalogProvider(id) {
  return catalogProviders().find((p) => p.id === String(id || '')) || null;
}

/**
 * 目录预设 → 提供方草稿（ProviderEditor / validateProviderDraft 直接可用的形状）。
 * 每个激活端点落成一条独立预设：Token Plan 与常规 API 因此各是一把 Key、一个 baseUrl。
 * @returns {{ name, protocol, baseUrl, models: {id, contextWindow}[] } | null}
 */
export function catalogPresetDraft(providerId, endpointId) {
  const provider = catalogProvider(providerId);
  if (!provider) return null;
  const endpoint = provider.endpoints.find((e) => e.id === String(endpointId || '')) || provider.endpoints.find((e) => e.isDefault) || provider.endpoints[0];
  if (!endpoint || !endpoint.supported) return null;
  const family = provider.name || provider.id;
  const variant = endpoint.id === 'default' || endpoint.isDefault ? '' : `（${endpoint.label || endpoint.id}）`;
  return {
    name: `${family}${variant}`.slice(0, 40),
    protocol: endpoint.format,
    baseUrl: endpoint.baseUrl,
    models: provider.models.map((id) => ({ id, contextWindow: 300000 })),
  };
}
