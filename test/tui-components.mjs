/**
 * TUI 组件渲染单测（util/tui/{commands,select,footer}.mjs）：纯函数，断言语义与布局。
 */
import { parseCommand, defineCommands, commandHelpLines } from '../util/tui/commands.mjs';
import { renderSelect } from '../util/tui/select.mjs';
import { renderFooter } from '../util/tui/footer.mjs';
import { buildTerminalTitle, oscTitle, clearTitle } from '../util/tui/title.mjs';
import { createNotifier, writeNotification, NOTIFICATION_EVENTS } from '../util/tui/notify.mjs';
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

  await test('notify: 三通道序列形状与 when/events 门控', async () => {
    eq(writeNotification('osc9', { title: 'T', body: 'B' }), '\x1b]9;B\x07', 'OSC 9 只带正文');
    eq(writeNotification('osc777', { title: 'T', body: 'B' }), '\x1b]777;notify;T;B\x07', 'OSC 777 带标题与正文');
    eq(writeNotification('bel', { title: 'T', body: 'B' }), '\x07', 'bel 只响铃');
    assert(!writeNotification('osc9', { body: '坏\x1b]9;x\x07注入' }).includes('\x1b]9;x'), '通知正文同样防序列注入');
    // never：一律不通知
    const never = createNotifier({ notifications: { when: 'never', method: 'auto', events: NOTIFICATION_EVENTS.slice() } });
    eq(await never.notify('turn-complete', { body: 'x' }), undefined);
    // always：不探测焦点直接发
    const always = createNotifier({ notifications: { when: 'always', method: 'osc9', events: ['turn-complete'] }, probe: async () => false });
    eq(await always.notify('turn-complete', { body: 'x' }), '\x1b]9;x\x07');
    eq(await always.notify('turn-failed', { body: 'x' }), undefined, '未配置的事件不通知');
    // unfocused + 聚焦：不打扰；未聚焦：通知
    const seen = createNotifier({ notifications: { when: 'unfocused', method: 'osc9', events: ['turn-failed'] }, probe: async () => true });
    eq(await seen.notify('turn-failed', { body: 'x' }), undefined, '终端正看着时不通知');
    const away = createNotifier({ notifications: { when: 'unfocused', method: 'osc9', events: ['turn-failed'] }, probe: async () => false });
    eq(await away.notify('turn-failed', { body: 'x' }), '\x1b]9;x\x07');
    eq(NOTIFICATION_EVENTS.join(','), 'turn-complete,turn-failed,permission-required,question-required');
  });

  await test('title: buildTerminalTitle 项序拼装、空项序关闭与序列净化', () => {
    eq(buildTerminalTitle(['state', 'session', 'app'], { state: '生成中', session: '新会话', app: 'AuroraAgent' }), '生成中 | 新会话 | AuroraAgent');
    eq(buildTerminalTitle(['session', 'state'], { state: '就绪', session: '测试' }), '测试 | 就绪', '应按配置项序而非传入序');
    eq(buildTerminalTitle([], { state: '就绪', session: 'x', app: 'y' }), null, '空项序 = 关闭');
    eq(buildTerminalTitle(['state', 'session'], { state: '', session: '' }), null, '全空段不产生标题');
    eq(buildTerminalTitle(['app'], { app: 'AuroraAgent' }), 'AuroraAgent', '缺省段被跳过');
    // 会话名里的 ESC / BEL / 换行必须被剥掉，防止注入终端序列
    const evil = oscTitle(buildTerminalTitle(['session'], { session: '坏\x1b]0;pwned\x07名' }));
    assert(!evil.includes('pwned') || evil.indexOf('pwned') > evil.indexOf('\x1b]0;') + 3, '注入序列不得形成第二个 OSC');
    eq(evil.startsWith('\x1b]0;'), true, '应以 OSC 0 开头');
    eq(evil.endsWith('\x07'), true, '应以 BEL 收尾');
    eq(clearTitle(), '\x1b]0;\x07', '清空序列');
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
    const goal = strip(renderFooter({ model: 'LongCat-2.5', harness: 'Standard', thinking: true, permissionMode: 'ask_when_needed', goal: '13K / 5K · 2min30s' }, p, 100));
    assert(goal.includes('目标') && goal.includes('13K / 5K · 2min30s'), '有进行中目标时应显示目标段');
    const noGoal = strip(renderFooter({ model: 'LongCat-2.5', harness: 'Standard', thinking: true, permissionMode: 'ask_when_needed' }, p, 100));
    assert(!noGoal.includes('目标'), '无目标时不应显示目标段');
  });
}
