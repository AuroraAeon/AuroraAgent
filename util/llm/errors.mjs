/**
 * 上游错误分类（kosong errors 的本地精简）：把 HTTP 状态 + 响应体归一为 kind，
 * 话术（中文 hint）按提供方在 wire.upstreamHint 补全。扩展现有 401/402/429 映射。
 * 注：QUOTA_WORDING 暂与 wire.mjs 各持一份，P7 抽象层落地后统一到本模块。
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
