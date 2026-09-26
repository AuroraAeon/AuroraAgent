/**
 * 终端渲染纯助手：coordinator（terminal.mjs）与流式渲染器（terminal-turn.mjs）共用。
 * 只放无状态小函数，不 import 任何运行时（零依赖铁律）。
 */

/** 工具名 → 中文标签（终端单行状态与权限询问共用） */
export const TOOL_LABELS = {
  read_file: '读取文件', list_dir: '浏览目录', write_file: '写入文件',
  edit_file: '编辑文件', shell: '执行命令', web_fetch: '抓取网页',
};
export const toolLabel = (name) => TOOL_LABELS[name] || name;

/** 行内截断（按 JS 字符数；显示宽度裁剪由 util/tui/render 负责） */
export const truncate = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 费用格式化：小额用 6 位、常规 4 位 */
export const fmtCost = (cost) => (cost < 0.01 ? cost.toFixed(6) : cost.toFixed(4));

/** 工具输出缩进预览：截断 + 每行前缀（超过 8 行折叠） */
export function indent(text, limit) {
  const lines = String(text ?? '').split('\n');
  const shown = lines.length > 8 ? [...lines.slice(0, 8), `…（共 ${lines.length} 行）`] : lines;
  return shown.map((l) => `    ${truncate(l, limit)}`).join('\n');
}

/** 清当前行并回锚列首（工具单行状态刷新用；非颜色，故可留在组件里） */
export const CLEAR = '\r\x1b[K';
