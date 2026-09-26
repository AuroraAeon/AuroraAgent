/**
 * CJK 感知 + ANSI 感知的显示宽度 / 截断 / 对齐。对话框每行最终都过 truncateToWidth，
 * 保证窄终端、中日韩全角字符与已上色字符串下不超宽、不错位。
 * ANSI 转义序列（\x1b[...m）按零宽透传，截断后保留其前面的颜色、末尾补省略号。
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

const ANSI_CSI = /^\x1b\[[0-9;:]*[@-~]/;

/** 字符串在终端的显示列宽（全角 2、组合符 0、ANSI 转义 0） */
export function displayWidth(str) {
  const s = String(str ?? '');
  let w = 0;
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const m = ANSI_CSI.exec(rest);
    if (m) { i += m[0].length; continue; }
    const cp = s.codePointAt(i);
    if (isZeroWidth(cp)) { i += 1; continue; }
    w += isWide(cp) ? 2 : 1;
    i += cp > 0xffff ? 2 : 1;
  }
  return w;
}

/** 超宽则截断并补省略号，保证结果可见列宽 ≤ width；保留已出现的 ANSI 颜色 */
export function truncateToWidth(str, width) {
  const s = String(str ?? '');
  const max = Math.max(0, width);
  if (displayWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  let i = 0;
  while (i < s.length) {
    const rest = s.slice(i);
    const m = ANSI_CSI.exec(rest);
    if (m) { out += m[0]; i += m[0].length; continue; }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = isZeroWidth(cp) ? 0 : isWide(cp) ? 2 : 1;
    if (w + cw > max - 1) { return out + '…'; }
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + '…';
}

/** 右侧补空格到指定可见列宽（对齐次要列；ANSI 不计宽） */
export function padToWidth(str, width) {
  const s = String(str ?? '');
  const pad = Math.max(0, width - displayWidth(s));
  return s + ' '.repeat(pad);
}

/** 水平线（盒 drawing） */
export function hline(width, ch = '─') {
  return ch.repeat(Math.max(0, width));
}
