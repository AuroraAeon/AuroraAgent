/**
 * 会话标题自动总结单测（util/agent/title.mjs）：
 * 首行提取、markdown 噪声剥离、技能注入取用户原话、斜杠命令取参数、
 * emoji / 控制符清洗、CJK 宽度截断、无可提炼内容时返回空串（保留默认名）。
 */
import { deriveTitle, TITLE_MAX_WIDTH } from '../util/agent/title.mjs';
import { displayWidth } from '../util/tui/render.mjs';

export async function runTitleTests(test, assert, eq) {
  console.log('\n会话标题自动总结单测');

  await test('title: 短消息原样成题，不补省略号', () => {
    eq(deriveTitle('修复登录页的 401 报错'), '修复登录页的 401 报错');
    eq(deriveTitle(' 你好 '), '你好');
  });

  await test('title: 只取第一行并压缩连续空白', () => {
    eq(deriveTitle('  帮我  看看   启动日志\n第二行不该出现\n第三行'), '帮我 看看 启动日志');
  });

  await test('title: 剥离行首 markdown 噪声与强调壳', () => {
    eq(deriveTitle('## 小标题'), '小标题');
    eq(deriveTitle('> 引用一句'), '引用一句');
    eq(deriveTitle('- 列表项'), '列表项');
    eq(deriveTitle('1. 有序项'), '有序项');
    eq(deriveTitle('**加粗的标题**'), '加粗的标题');
  });

  await test('title: 代码围栏开头的消息跳过围栏行', () => {
    eq(deriveTitle('```python\ndef f(): pass'), 'def f(): pass');
  });

  await test('title: 技能注入文本取用户原话', () => {
    eq(deriveTitle('[技能：code-review]\n按规范审查代码\n[技能结束]\n\n看看这段代码'), '看看这段代码');
  });

  await test('title: 斜杠命令取参数，路径形态不误伤', () => {
    eq(deriveTitle('/code-review 看看这段代码'), '看看这段代码');
    eq(deriveTitle('/plan'), '/plan');
    eq(deriveTitle('/usr/local/bin 路径怎么配'), '/usr/local/bin 路径怎么…');
  });

  await test('title: 清洗 emoji 与控制符（产品内零 emoji）', () => {
    eq(deriveTitle('\u{1F389} 庆祝一下发布'), '庆祝一下发布');
    eq(deriveTitle('标题带\u{FE0F}变体选择符'), '标题带变体选择符');
    eq(deriveTitle('a\x1b[31mb\x07c'), 'ab c');
    eq(deriveTitle('\u{1F600}\u{1F600}'), '', '只剩 emoji 视为无内容');
  });

  await test('title: 纯标点与空输入返回空串（保留默认名）', () => {
    eq(deriveTitle(''), '');
    eq(deriveTitle('   \n\n  '), '');
    eq(deriveTitle('。。。'), '');
    eq(deriveTitle('---'), '');
    eq(deriveTitle(null), '');
  });

  await test('title: 兼容模型输出形态——剥引号壳 / 标题前缀 / 结尾句读', () => {
    eq(deriveTitle('「修复登录页的 401 报错」'), '修复登录页的 401 报错', '中文引号壳应剥掉');
    eq(deriveTitle('"修复登录 401"'), '修复登录 401', '英文引号壳应剥掉');
    eq(deriveTitle('标题：修复登录问题'), '修复登录问题', '标题前缀应剥掉');
    eq(deriveTitle('Title: fix login 401'), 'fix login 401', '英文标题前缀应剥掉');
    eq(deriveTitle('帮我把 README 的安装章节改写一下。'), '帮我把 README 的安装章…', '结尾句读应剥掉');
    eq(deriveTitle('怎么做？'), '怎么做', '问号结尾应剥掉');
    eq(deriveTitle('**加粗的标题**。'), '加粗的标题', '强调壳与句读应先后剥净');
  });

  await test('title: 按显示宽度截断，CJK 记 2 列', () => {
    eq(TITLE_MAX_WIDTH, 24);
    eq(deriveTitle('帮我把 README 的安装章节改写一下'), '帮我把 README 的安装章…');
    eq(deriveTitle('How do I fix the EADDRINUSE retry loop in web.mjs on macOS?'), 'How do I fix the EADDRI…');
    const long = deriveTitle('这是一个很长的中文标题需要被截断处理'.repeat(3));
    assert(long.endsWith('…'), '超长应补省略号');
    assert(displayWidth(long) <= TITLE_MAX_WIDTH, `标题宽度应不超 ${TITLE_MAX_WIDTH} 列，实际 ${displayWidth(long)}`);
    eq(deriveTitle('一二三四五六七八', { maxWidth: 6 }), '一二…', 'maxWidth 可覆盖');
  });
}
