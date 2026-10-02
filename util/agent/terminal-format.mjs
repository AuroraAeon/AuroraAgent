/**
 * 终端渲染纯助手：coordinator（terminal.mjs）与流式渲染器（terminal-turn.mjs）共用。
 * 只放无状态小函数，不 import 任何运行时（纯函数，终端与测试共用同一份）。
 */

// 工具词表（标签 / 图标键 / 资源摘要）单一真值源在 transcript.mjs，终端与 Web 共用
export { toolLabel, fmtCost } from './transcript.mjs';

/** 行内截断（按 JS 字符数；显示宽度裁剪由 util/tui/render 负责） */
export const truncate = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};


/** 工具输出缩进预览：截断 + 每行前缀（超过 8 行折叠） */
export function indent(text, limit) {
  const lines = String(text ?? '').split('\n');
  const shown = lines.length > 8 ? [...lines.slice(0, 8), `…（共 ${lines.length} 行）`] : lines;
  return shown.map((l) => `    ${truncate(l, limit)}`).join('\n');
}

/** 清当前行并回锚列首（工具单行状态刷新用；非颜色，故可留在组件里） */
export const CLEAR = '\r\x1b[K';
