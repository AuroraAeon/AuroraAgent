/** 思考过程（复刻 ZCode Reasoning / ReasoningTrigger）纯函数层：正文归一（剥开头空行）、
 *  流式摘要取值（最后一个非空行）、溢出判定。组件 ThinkingBlock 与 Node 测试共用本文件；
 *  零依赖，与 math-split / md-table / turn-nav 同组织方式。 */

/** 思考正文归一：剥掉开头的空行——模型常在思考内容前吐 \n\n，不处理的话展开后第一行是空白。
 *  只剥「空行」，保留首个内容行自身的缩进 */
export function normalizeThinkingText(text) {
  return String(text ?? '').replace(/^(?:[ \t]*\r?\n)+/, '');
}

/** 流式摘要：取最后一个非空行并去首尾空白（ZCode resolveReasoningStreamingSummary） */
export function resolveReasoningStreamingSummary(streamingText) {
  const lines = String(streamingText ?? '').replace(/\r\n?/g, '\n').split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index].trim();
    if (text.length > 0) return text;
  }
  return '';
}

/** 摘要是否溢出视口（1px 容差，ZCode isReasoningSummaryOverflowing；溢出才挂渐隐遮罩） */
export function isReasoningSummaryOverflowing(clientWidth, scrollWidth) {
  return scrollWidth > clientWidth + 1;
}
