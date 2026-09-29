/** 思考过程流式摘要（复刻 ZCode ReasoningTrigger）纯函数层：摘要取流式文本最后一个非空行
 *  （单行视口，长思考不撑高触发器）、溢出判定。组件 ThinkingBlock 与 Node 测试共用本文件；
 *  零依赖，与 math-split / md-table / turn-nav 同组织方式。 */

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
