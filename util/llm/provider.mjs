/**
 * LLM 抽象层：provider 无关的请求 + 流编排。/api/chat 与 Agent Loop 共用同一入口，
 * 两条路径的「构造请求 → 连接期重试 → 错误话术 → 帧翻译选择」行为因此一致。
 * 协议差异（URL / 请求形状 / 帧翻译）由 wire.mjs 承担，错误分类在 llm/errors.mjs。
 */
import { buildChatRequest, anthropicFrame, fetchUpstream } from '../wire.mjs';
import { classifyStatus, upstreamHint } from './errors.mjs';

/** 连接期重试的默认参数（与历史语义一致：仅网络层失败重试，500ms 递增） */
const RETRY_OPTS = { attempts: 3 };

/**
 * 打开一条上游对话流。
 * @param provider 提供方记录（含 protocol / baseUrl / apiKey / builtin）
 * @param opts     buildChatRequest 的 opts（model / messages / toolNames / extraTools / gen 参数）
 * @param io       { signal, onRetry }
 * @returns {{ reader: ReadableStreamDefaultReader, translate: function|undefined }}
 *          上游非 2xx 时抛出带 kind / status 的 Error（message 即中文提示）；
 *          网络层失败原样抛出（kind=network），调用方按需兜底。
 */
export async function openChatStream(provider, opts, io = {}) {
  const wire = buildChatRequest(provider, opts);
  const resp = await fetchUpstream(wire, { ...RETRY_OPTS, signal: io.signal, onRetry: io.onRetry });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    const err = new Error(upstreamHint(provider, resp.status, errText));
    err.kind = classifyStatus(resp.status, errText);
    err.status = resp.status;
    throw err;
  }
  return {
    reader: resp.body.getReader(),
    translate: provider.protocol === 'anthropic' ? anthropicFrame : undefined,
  };
}
