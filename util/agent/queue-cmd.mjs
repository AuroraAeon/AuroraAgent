/**
 * 终端 /queue 家族命令的纯函数层（与 web-ui Composer 队列条同源同语义）：
 * 解析子命令、把队列项格式化成可读行。终端 REPL 与测试直接 import 同一份，
 * 颜色由调用方按需上色（util/tui/theme.mjs 是唯一允许原始 SGR 的文件）。
 *
 * 子命令：
 *   /queue              列出等待中的消息（位置 + 文本摘要）
 *   /queue send <序号>   立即发送：挪到队首，下一个就被泵接走
 *   /queue drop <序号>   移除等待中的消息
 *   /queue clear         清空整条队列
 */

/** 队列项 → 单行展示（序号 + 文本；过长按终端宽度截断由调用方决定） */
export function formatQueueItem(index, item) {
  const pos = String(index + 1).padStart(2, ' ');
  return `${pos}. ${item.text || '（空）'}`;
}

/** 队列列表 → 展示行；空队列给一句可操作提示 */
export function formatQueueLines(items) {
  if (!items || !items.length) return ['队列为空：生成中直接输入消息即自动排队'];
  return items.map((it, i) => formatQueueItem(i, it));
}

/**
 * 解析 /queue 参数。
 * @returns {{ action: 'list' } | { action: 'send'|'drop', index: number } | { action: 'clear' } | { action: 'error', message: string }}
 */
export function parseQueueArg(raw) {
  const arg = String(raw || '').trim();
  if (!arg) return { action: 'list' };
  const m = /^(send|drop|rm|remove|clear)\b([\s\S]*)$/i.exec(arg);
  if (!m) return { action: 'error', message: '用法: /queue [send <序号>|drop <序号>|clear]（无参列出等待中的消息）' };
  const verb = m[1].toLowerCase();
  if (verb === 'clear') return { action: 'clear' };
  const rest = m[2].trim();
  const n = /^-?\d+$/.test(rest) ? Number(rest) : NaN;
  if (!Number.isInteger(n) || n < 1) return { action: 'error', message: `用法: /queue ${verb} <序号>（序号见 /queue 列表，从 1 开始）` };
  return { action: verb === 'send' ? 'send' : 'drop', index: n - 1 };
}

/** 按序号取项：越界返回 null 并给出中文原因（调用方直接打印） */
export function pickQueueItem(items, index) {
  if (!items || !items.length) return { error: '队列为空，没有可操作的消息' };
  if (index < 0 || index >= items.length) return { error: `序号超出范围：队列共 ${items.length} 条` };
  return { item: items[index] };
}
