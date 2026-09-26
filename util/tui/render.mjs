/**
 * CJK 感知的显示宽度 / 截断 / 对齐。对话框每行最终都过 truncateToWidth，
 * 保证窄终端与中日韩全角字符下不超宽、不错位。
 */
function isZeroWidth(cp) {
  return cp === 0x200b || (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0xfe00 && cp <= 0xfe0f);
}
function isWide(cp) {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) || (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd);
}

/** 字符串在终端的显示列宽（全角 2、组合符 0） */
export function displayWidth(str) {
  let w = 0;
  for (const ch of String(str ?? '')) {
    const cp = ch.codePointAt(0);
    if (isZeroWidth(cp)) continue;
    w += isWide(cp) ? 2 : 1;
  }
  return w;
}

/** 超宽则截断并补省略号，保证结果列宽 ≤ width */
export function truncateToWidth(str, width) {
  const s = String(str ?? '');
  const max = Math.max(0, width);
  if (displayWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const cw = isZeroWidth(cp) ? 0 : isWide(cp) ? 2 : 1;
    if (w + cw > max - 1) { out += '…'; return out; }
    out += ch;
    w += cw;
  }
  return out + '…';
}

/** 右侧补空格到指定列宽（对齐次要列） */
export function padToWidth(str, width) {
  const s = String(str ?? '');
  const pad = Math.max(0, width - displayWidth(s));
  return s + ' '.repeat(pad);
}

/** 水平线（盒drawing） */
export function hline(width, ch = '─') {
  return ch.repeat(Math.max(0, width));
}
