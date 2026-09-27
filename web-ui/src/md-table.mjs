/**
 * Markdown 表格块解析（GFM 子集，零依赖纯函数；Node 测试直接 import 同一份）。
 * 成表条件（对齐 GFM 规则）：表头行含管道、下一行是分隔行（每格仅连字符与可选对齐冒号）、
 * 两行单元格数一致；裸 `---`（无管道）是分隔线不成表，列数不匹配不成表。
 * 本文件只负责「是不是表、切成什么样」；渲染（thead/tbody/对齐）在 markdown.tsx。
 */

/** 单个分隔单元格：可选前后冒号 + 至少一个连字符 */
const DELIM_CELL_RE = /^\s*:?-+:?\s*$/;

/** 分隔行：管道分隔的若干分隔单元格，允许省略首尾管道；必须含至少一个 | 与一个单元格 */
export function isTableDelimiterRow(line) {
  const s = String(line ?? '');
  if (!s.includes('|')) return false;
  const cells = s.split('|');
  if (cells.length > 2 && cells[0].trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.length > 0 && cells.every((cell) => DELIM_CELL_RE.test(cell));
}

/** 按未转义 | 切行；首尾各剥一个空单元格（外层管道），\| 还原为 |，单元格去首尾空白 */
export function splitTableRow(line) {
  const s = String(line ?? '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  if (cells.length > 1 && cells[0].trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

/** 分隔单元格 → 对齐：:---: 居中、---: 右对齐、其余左对齐 */
function alignOf(cell) {
  const c = cell.trim();
  const left = c.startsWith(':');
  const right = c.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/**
 * 从 lines[i] 起尝试吃一个表格块；不成表返回 null。
 * @returns {{ header: string[], align: string[], rows: string[][], next: number } | null}
 *   next 指向块后第一行；数据行在空行或不含管道的行处收尾
 */
export function parseTableBlock(lines, i) {
  const head = lines[i];
  if (!head || !head.includes('|') || isTableDelimiterRow(head)) return null;
  const delim = lines[i + 1];
  if (delim === undefined || !isTableDelimiterRow(delim)) return null;
  const header = splitTableRow(head);
  const align = splitTableRow(delim).map(alignOf);
  if (align.length !== header.length) return null; // 列数不匹配不成表（GFM 规则）
  const rows = [];
  let j = i + 2;
  while (j < lines.length) {
    const line = lines[j];
    if (!line.trim() || !line.includes('|')) break;
    rows.push(splitTableRow(line));
    j++;
  }
  return { header, align, rows, next: j };
}
