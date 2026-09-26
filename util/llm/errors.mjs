/**
 * 上游错误分类与中文提示（kosong errors 的本地精简）：把 HTTP 状态 + 响应体归一为 kind，
 * 并按提供方给出中文 hint。/api/chat 与 Agent Loop 共用同一份话术，两条路径一致。
 */
export const ERROR_KINDS = ['auth', 'quota', 'rate_limit', 'bad_request', 'not_found', 'server', 'network', 'aborted', 'unknown'];

export const QUOTA_WORDING = /\binsufficient[\s_-]+(?:quota|balance|credits?)\b|\b(?:quota|usage[\s_-]+limit)[\s_-]+(?:exceeded|exhausted|reached)\b|\b(?:balance|credits?)[\s_-]+(?:exhausted|depleted)\b|\bout[\s_-]+of[\s_-]+(?:credits?|budget)\b/i;

/** 依据 HTTP 状态码 + 响应体粗分类 */
export function classifyStatus(status, body = '') {
  const s = Number(status);
  if (s === 401 || s === 403) return 'auth';
  if (s === 402) return 'quota';
  if (s === 429) return 'rate_limit';
  if (QUOTA_WORDING.test(String(body || ''))) return 'quota';
  if (s === 400 || s === 422) return 'bad_request';
  if (s === 404) return 'not_found';
  if (s >= 500) return 'server';
  return 'unknown';
}

/** 连接期异常分类：fetch 网络失败 → network；中止 → aborted */
export function classifyError(err) {
  if (!err) return 'unknown';
  if (err.name === 'AbortError') return 'aborted';
  if (err.name === 'TypeError') return 'network';
  return 'unknown';
}

/**
 * 上游错误的中文提示：内置提供方保留美团专属指引，自定义提供方指向设置页。
 * /api/chat 与 Agent Loop 共用，保证两条路径的错误话术一致。
 */
export function upstreamHint(provider, status, errText) {
  const builtin = Boolean(provider.builtin);
  const keyHint = builtin
    ? '请检查 auroraagent.config.json 里的 apiKey，或访问 https://longcat.chat/platform/api_keys 重新获取'
    : `请到「设置 → 提供方」检查「${provider.name}」的 API 密钥，或到该厂商控制台重新获取`;
  const quotaHint = builtin
    ? '请到 https://longcat.chat/platform/ 充值，或抢购 Token 资源包（每日 10:00/16:00/21:00/23:00），或完成邀请任务领取奖励'
    : `请到「${provider.name}」对应的厂商控制台充值后重试`;
  if (status === 401) return `API Key 无效：${keyHint}`;
  if (status === 402) return `账号额度已用尽：${quotaHint}`;
  if (status === 429) return '请求过于频繁，请稍等几秒再发';
  if (QUOTA_WORDING.test(errText)) return `账号额度可能已用尽：${quotaHint}`;
  try { return JSON.parse(errText).error?.message || JSON.parse(errText).message || errText; } catch { return errText; }
}
