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

/** 上下文窗口超长的上游措辞库：默认跨协议归纳 + 各家常见说法精选（移植 pi
 *  utils/overflow.ts 的 OVERFLOW_PATTERNS：Anthropic / OpenAI / Google / xAI / Groq /
 *  OpenRouter / Together / Copilot / llama.cpp / LM Studio / MiniMax / Kimi / Mistral /
 *  DS4 / z.ai / Xiaomi / DashScope / Ollama 各有一条自己的说法，只认识 OpenAI 与
 *  Anthropic 两家会在换厂商时静默丢掉「压缩一次就能好」的恢复机会）。 */
const CONTEXT_OVERFLOW_PATTERNS = [
  /prompt (?:is )?too long/i,                                  // Anthropic / z.ai  token 溢出
  /prompt exceeds max length/i,                                // z.ai CN 端点
  /request_too_large/i,                                        // Anthropic 413 字节体积溢出
  /input is too long for requested model/i,                    // Amazon Bedrock
  /exceeds the context window/i,                               // OpenAI（Completions & Responses）
  /exceeds (?:the )?(?:model'?s )?maximum context length/i,    // OpenAI 兼容代理（LiteLLM）
  /input token count.*exceeds the maximum/i,                   // Google Gemini
  /maximum prompt length is \d+/i,                            // xAI Grok
  /reduce the length of the messages/i,                        // Groq
  /maximum context length is \d+ tokens/i,                     // OpenRouter
  /exceeds (?:the )?maximum allowed input length/i,            // OpenRouter / Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length/i, // Together AI
  /exceeds the limit of \d+/i,                                // GitHub Copilot
  /exceeds the available context size/i,                       // llama.cpp server
  /greater than the context length/i,                          // LM Studio
  /context window exceeds limit/i,                             // MiniMax
  /exceeded model token limit/i,                               // Kimi For Coding
  /too large for model with \d+ maximum context length/i,      // Mistral
  /prompt has [\d,]+ tokens?, but the configured context size is/i, // DS4
  /model_context_window_exceeded/i,                            // z.ai 非标准 finish_reason
  /prompt too long; exceeded (?:max )?context length/i,        // Ollama 显式溢出
  /range of input length should be/i,                          // DashScope / Qwen Token Plan
  /context[_ ]length[_ ]exceeded/i,                            // 通用兜底
  /too many tokens/i,                                          // 通用兜底
  /token limit exceeded/i,                                     // 通用兜底
  /context window (?:exceeded|too long)/i,                     // 通用兜底（与「exceeds the context window」词序相反的常见说法）
  /request.{0,24}too (?:large|long)/i,                         // 通用兜底（OpenAI 兼容中转的 request entity too large；pi 只认 Anthropic 的 request_too_large）
];
/** 非溢出措辞排除项（移植 pi 的 NON_OVERFLOW_PATTERNS）：Bedrock 等把限流文案写成
 *  "ThrottlingException: Too many tokens, please wait"，不排除就会误判成溢出、
 *  白压一轮上下文。 */
const NON_OVERFLOW_PATTERNS = [/^(?:throttling|service unavailable|too many requests|rate.?limit|resource exhausted)/i];

/**
 * 是否「上下文超长」类错误：压缩一次后原样重放本轮即可恢复（对齐 Cline 的
 * context-window 恢复路径）。只在 400 / 413 / 422 且措辞命中时判定——宽泛匹配会把
 * 普通 400 也拖去压缩，白费一轮模型调用；鉴权 / 计费 / 限流直接否。
 */
export function isContextOverflow(err) {
  if (!err) return false;
  if (err.kind === 'auth' || err.kind === 'quota' || err.kind === 'rate_limit') return false;
  const status = Number(err.status) || 0;
  if (status && status !== 400 && status !== 413 && status !== 422) return false;
  const message = String(err.message || '');
  if (!message) return false;
  if (NON_OVERFLOW_PATTERNS.some((re) => re.test(message))) return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((re) => re.test(message));
}

/**
 * 用量口径的静默溢出：round「成功」返回，但 reported usage.input（含缓存命中）已经顶到
 * 模型窗口——字符估算（chars/4）偏小，下一轮请求必被上游 400 拒。与其等报错再白烧一轮
 * 压缩，不如 round 结束时判定一次、就地先压（移植 pi overflow.ts 的 usage 口径）。
 * 窗口未知（0）或 usage 缺失时无从判定，保守返回 false。
 */
export function isUsageOverflow(usage, contextWindow) {
  const win = Number(contextWindow) || 0;
  if (!win || !usage || typeof usage !== 'object') return false;
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.input ?? 0);
  const cached = Number(usage.cachedTokens ?? usage.cache_read ?? 0);
  return input + cached >= win * 0.99;
}

/**
 * finishReason=length 但产出远低于本轮 max_tokens：多半是上下文把输出空间挤没了（或
 * 上游按窗口静默截断，如 Xiaomi MiMo 把输入裁满窗口后 output=0）。这种截断续写救不回来，
 * 该先压缩再重放（移植 pi overflow.ts 的 isRecoverableLength）。
 */
export function isRecoverableLength(stopReason, outputTokens, desiredMaxTokens) {
  const want = Number(desiredMaxTokens) || 0;
  if (stopReason !== 'length' || want <= 0) return false;
  return (Number(outputTokens) || 0) < want;
}

/** 连接期瞬时故障措辞库（移植 pi RETRYABLE_PROVIDER_ERROR_PATTERN 本地化子集）：
 *  限流 / 5xx / 网络中断 / 流提前结束的常见说法（undici / Node / 中转网关口径）。
 *  用于裸 Error（非 TypeError、无 kind/status）的兜底判定。 */
export const TRANSIENT_WORDING = /overloaded|currently experiencing high demand|rate.?limit|too many requests|\b429\b|\b50[0-4]\b|\b52[04]\b|service.?unavailable|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?error|connection.?refused|connection.?lost|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket hang up|socket connection was closed|timed? ?out|timeout|terminated|websocket.?closed|ended without|stream ended before|retry delay|you can retry your request/i;

/** 明确不该重试的额度 / 订阅类措辞（移植 pi NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN）：
 *  HTTP 429 也可能是「订阅用量到顶」而非限流（OpenCode Zen / ChatGPT 家庭共享都这么干），
 *  重试 / 换路只会烧时间。独立的模式而非并进 QUOTA_WORDING——那个还参与状态码分类，
 *  误报一次就把 400 说成计费问题。 */
export const NON_RETRYABLE_WORDING = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded/i;

/** 措辞口径的非重试判定（额度 / 订阅类先否，其余命中瞬时措辞才算故障） */
export function isNonRetryableWording(text) {
  return NON_RETRYABLE_WORDING.test(String(text || ''));
}

/** 裸 Error 的瞬时故障兜底：非额度类 + 命中瞬时措辞。kind / status 判定之外的最后一层。 */
export function isTransientError(err) {
  if (!err) return false;
  const message = String(err.message || err || '');
  if (!message || isNonRetryableWording(message)) return false;
  return TRANSIENT_WORDING.test(message);
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
