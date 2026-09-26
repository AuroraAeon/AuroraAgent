/**
 * 终端符号常量：对话框 / 选择器的单一真值源（规范见 docs/tui-design.md）。
 * 选中指针与「当前生效项」标记全仓库统一，组件禁止自造 > / ▶ / → / ● / (current)。
 * 这些是符号而非 emoji，属命令行惯例，允许保留（产品零 emoji 铁律不涉及它们）。
 */
export const SELECT_POINTER = '❯ ';      // 选中项（光标所在行）指针
export const CURRENT_MARK = ' ← current'; // 当前生效项行尾标记（success 色，前置一空格）
export const ELLIPSIS = '…';
export const ARROW_UP = '↑';
export const ARROW_DOWN = '↓';
export const ARROW_LEFT = '←';
export const ARROW_RIGHT = '→';
export const SCROLL_MORE = '▼';           // 列表底部「还有更多」指示
export const SEP = ' · ';                 // hint 段间分隔（单空格中点）
