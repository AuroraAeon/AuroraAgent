/**
 * 可打印键解码（Kitty 键盘协议）。现代终端（VSCode / Kitty / Ghostty）会把字母数字
 * 作为 CSI-u 序列上报（如 \x1b[113u 表示 'q'），裸比较 data === 'q' 永不命中。
 * 规则：字符比较一律先过 printableChar()；功能键走 matchesKey()；控制字符（<32）可裸比。
 */

/** CSI-u：ESC [ <codepoint> [; modifiers[: event]] u */
const CSI_U = /^\x1b\[(\d+)(?:[;:][\d:]*)*u$/;

/** 取按键对应的可打印字符；非可打印（功能键 / 控制序列）返回 null */
export function printableChar(data) {
  if (typeof data !== 'string' || !data) return null;
  const m = CSI_U.exec(data);
  if (m) {
    const cp = Number(m[1]);
    if (!Number.isFinite(cp) || cp < 32) return null;
    try { return String.fromCodePoint(cp); } catch { return null; }
  }
  if (data.length === 1) {
    const cp = data.codePointAt(0);
    return cp >= 32 && cp !== 127 ? data : null;
  }
  return null;
}

export function isPrintableChar(data) {
  return printableChar(data) !== null;
}

/** 功能键序列表（应用 / 光标两种前缀都收） */
const SEQ = {
  enter: ['\r', '\n'],
  escape: ['\x1b'],
  backspace: ['\x7f', '\x1b[3~'],
  tab: ['\t'],
  space: [' '],
  up: ['\x1b[A', '\x1bOA'],
  down: ['\x1b[B', '\x1bOB'],
  left: ['\x1b[D', '\x1bOD'],
  right: ['\x1b[C', '\x1bOC'],
  pageUp: ['\x1b[5~'],
  pageDown: ['\x1b[6~'],
  delete: ['\x1b[3~'],
};

export const KEY = {
  enter: 'enter', escape: 'escape', backspace: 'backspace', tab: 'tab', space: 'space',
  up: 'up', down: 'down', left: 'left', right: 'right', pageUp: 'pageUp', pageDown: 'pageDown',
  delete: 'delete',
};

export function matchesKey(data, key) {
  const list = SEQ[key];
  return Array.isArray(list) && list.includes(data);
}
