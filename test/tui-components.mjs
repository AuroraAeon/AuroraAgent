/**
 * TUI 组件渲染单测（util/tui/{commands,select,footer}.mjs）：纯函数，断言语义与布局。
 */
import { parseCommand, defineCommands, commandHelpLines } from '../util/tui/commands.mjs';
import { renderSelect } from '../util/tui/select.mjs';
import { renderFooter } from '../util/tui/footer.mjs';
import { SearchableList } from '../util/tui/searchable-list.mjs';
import { createPainter, PALETTES } from '../util/tui/theme.mjs';

const strip = (s) => String(s).replace(/\x1b\[[0-9;:]*m/g, '');
const stripAll = (arr) => arr.map(strip);

export async function runTuiComponentTests(test, assert, eq) {
  console.log('\nTUI 组件渲染单测');
  const p = createPainter(PALETTES.dark);

  await test('commands: parseCommand 识别斜杠 / 参数 / 大小写', () => {
    eq(parseCommand('/model gpt-5').name, 'model');
    eq(parseCommand('/model gpt-5').arg, 'gpt-5');
    eq(parseCommand('/MODEL').name, 'model');
    eq(parseCommand('hello'), null);
    eq(parseCommand('/'), null);
    eq(parseCommand('/sessions 2').arg, '2');
  });

  await test('commands: defineCommands 索引 name 与 alias、过滤 hidden', () => {
    const cmds = defineCommands([
      { name: 'quit', aliases: ['exit'], summary: '退出' },
      { name: 'secret', summary: '隐藏', hidden: true },
    ]);
    eq(cmds.get('quit').name, 'quit');
    eq(cmds.get('exit').name, 'quit');
    eq(cmds.get('nope'), null);
    eq(cmds.visible().length, 1);
    const lines = commandHelpLines(cmds);
    eq(lines.length, 1);
    assert(lines[0].includes('/quit') && lines[0].includes('退出'));
  });

  await test('select: 布局含顶/底边框、标题、hint、指针与当前项标记', () => {
    const list = new SearchableList([{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }], { text: (x) => x.label });
    list.down();
    const lines = stripAll(renderSelect({ list, title: 'Select a model', hint: '↑↓ navigate · Enter select · Esc cancel', width: 48, currentId: 'a', painter: p }));
    eq(lines[0], '─'.repeat(48));
    assert(lines[1].startsWith(' Select a model'), '标题行');
    assert(lines[1].includes('(type to search)'), '可搜索无 query 时标题后缀');
    assert(lines[2].startsWith(' ↑↓ navigate'), 'hint 行');
    const rowA = lines.find((l) => l.includes('Alpha'));
    const rowB = lines.find((l) => l.includes('Beta'));
    assert(rowA.includes('❯') === false && rowB.includes('❯'), '指针在光标行 Beta');
    assert(rowA.includes('← current'), '当前项 Alpha 带标记');
    assert(!rowB.includes('← current'));
    eq(lines[lines.length - 1], '─'.repeat(48));
  });

  await test('select: 有 query 时显示 Search 行与 x/y 指示', () => {
    const list = new SearchableList([{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }], { text: (x) => x.label });
    list.setQuery('Alp');
    const lines = stripAll(renderSelect({ list, title: 'Select', hint: 'hint', width: 40, painter: p }));
    assert(lines.some((l) => l.startsWith(' Search: Alp')), 'Search 行');
    assert(lines.some((l) => l.trim() === '1 / 1'), 'x / y 指示');
    assert(!lines.some((l) => l.includes('(type to search)')), '有 query 不再显示后缀');
  });

  await test('select: 无匹配显示 No matches', () => {
    const list = new SearchableList([{ id: 'a', label: 'Alpha' }], { text: (x) => x.label });
    list.setQuery('zzz');
    const lines = stripAll(renderSelect({ list, title: 'Select', hint: 'hint', width: 40, painter: p }));
    assert(lines.some((l) => l.includes('No matches')));
  });

  await test('footer: 含模型/模式/思考/权限，窄宽度裁剪可选段', () => {
    const wide = strip(renderFooter({ model: 'LongCat-2.5', harness: 'Standard', thinking: true, permissionMode: 'ask_when_needed', tokens: 1234, cost: '0.5' }, p, 100));
    assert(wide.includes('模型') && wide.includes('LongCat-2.5') && wide.includes('Standard') && wide.includes('思考') && wide.includes('tokens'), '宽屏全段');
    const narrow = strip(renderFooter({ model: 'LongCat-2.5', harness: 'Standard', thinking: true, permissionMode: 'ask_when_needed', tokens: 1234, cost: '0.5' }, p, 30));
    assert(narrow.includes('LongCat-2.5'), '窄屏保留必需段');
    assert(!narrow.includes('tokens'), '窄屏裁剪可选 tokens 段');
    const modelTitle = strip(renderFooter({ model: 'LongCat-2.5', harness: 'Standard', thinking: true, permissionMode: 'ask_when_needed', titleMode: 'model' }, p, 100));
    assert(modelTitle.includes('标题') && modelTitle.includes('模型总结'), '模型总结标题时应显示标题段');
    const localTitle = strip(renderFooter({ model: 'LongCat-2.5', harness: 'Standard', thinking: true, permissionMode: 'ask_when_needed', titleMode: 'local' }, p, 100));
    assert(!localTitle.includes('标题'), '本地推导不应显示标题段');
  });
}
