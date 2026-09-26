/** math-split.mjs 的类型声明（实现是零依赖纯函数，Node 测试直接 import 同一份）。 */
export type MathSegment =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'math'; tex: string; raw: string; display: boolean };

/** KaTeX 认识、允许裸写（不带 $$ 或 \[\]）的数学环境 */
export declare const MATH_ENVIRONMENTS: ReadonlySet<string>;

/** 行内公式若含只准显示模式的环境，整体升格为显示公式 */
export declare function mathDisplay(tex: string, display: boolean): boolean;

/** 行首是否开启一个跨行显示公式块 */
export declare function isDisplayMathStart(line: string): boolean;

/** 从 lines[i] 开始吃掉一个显示公式块；分隔符未闭合返回 null。闭合行尾部还有正文时带回 rest */
export declare function takeDisplayMath(lines: string[], i: number): { tex: string; raw: string; next: number; rest?: string } | null;

/** 把一段（不含代码块的）文本切成片段 */
export declare function splitMathSegments(text: string): MathSegment[];
