/**
 * Markdown 表格单测（web-ui/src/md-table.mjs 的 Node 侧直接 import）
 * + markdown.tsx / app.css 接入契约（表格块走 parseTableBlock，渲染 thead/tbody 与滚动包裹层）。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTableDelimiterRow, splitTableRow, parseTableBlock } from '../web-ui/src/md-table.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export async function runMarkdownTests(test, assert, eq) {
  console.log('\nMarkdown 表格单测');

  await test('md-table: 基本表格（表头 / 分隔 / 数据行 / next 指向块后）', () => {
    const lines = ['| 名称 | 说明 |', '| --- | --- |', '| 甲 | 第一项 |', '| 乙 | 第二项 |', '', '正文'];
    const t = parseTableBlock(lines, 0);
    eq(t.header.join('|'), '名称|说明');
    eq(t.align.join('|'), 'left|left');
    eq(t.rows.length, 2);
    eq(t.rows[1].join('|'), '乙|第二项');
    eq(t.next, 4, 'next 应指向空行');
  });

  await test('md-table: 对齐方式解析（左 / 中 / 右）', () => {
    const lines = ['| a | b | c |', '| :--- | :---: | ---: |', '| 1 | 2 | 3 |'];
    const t = parseTableBlock(lines, 0);
    eq(t.align.join('|'), 'left|center|right');
    const none = parseTableBlock(['| a |', '| --- |', '| 1 |'], 0);
    eq(none.align[0], 'left', '缺省左对齐');
  });

  await test('md-table: 省略首尾管道同样成表', () => {
    const t = parseTableBlock(['a | b', '--- | ---', '1 | 2'], 0);
    eq(t.header.join('|'), 'a|b');
    eq(t.rows.length, 1);
    eq(t.rows[0].join('|'), '1|2');
  });

  await test('md-table: 裸 --- 与无管道行不成表', () => {
    eq(parseTableBlock(['标题', '---', '正文'], 0), null, '裸 --- 是分隔线不是表');
    eq(parseTableBlock(['普通段落', '下一行'], 0), null, '缺分隔行不成表');
    eq(isTableDelimiterRow('---'), false, '无管道不算分隔行');
    eq(isTableDelimiterRow('| --- |'), true);
    eq(isTableDelimiterRow('| :---: | ---: |'), true);
    eq(isTableDelimiterRow('| a | b |'), false, '含字母不是分隔行');
    eq(isTableDelimiterRow(''), false);
  });

  await test('md-table: 分隔行列数与表头不匹配不成表', () => {
    eq(parseTableBlock(['| a | b |', '| --- |', '| 1 |'], 0), null);
    eq(parseTableBlock(['| a |', '| --- | --- |', '| 1 | 2 |'], 0), null);
  });

  await test('md-table: 转义管道不切格、单元格修剪', () => {
    const t = parseTableBlock(['|  a  | b \\| c |', '| --- | --- |', '| x | y |'], 0);
    eq(t.header[0], 'a', '首尾空白应修剪');
    eq(t.header[1], 'b | c', '转义管道应还原为单元格内容');
    eq(splitTableRow('|| 空首格 | 尾 |').join('|'), '|空首格|尾', '行首连续管道保留一个空单元格');
  });

  await test('md-table: 数据行在空行 / 不含管道行处收尾', () => {
    const t = parseTableBlock(['| a |', '| - |', '| 1 |', '后续段落', '| 2 |'], 0);
    eq(t.rows.length, 1, '不含管道的行结束表格');
    eq(t.next, 3);
    const blank = parseTableBlock(['| a |', '| - |', '', '| 1 |'], 0);
    eq(blank.rows.length, 0);
    eq(blank.next, 2);
  });

  await test('md-table: 表格不成型时表头行仍是普通段落（不被吞）', () => {
    eq(parseTableBlock(['| 只要一个管道'], 0), null);
    eq(parseTableBlock([], 0), null);
  });

  await test('markdown.tsx 接入契约：表格走 parseTableBlock 并渲染 thead/tbody', () => {
    const md = readFileSync(join(ROOT, 'web-ui', 'src', 'markdown.tsx'), 'utf8');
    assert(md.includes("from './md-table.mjs'"), 'Markdown 渲染器应引入表格解析');
    assert(md.includes('parseTableBlock(lines, i)') && md.includes('i = table.next'), '主循环应消费表格块并推进行号');
    assert(md.includes('!parseTableBlock(lines, i)'), '段落累积应在表格起始处断开');
    assert(md.includes('<thead>') && md.includes('<tbody>') && md.includes('<th') && md.includes('<td'), '应渲染表头与数据单元格');
    assert(md.includes('textAlign'), '应对齐分隔行指定的对齐方式');
    const css = readFileSync(join(ROOT, 'web-ui', 'src', 'app.css'), 'utf8');
    assert(css.includes('.md-table-wrap') && css.includes('.md table') && css.includes('.md thead th'), 'app.css 应有表格与滚动包裹层样式');
  });
}
