/** reasoning-summary.mjs 的类型声明（实现是零依赖纯函数，Node 测试直接 import 同一份）。 */

/** 流式摘要文本（最后一个非空行；无内容返回空串） */
export declare function resolveReasoningStreamingSummary(streamingText: string): string;

/** 摘要是否溢出视口（1px 容差） */
export declare function isReasoningSummaryOverflowing(clientWidth: number, scrollWidth: number): boolean;
