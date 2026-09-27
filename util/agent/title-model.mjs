/**
 * 模型总结标题（titleMode=model）：用一次小额上游请求把首条用户消息总结成会话标题。
 * 与上下文压缩同属「额外模型调用」：失败绝不阻塞主流程，由调用方回退本地推导
 * （title.mjs 的 deriveTitle）。请求刻意保持极简——无工具、低温、低输出上限、
 * 只带系统提示与一条用户消息，控住每新会话一次的增量成本。
 */
import { openChatStream } from '../llm/provider.mjs';
import { consumeAgentStream } from '../stream.mjs';

/** 系统提示：只输出标题本身（话术规约与 llm/errors.mjs 的错误话术无关，这是任务指令） */
const SYSTEM_PROMPT = '【会话标题生成】你是标题生成器。根据用户的提问（可参考助手答复辅助理解）产出一个简短中文标题：不超过 12 个字，只输出标题本身；不要引号、书名号、前缀、解释，也不要标点结尾。';

/** 单次标题请求的输出上限：标题很短，压住增量成本 */
export const TITLE_MAX_TOKENS = 64;
/** 用户提问注入上限 */
const INPUT_SLICE = 500;
/** 助手答复注入上限（只作理解上下文，不进标题主语） */
const ANSWER_SLICE = 400;

/**
 * 调模型生成标题原文（未清洗，宽度与 emoji 仍由 deriveTitle 收口）。
 * @param ctx {{ provider, model, input, answer?, controller: AbortController }}
 * @returns {Promise<{ text: string, usage: object|null }>} 上游非 2xx / 网络失败原样抛出
 */
export async function generateTitleText({ provider, model, input, answer = '', controller }) {
  const parts = [`用户提问：${String(input || '').slice(0, INPUT_SLICE)}`];
  const tail = String(answer || '').trim();
  if (tail) parts.push(`助手答复（仅作参考）：${tail.slice(0, ANSWER_SLICE)}`);
  const opened = await openChatStream(provider, {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: parts.join('\n') },
    ],
    sendThinking: false, // 标题不需要思考过程：少花 token、少一次上游字段协商
    thinkingOn: false,
    maxTokens: TITLE_MAX_TOKENS,
    temperature: 0.2,
  }, { signal: controller.signal });
  const entry = { controller, usage: null };
  let text = '';
  await consumeAgentStream(opened.reader, entry, { onText: (t) => { text += t; } }, { translate: opened.translate });
  return { text, usage: entry.usage || null };
}
