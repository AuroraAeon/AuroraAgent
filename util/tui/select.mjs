/**
 * 列表选择对话框的纯渲染器（对齐 docs/tui-design.md 第 3 节）。返回字符串数组。
 * 交互（原始模式读键、驱动 SearchableList、重绘）由调用方完成；这里只管把状态画出来，
 * 因而可单测。颜色一律来自 painter，无原始 SGR。
 */
import { SELECT_POINTER, CURRENT_MARK, SCROLL_MORE } from './symbols.mjs';
import { truncateToWidth, padToWidth, displayWidth, hline } from './render.mjs';

function renderRow(item, idx, { list, width, columns, currentId, p }) {
  const selected = idx === list.cursor;
  const isCurrent = currentId != null && String(item.id ?? item) === String(currentId);
  const pointer = selected ? p.primary(SELECT_POINTER) : ' '.repeat(displayWidth(SELECT_POINTER));
  const label = String(item.label ?? item.name ?? item.id ?? item);
  const cols = columns ? (columns(item) || []) : [];
  const tailW = isCurrent ? displayWidth(CURRENT_MARK) : 0;
  const colsW = cols.reduce((s, c) => s + 2 + displayWidth(c.text), 0);
  const mainW = Math.max(8, width - 1 - displayWidth(SELECT_POINTER) - colsW - tailW);
  const main = truncateToWidth(label, mainW);
  const body = selected ? p.bold('primary', padToWidth(main, mainW)) : p.text(padToWidth(main, mainW));
  let line = pointer + body;
  for (const c of cols) line += '  ' + p.muted(truncateToWidth(c.text, c.width || 14));
  if (isCurrent) line += p.success(CURRENT_MARK);
  return truncateToWidth(line, width);
}

export function renderSelect({ list, title, hint, width = 48, columns, currentId, painter }) {
  const p = painter;
  const bar = hline(width);
  const out = [p.primary(bar)];
  const suffix = list.searchable && !list.query.trim() ? p.muted('  (type to search)') : '';
  out.push(p.bold('primary', truncateToWidth(' ' + title, width)) + suffix);
  out.push(p.muted(' ' + hint));
  out.push('');
  if (list.query.trim()) out.push(p.primary(' Search: ') + p.text(list.query));
  const view = list.view();
  if (!view.total) {
    out.push(p.muted('  No matches'));
  } else {
    for (let i = 0; i < view.rows.length; i++) {
      out.push(renderRow(view.rows[i], view.start + i, { list, width, columns, currentId, p }));
    }
  }
  out.push('');
  if (list.searchable && list.query.trim()) {
    out.push(p.muted(` ${view.total ? list.cursor + 1 : 0} / ${view.total}`));
  } else if (view.more > 0) {
    out.push(p.muted(` ${SCROLL_MORE} ${view.more} more`));
  }
  out.push(p.primary(bar));
  return out;
}
