/**
 * 单选对话框与增量重绘单测（util/tui/{pick,screen}.mjs）：非 TTY 回退解析、
 * makeScreen 帧差逻辑、pick 非 TTY 分支（假 io + ask 桩，不碰真实 stdin）。
 */
import { dialogWidth, resolvePickAnswer, pick } from '../util/tui/pick.mjs';
import { makeScreen } from '../util/tui/screen.mjs';
import { SearchableList } from '../util/tui/searchable-list.mjs';
import { createPainter, PALETTES } from '../util/tui/theme.mjs';

const strip = (s) => String(s).replace(/\x1b\[[0-9;:]*m/g, '');

function fakeIo({ tty = false, columns = 60 } = {}) {
  const writes = [];
  return {
    writes,
    stdin: { isTTY: tty, setRawMode() {}, rawListeners: () => [], isRaw: false },
    stdout: { columns, write(s) { writes.push(String(s)); return true; } },
  };
}

export async function runPickTests(test, assert, eq) {
  console.log('\n单选对话框 / 增量重绘单测');
  const p = createPainter(PALETTES.dark);
  const items = () => new SearchableList([
    { id: 'longcat', label: 'LongCat-2.5-Preview' },
    { id: 'gpt5', label: 'GPT-5' },
    { id: 'kimi', label: 'Kimi K2' },
  ], { text: (x) => x.label });

  await test('pick: resolvePickAnswer 序号 / id / 包含匹配 / 空值取消', () => {
    const list = items();
    eq(resolvePickAnswer('2', list).id, 'gpt5');
    eq(resolvePickAnswer(' 1 ', list).id, 'longcat');
    eq(resolvePickAnswer('9', list), null, '越界序号');
    eq(resolvePickAnswer('kimi', list).id, 'kimi', 'id 全等');
    eq(resolvePickAnswer('KIMI', list).id, 'kimi', 'id 大小写不敏感');
    eq(resolvePickAnswer('K2', list).id, 'kimi', '名称包含');
    eq(resolvePickAnswer('nope', list), null);
    eq(resolvePickAnswer('', list), null, '空输入取消');
    eq(resolvePickAnswer(null, list), null);
    list.setQuery('gpt');
    eq(resolvePickAnswer('1', list).id, 'gpt5', '序号作用于过滤后的可见列表');
  });

  await test('pick: dialogWidth 夹取范围', () => {
    eq(dialogWidth(fakeIo({ columns: 200 })), 72);
    eq(dialogWidth(fakeIo({ columns: 60 })), 58);
    eq(dialogWidth(fakeIo({ columns: 20 })), 56, '过窄回退');
  });

  await test('screen: makeScreen 首帧直画、次帧上锚重绘、短帧清尾行', () => {
    const out = { writes: [], write(s) { this.writes.push(String(s)); return true; } };
    const screen = makeScreen(out);
    screen.draw(['第一行', '第二行']);
    eq(out.writes.join(''), '\r\x1b[K第一行\n\r\x1b[K第二行');
    screen.draw(['新一', '新二', '新三']);
    eq(out.writes[1], '\x1b[1A\r\x1b[K新一\n\r\x1b[K新二\n\r\x1b[K新三', '次帧先上移一行再逐行重画');
    screen.draw(['只剩一行']);
    eq(out.writes[2], '\x1b[2A\r\x1b[K只剩一行\n\r\x1b[K\n\r\x1b[K', '短帧清掉旧帧多出的两行');
    eq(screen.frameLines, 1);
    screen.close();
    eq(out.writes[3], '\n', 'close 下移出框');
    screen.close();
    eq(out.writes.length, 4, '无帧时 close 不输出');
  });

  await test('pick: 非 TTY 打印渲染结果并按 ask 结果返回', async () => {
    const io = fakeIo();
    const answers = ['2'];
    const got = await pick({
      list: items(), title: '选择会话', hint: '↑↓ navigate', painter: p, io,
      ask: async () => answers.shift(),
    });
    eq(got.id, 'gpt5');
    const text = strip(io.writes.join(''));
    assert(text.includes('选择会话') && text.includes('LongCat-2.5-Preview'), '打印了对话框');
    assert(text.includes('输入序号或 id'), '非 TTY 提示行');
  });

  await test('pick: 非 TTY 空回答取消；无 ask 时返回 null', async () => {
    const io = fakeIo();
    eq(await pick({ list: items(), title: 't', hint: 'h', painter: p, io, ask: async () => '' }), null);
    eq(await pick({ list: items(), title: 't', hint: 'h', painter: p, io }), null);
  });
}
