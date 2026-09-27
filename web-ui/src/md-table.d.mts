/** md-table.mjs 的类型声明（实现是零依赖纯函数，Node 测试直接 import 同一份）。 */
export type TableAlign = 'left' | 'center' | 'right';

export type TableBlock = {
  header: string[];
  align: TableAlign[];
  rows: string[][];
  next: number;
};

/** 管道分隔、每格仅连字符与可选冒号、至少含一个 | 的行（分隔行） */
export declare function isTableDelimiterRow(line: string): boolean;

/** 按未转义 | 切行并剥外层管道空单元格；\| 还原为 | */
export declare function splitTableRow(line: string): string[];

/** 从 lines[i] 起吃一个表格块；不成表（缺分隔行 / 列数不匹配）返回 null */
export declare function parseTableBlock(lines: string[], i: number): TableBlock | null;
