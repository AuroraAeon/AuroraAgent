/** transcript.mjs 的类型声明（实现是零依赖纯函数，Node 测试与 Web 两端 import 同一份）。 */
export declare const TOOL_LABELS: Readonly<Record<string, string>>;

/** MCP 工具名 → 可读标签：mcp__<服务器>__<工具> → 「<服务器>.<工具>（MCP）」 */
export declare function toolLabel(name: string): string;

/** 工具名 → 图标键（Web 映射到内联 SVG，终端忽略） */
export declare function toolIconKey(name: string): string;

/** 工具资源摘要：文件类取路径，shell 取命令，检索取模式，抓取取 URL */
export declare function toolResourceOf(name: string, args: unknown): string;

/** 费用格式化：小额 6 位、常规 4 位 */
export declare function fmtCost(cost: number): string;

export type ProjectedText = { kind: 'text'; text: string };
export type ProjectedTool = { kind: 'tool'; id: string; name: string; args: unknown; ok: boolean | null; output: string; extra: unknown };
export type ProjectedPart = ProjectedText | ProjectedTool;
export type ProjectedTurn =
  | { kind: 'user'; text: string; at?: string }
  | { kind: 'system'; text: string; at?: string }
  | {
      kind: 'round';
      /** 时间线片段：文本与工具调用交错（回答不被工具调用切断） */
      parts: ProjectedPart[];
      /** 兼容视图：parts 汇总（text = 文本片段按序汇总，tools = 工具片段数组） */
      text: string;
      tools: ProjectedTool[];
      thinking: string;
      usage: { inputTokens: number; outputTokens: number; cost: number } | null;
      at?: string;
    };

/** 记录 → 中性轮次投影（分组规则与 Web 历史渲染契约一致：用户轮内时间线交错） */
export declare function projectTurns(records: unknown[]): { turns: ProjectedTurn[] };
