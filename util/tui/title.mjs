/**
 * OSC 终端标题（零依赖）：OSC 0（\x1b]0;标题\x07）同时设置窗口与图标标题。
 * 按 tui.terminalTitle 项序拼装：state（状态词）· session（会话名）· app（AuroraAgent），
 * 例「生成中 | 新会话 | AuroraAgent」。置空项序 = 关闭（buildTerminalTitle 返回 null，
 * 调用方据此不写任何序列）。退出 / 挂起时清空，恢复后由调用方按当前状态重设。
 */

/** 拼装标题；项序为空或全段为空返回 null（调用方不写序列） */
export function buildTerminalTitle(items, parts) {
  const segs = [];
  for (const it of items || []) {
    const v = String((parts || {})[it] || '').trim();
    if (v) segs.push(v);
  }
  return segs.length ? segs.join(' | ') : null;
}

/** 写标题的 OSC 序列（剥离 ESC / BEL / 换行，防止会话名注入序列） */
export function oscTitle(title) {
  return `\x1b]0;${String(title).replace(/[\x07\x1b\r\n]/g, '')}\x07`;
}

/** 清空标题（退出 / 挂起用） */
export function clearTitle() {
  return '\x1b]0;\x07';
}
