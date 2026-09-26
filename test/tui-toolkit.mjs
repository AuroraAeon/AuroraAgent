/**
 * TUI 工具包单元测试（util/tui/*）：主题 / 键位 / 渲染 / 列表状态机。
 * 由 run-tests.mjs 注入 test/assert/eq 后调用，保持与主套件同一计数与退出码。
 */
import { PALETTES, TOKEN_NAMES, auditPalette, createPainter, paletteFor } from '../util/tui/theme.mjs';
import { printableChar, isPrintableChar, matchesKey, KEY } from '../util/tui/printable-key.mjs';
import { displayWidth, truncateToWidth, padToWidth, hline } from '../util/tui/render.mjs';
import { SearchableList } from '../util/tui/searchable-list.mjs';
import { SELECT_POINTER, CURRENT_MARK, SEP, ELLIPSIS } from '../util/tui/symbols.mjs';

export async function runTuiToolkitTests(test, assert, eq) {
  console.log('\nTUI 工具包单元测试');

  await test('theme: 语义色板覆盖全部 token', () => {
    for (const name of ['dark', 'light']) {
      for (const t of TOKEN_NAMES) assert(PALETTES[name][t], `${name} 缺少 token ${t}`);
    }
  });

  await test('theme: 暗 / 亮色板均通过 WCAG 对比度审计', () => {
    for (const name of ['dark', 'light']) {
      const issues = auditPalette(PALETTES[name]);
      assert(issues.length === 0, `${name} 对比度不足: ${JSON.stringify(issues)}`);
    }
  });

  await test('theme: createPainter 用真彩色 SGR 且随色板变化', () => {
    const p = createPainter(PALETTES.dark);
    assert(p.paint('error', 'x').startsWith('\x1b[38;2;'), '应使用 24 位真彩色前景');
    assert(p.paint('error', 'x').endsWith('\x1b[0m'), '应以 reset 收尾');
    const p2 = createPainter(PALETTES.light);
    assert(p.paint('primary', 'a') !== p2.paint('primary', 'a'), '不同色板应产生不同转义');
    assert(p.bold('primary', 'y').startsWith('\x1b[1;38;2;'), 'bold 前置 1');
  });

  await test('theme: paletteFor 解析 dark / light / auto', () => {
    eq(paletteFor('dark').name, 'dark');
    eq(paletteFor('light').name, 'light');
    eq(paletteFor('auto', {}).name, 'dark');
  });

  await test('printable-key: Kitty CSI-u 解码为可打印字符', () => {
    eq(printableChar('\x1b[113u'), 'q');
    eq(printableChar('\x1b[97;2u'), 'a');
    eq(printableChar('a'), 'a');
    eq(printableChar(' '), ' ');
  });

  await test('printable-key: 功能键与控制序列返回 null', () => {
    eq(printableChar('\r'), null);
    eq(printableChar('\x1b'), null);
    eq(printableChar('\x1b[A'), null);
    eq(printableChar(''), null);
    eq(isPrintableChar('x'), true);
    eq(isPrintableChar('\x1b[A'), false);
  });

  await test('printable-key: matchesKey 识别应用 / 光标两种前缀', () => {
    eq(matchesKey('\r', KEY.enter), true);
    eq(matchesKey('\x1b[A', KEY.up), true);
    eq(matchesKey('\x1bOA', KEY.up), true);
    eq(matchesKey('a', KEY.enter), false);
  });

  await test('render: CJK 宽度 / 截断 / 补齐 / 水平线', () => {
    eq(displayWidth('你好ab'), 6);
    eq(displayWidth('a\u0301'), 1);
    eq(truncateToWidth('你好世界', 5), '你好…');
    eq(truncateToWidth('abc', 10), 'abc');
    eq(padToWidth('hi', 5), 'hi   ');
    eq(hline(3), '───');
  });

  await test('searchable-list: 过滤 / 光标 / 翻页 / 滚动窗口', () => {
    const items = ['aa', 'ab', 'ba', 'bb', 'ca'].map((id) => ({ id }));
    const l = new SearchableList(items, { pageSize: 2, text: (x) => x.id });
    l.setQuery('aa');
    eq(l.visible.map((x) => x.id).join(','), 'aa');
    l.setQuery('b');
    eq(l.visible.map((x) => x.id).join(','), 'ab,ba,bb');
    l.clearQuery();
    eq(l.visible.length, 5);
    l.down(); l.down();
    eq(l.selected.id, 'ba');
    eq(l.cursor, 2);
    const v = l.view();
    eq(v.rows.map((x) => x.id).join(','), 'ab,ba');
    eq(v.more, 2);
    l.pageDown();
    eq(l.selected.id, 'ca');
    eq(l.cursor, 4);
    eq(l.view().rows.map((x) => x.id).join(','), 'bb,ca');
    for (let i = 0; i < 10; i++) l.up();
    eq(l.cursor, 0);
  });

  await test('symbols: 常量齐全', () => {
    eq(SELECT_POINTER, '❯ ');
    eq(CURRENT_MARK, ' ← current');
    eq(SEP, ' · ');
    eq(ELLIPSIS.length, 1);
  });
}
