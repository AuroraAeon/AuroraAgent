/**
 * 语法高亮器单元测试（web-ui/src/highlight.ts 的 Node 侧直接 import）：
 * 无损性（拼接恒等）、关键字 / 字符串 / 注释 / 数字 / 函数分类、未知语言回退纯文本。
 */
import { highlightCode } from '../web-ui/src/highlight.ts';

export async function runHighlightTests(test, assert, eq) {
  console.log('\n语法高亮器单元测试');

  const lossless = (code, lang) => {
    const toks = highlightCode(code, lang);
    eq(toks.map((t) => t.text).join(''), code, `无损拼接失败: ${lang}`);
    return toks;
  };
  const clsOf = (toks, text) => toks.find((t) => t.text === text)?.cls;

  await test('highlight: 拼接无损（多语言样本）', () => {
    lossless('const a = "x"; // 注释\nfunction f() { return 1 + 2; }', 'js');
    lossless("# python\ndef f(x):\n    return x * 2  # 注释", 'python');
    lossless('{"a": 1, "b": [true, null]}', 'json');
    lossless("if [ -f x ]; then echo hi; fi", 'bash');
    lossless('SELECT * FROM t WHERE id = 1;', 'sql');
    lossless('', 'js');
    lossless('no lang fence', '');
  });

  await test('highlight: JS 关键字 / 字符串 / 注释 / 函数分类', () => {
    const toks = lossless('// lead\nconst s = "hi";\nfn(1);', 'js');
    eq(clsOf(toks, 'const'), 'c-key', 'const 应为关键字');
    eq(clsOf(toks, '// lead'), 'c-com', '行注释应整体成块');
    eq(clsOf(toks, '"hi"'), 'c-str', '字符串应识别');
    eq(clsOf(toks, 'fn'), 'c-fn', '调用名应为函数');
    eq(clsOf(toks, '1'), 'c-num', '数字应识别');
  });

  await test('highlight: 块注释与模板串不跨行断裂', () => {
    const toks = lossless('/* a\nb */ const x = `t${1}u`;', 'ts');
    eq(clsOf(toks, '/* a\nb */'), 'c-com', '块注释应整段');
    eq(clsOf(toks, '`t${1}u`'), 'c-str', '模板串应整体');
  });

  await test('highlight: Python 井号注释与 SQL 关键字', () => {
    const py = lossless('x = 1  # note\ndef g(): pass', 'python');
    eq(clsOf(py, '# note'), 'c-com');
    eq(clsOf(py, 'def'), 'c-key');
    const sql = lossless('select 1 from t', 'sql');
    eq(clsOf(sql, 'select'), 'c-key', 'SQL 关键字应大小写不敏感');
  });

  await test('highlight: 未知语言回退单 token 纯文本', () => {
    const toks = highlightCode('whatever here', 'brainfuck');
    eq(toks.length, 1);
    eq(toks[0].cls, '');
    eq(toks[0].text, 'whatever here');
  });

  await test('highlight: 字符串内含关键字不被误判', () => {
    const toks = lossless('const s = "const return";', 'js');
    eq(clsOf(toks, '"const return"'), 'c-str', '字符串内容应整体归字符串');
    assert(!toks.some((t) => t.cls === 'c-key' && t.text === 'return'), '字符串里的 return 不应算关键字');
  });
}
