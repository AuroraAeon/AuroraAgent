/** reasoning.mjs 的类型声明（实现是零依赖纯函数，Node 测试直接 import 同一份）。 */

/** 剥掉开头空行后的思考正文（保留首个内容行的自身缩进） */
export declare function normalizeThinkingText(text: string): string;

/** 流式摘要文本（最后一个非空行；无内容返回空串） */
export declare function resolveReasoningStreamingSummary(streamingText: string): string;

/** 摘要是否溢出视口（1px 容差） */
export declare function isReasoningSummaryOverflowing(clientWidth: number, scrollWidth: number): boolean;
