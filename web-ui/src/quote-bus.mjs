/** 选中引用总线：ChatView 的选区浮钮 → Composer 输入框。
 *  两者是 App 下的兄弟节点（各自渲染），用一个 CustomEvent 解耦，
 *  免得把「引用状态」一路 prop 穿层——那会让 App 多一份与输入框私事相关的状态。 */

const EVENT = 'aurora:quote';

/** 把选中的原文包成 Markdown 引用块（每行加 > 前缀，块后留一空行给用户接话） */
export function quoteBlock(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return `${lines.map((l) => (l ? `> ${l}` : '>')).join('\n')}\n\n`;
}

export function emitQuote(text) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { text } }));
}

/** @returns {() => void} 取消订阅 */
export function onQuote(cb) {
  const handler = (ev) => cb(ev.detail?.text || '');
  window.addEventListener(EVENT, handler);
  return () => window.removeEventListener(EVENT, handler);
}
