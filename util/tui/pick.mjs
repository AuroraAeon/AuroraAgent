/**
 * 单选对话框（docs/tui-design.md 第 3-5 节）：TTY 下原始模式读键驱动 SearchableList 并增量
 * 重绘；非 TTY（管道 / 单次提问）退化为「渲染列表 + 读一行序号 / id」。
 * 与 readline 共存的机制：拾荒期间临时摘下 readline 挂在 stdin 上的 keypress 监听——
 * emitKeypressEvents 的内部 data 监听在无 keypress 监听时会自行卸载，待 keypress 监听重新挂上
 * 时经 newListener 自行恢复（已由 pty 实验验证：REPL 输入不受污染、无字符泄漏进行缓冲）。
 */
import { renderSelect } from './select.mjs';
import { makeScreen } from './screen.mjs';
import { printableChar, matchesKey, KEY } from './printable-key.mjs';

/** 对话框宽度：终端列数 -2，夹在 [30, 72]；非 TTY 取回退值 */
export function dialogWidth(io = process, fallback = 56) {
  const cols = io.stdout && io.stdout.columns;
  return Number.isInteger(cols) && cols >= 32 ? Math.min(cols - 2, 72) : fallback;
}

/** 非 TTY 回退：把一行答案解析为选中项（1 起序号 / id 全等 / 名称包含）；空或无法匹配返回 null */
export function resolvePickAnswer(answer, list) {
  const a = String(answer == null ? '' : answer).trim();
  if (!a) return null;
  const items = list.visible;
  if (/^\d+$/.test(a)) return items[Number(a) - 1] || null;
  const lower = a.toLowerCase();
  const text = (it) => list.text(it).toLowerCase();
  return items.find((it) => String(it.id ?? it).toLowerCase() === lower)
    || items.find((it) => text(it).includes(lower))
    || null;
}

/** TTY 交互选择：返回选中项或 null（Esc / Ctrl+C / Ctrl+D 取消）。键位规范见 docs/tui-design.md 第 5 节 */
export function pickInteractive({ list, render, io = process }) {
  const stdin = io.stdin;
  const screen = makeScreen(io.stdout || process.stdout);
  const saved = typeof stdin.rawListeners === 'function' ? stdin.rawListeners('keypress').slice() : [];
  const wasRaw = stdin.isRaw === true;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      stdin.removeListener('data', onKey);
      for (const l of saved) stdin.on('keypress', l);
      if (typeof stdin.setRawMode === 'function') stdin.setRawMode(wasRaw);
      screen.close();
      resolve(value);
    };
    function onKey(data) {
      const key = String(data);
      if (matchesKey(key, KEY.up)) list.up();
      else if (matchesKey(key, KEY.down)) list.down();
      else if (matchesKey(key, KEY.pageUp)) list.pageUp();
      else if (matchesKey(key, KEY.pageDown)) list.pageDown();
      else if (matchesKey(key, KEY.enter)) { settle(list.selected); return; }
      else if (matchesKey(key, KEY.escape)) {
        if (list.query) list.clearQuery();
        else settle(null);
      } else if (key === '\x03' || key === '\x04') { settle(null); return; }
      else if (matchesKey(key, KEY.backspace)) { if (list.query) list.setQuery(list.query.slice(0, -1)); }
      else if (list.searchable) {
        const ch = printableChar(key);
        if (ch != null) list.setQuery(list.query + ch);
      }
      screen.draw(render());
    }
    for (const l of saved) stdin.removeListener('keypress', l);
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true);
    stdin.on('data', onKey);
    screen.draw(render());
  });
}

/** 统一入口：TTY 走交互选择，否则打印渲染结果并读一行（ask 返回的行） */
export async function pick(options) {
  const io = options.io || process;
  const width = options.width || dialogWidth(io);
  const render = () => renderSelect({
    list: options.list, title: options.title, hint: options.hint, width,
    columns: options.columns, currentId: options.currentId, painter: options.painter,
  });
  const stdin = io.stdin;
  if (stdin && stdin.isTTY === true && typeof stdin.setRawMode === 'function') {
    return pickInteractive({ list: options.list, render, io });
  }
  const out = io.stdout || process.stdout;
  for (const line of render()) out.write(line + '\n');
  if (typeof options.ask !== 'function') return null;
  out.write(` ${options.painter.muted('输入序号或 id')} ${options.painter.primary('›')} `);
  return resolvePickAnswer(await options.ask(), options.list);
}
