/**
 * 规则单元测试（util/agent/rules.mjs + util/agent/context.mjs 的注入接线）：
 * glob 子集语义、paths 条件激活四态、多源发现与同名覆盖、toggle、
 * token 预算降级，以及 assembleMessages 把激活规则拼进系统提示。
 * 数据隔离：全部用临时目录当工作区与数据目录，绝不碰真实数据目录。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRuleSource, globToRegExp, matchGlob, ruleActive, discoverRules,
  rulesBlock, collectCandidatePaths, parseRulesConfig, RULE_TOKEN_BUDGET,
} from '../util/agent/rules.mjs';
import { assembleMessages } from '../util/agent/context.mjs';
import { getHarness } from '../util/agent/harness.mjs';

function ws(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurora-rules-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  return dir;
}

export async function runRulesTests(test, assert, eq) {
  console.log('\n规则（用户指令层）单元测试');

  await test('rules: glob 子集——* 不跨目录、** 跨层、? / 字符类、目录后缀', () => {
    eq(matchGlob('*.ts', 'a.ts'), true, '基名模式任意深度命中');
    eq(matchGlob('*.ts', 'src/deep/a.ts'), true, '基名模式不锚定根');
    eq(matchGlob('src/*.ts', 'src/a.ts'), true, '单星不跨目录');
    eq(matchGlob('src/*.ts', 'src/deep/a.ts'), false, '单星不跨目录（否）');
    eq(matchGlob('**/*.ts', 'a.ts'), true, '** 匹配 0 层');
    eq(matchGlob('**/*.ts', 'src/deep/a.ts'), true, '** 匹配多层');
    eq(matchGlob('src/**/a.ts', 'src/a.ts'), true, 'src/**/a.ts 命中 src/a.ts');
    eq(matchGlob('src/**/a.ts', 'src/x/y/a.ts'), true, 'src/**/a.ts 命中深层');
    eq(matchGlob('src/**', 'src/a/b.ts'), true, 'src/** 覆盖其下全部');
    eq(matchGlob('a?.ts', 'ab.ts'), true, '问号匹配单字符');
    eq(matchGlob('a?.ts', 'abc.ts'), false, '问号只匹配一个字符');
    eq(matchGlob('[abc].ts', 'b.ts'), true, '字符类命中');
    eq(matchGlob('[!abc].ts', 'd.ts'), true, '否定字符类命中');
    eq(matchGlob('[!abc].ts', 'a.ts'), false, '否定字符类排除');
    eq(matchGlob('docs/', 'docs/readme.md'), true, '目录后缀覆盖其下');
    eq(matchGlob('docs/', 'src/a.ts'), false, '目录后缀不误伤别处');
    eq(matchGlob('/a.ts', 'a.ts'), true, '前导斜杠锚定根');
    eq(matchGlob('/a.ts', 'src/a.ts'), false, '锚定后不任意深度');
    eq(matchGlob('', 'a.ts'), false, '空模式不匹配');
    eq(matchGlob('a[.ts', 'a[.ts'), true, '未闭合字符类按字面量（不抛异常）');
    assert(globToRegExp('*.ts') instanceof RegExp, 'globToRegExp 返回正则');
  });

  await test('rules: paths 条件激活四态语义', () => {
    const omit = parseRuleSource('---\nname: a\ndescription: 恒生效\n---\n正文');
    eq(ruleActive(omit, { paths: [] }).active, true, '省略 paths = 恒生效');
    eq(ruleActive(omit, { paths: [] }).reason, '省略 paths，恒生效');
    const empty = parseRuleSource('---\nname: b\ndescription: 显式关闭\npaths: []\n---\n正文');
    eq(ruleActive(empty, { paths: ['src/a.ts'] }).active, false, '空数组 = 显式关闭');
    const scoped = parseRuleSource('---\nname: c\ndescription: 只管 ts\npaths: ["src/**/*.ts"]\n---\n正文');
    eq(ruleActive(scoped, { paths: [] }).active, false, '无候选路径 = 不激活');
    eq(ruleActive(scoped, { paths: ['src/a.ts'] }).active, true, '候选命中即激活');
    eq(ruleActive(scoped, { paths: ['README.md'] }).active, false, '候选未命中不激活');
    eq(ruleActive(scoped, { paths: ['src/a.ts', 'docs/x.md'] }).matched[0], 'src/**/*.ts', '回报命中的模式');
    const bad = parseRuleSource('---\nname: d\ndescription: 坏值\npaths: {a: 1}\n---\n正文');
    eq(ruleActive(bad, { paths: [] }).active, true, '类型非法 = fail-open 恒生效');
    const always = parseRuleSource('---\nname: e\ndescription: 强制\npaths: []\nalways: true\n---\n正文');
    eq(ruleActive(always, { paths: ['x'] }).active, true, 'always 压倒 paths');
    eq(ruleActive(null, {}).active, false, '空规则不激活');
  });

  await test('rules: frontmatter 解析与硬拒', () => {
    const r = parseRuleSource('---\nname: my-rule\ndescription: "一条规则"\npaths: ["a.ts", "b/*.md"]\n---\n\n第一行\n第二行');
    eq(r.name, 'my-rule');
    eq(r.description, '一条规则', '引号被剥离');
    eq(r.paths.length, 2, '数组字面量解析');
    eq(r.paths[1], 'b/*.md');
    eq(r.body, '第一行\n第二行');
    eq(r.pathsKind, 'array');
    const comma = parseRuleSource('---\nname: n\ndescription: d\npaths: a.ts, b.ts\n---\n正文');
    eq(comma.paths.length, 2, '逗号分隔也按数组');
    eq(parseRuleSource('没有 frontmatter'), null, '无 frontmatter 硬拒');
    eq(parseRuleSource('---\nname: x\n---\n正文'), null, '缺 description 硬拒');
    eq(parseRuleSource('---\nname: x\ndescription: d\n---\n'), null, '正文为空硬拒');
  });

  await test('rules: 多源发现、同名覆盖与 AGENTS.md 整篇宪法', () => {
    const workspace = ws({
      'AGENTS.md': '# 项目宪法\n\n只用 pnpm。',
      '.auroraagent/rules/ts.md': '---\nname: ts-style\ndescription: TS 规范\npaths: ["**/*.ts"]\n---\n严格模式',
      '.auroraagent/rules/broken.md': '没有 frontmatter 的坏文件',
    });
    const dataDir = mkdtempSync(join(tmpdir(), 'aurora-rules-data-'));
    mkdirSync(join(dataDir, 'rules'), { recursive: true });
    writeFileSync(join(dataDir, 'rules', 'personal.md'), '---\nname: personal\ndescription: 个人偏好\n---\n中文回复');
    writeFileSync(join(dataDir, 'rules', 'ts.md'), '---\nname: ts-style\ndescription: 个人版 TS 规范\n---\n个人版正文');
    try {
      const { rules, warnings } = discoverRules({ workspace, dataDir });
      const names = rules.map((r) => r.name);
      eq(names.includes('AGENTS.md'), true, '仓库根 AGENTS.md 作为宪法纳入');
      eq(names.includes('ts-style'), true, '项目规则纳入');
      eq(names.includes('personal'), true, '个人规则纳入');
      const ts = rules.find((r) => r.name === 'ts-style');
      eq(ts.source, 'workspace-rules', '项目规则覆盖个人同名规则');
      eq(ts.body, '严格模式');
      const agents = rules.find((r) => r.name === 'AGENTS.md');
      eq(agents.always, true, '无 frontmatter 的 AGENTS.md 恒生效');
      assert(agents.body.includes('只用 pnpm'), '整篇纳入');
      assert(warnings.some((w) => w.includes('broken.md')), '坏文件给告警不阻断');
      // 稳定排序：两次发现顺序一致（字节稳定）
      eq(discoverRules({ workspace, dataDir }).rules.map((r) => r.name).join(','), names.join(','), '输出顺序稳定');
      // 目录不存在 = 空，不算错
      const none = discoverRules({ workspace: join(workspace, 'nope'), dataDir: join(dataDir, 'nope') });
      eq(none.rules.length, 0, '目录缺失按空处理');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  await test('rules: token 预算降级与 toggle', () => {
    const fat = { name: 'fat', description: '大规则', body: '规'.repeat(4000), source: 'data', path: '/x', pathsKind: 'omitted', always: true };
    const thin = { name: 'thin', description: '小规则', body: '短', source: 'data', path: '/y', pathsKind: 'omitted', always: true };
    const full = rulesBlock([fat, thin], { budget: RULE_TOKEN_BUDGET });
    assert(full.block.includes('### fat'), '预算内规则给全文');
    const starved = rulesBlock([fat], { budget: 10 });
    assert(starved.block.includes('### fat'), '超预算仍保留标识行');
    assert(!starved.block.includes('规'.repeat(4000)), '超预算不给全文');
    eq(starved.degraded.length, 1, '记为降级');
    eq(rulesBlock([], {}).block, '', '无规则给空块');
    eq(rulesBlock([fat], { toggles: { fat: false } }).block, '', 'toggle 关掉的规则不注入');
    assert(rulesBlock([fat], { toggles: { thin: false } }).block.includes('### fat'), '别人的 toggle 不影响自己');
    // 条件不激活的规则不进块
    const scoped = { name: 'scoped', description: 'd', body: 'b', source: 'data', path: '/z', pathsKind: 'array', paths: ['**/*.ts'], always: false };
    eq(rulesBlock([scoped], { paths: ['README.md'] }).block, '', '未命中路径的规则不注入');
    assert(rulesBlock([scoped], { paths: ['src/a.ts'] }).block.includes('### scoped'), '命中后注入');
  });

  await test('rules: 候选路径提取（剥代码围栏与 URL，含工具证据）', () => {
    const got = collectCandidatePaths({
      input: '看下 src/foo.ts 和 README.md，别动 docs/\n```js\nconst x = "a/b/c";\n```\n链接 https://x.test/a/b',
      records: [{ t: 'tool_call', name: 'read_file', args: { path: 'pkg/util.mjs' } }],
    });
    assert(got.includes('src/foo.ts'), '正文里的路径');
    assert(got.includes('README.md'), '带后缀的文件名');
    assert(got.includes('docs/'), '目录形态');
    assert(got.includes('pkg/util.mjs'), '工具真正碰过的路径（硬证据）');
    assert(!got.includes('a/b/c'), '代码围栏里的内容不当路径');
    assert(!got.some((p) => p.includes('x.test')), 'URL 不当路径');
    eq(collectCandidatePaths({}).length, 0, '空输入给空候选');
    // 带 glob 字符的 pattern 不是具体文件，不作为候选
    eq(collectCandidatePaths({ records: [{ t: 'tool_call', name: 'grep', args: { pattern: '**/*.ts' } }] }).length, 0, '检索模式不当候选路径');
  });

  await test('rules: parseRulesConfig 单叶容错', () => {
    eq(parseRulesConfig(undefined).toggles.a, undefined, '缺省空表');
    eq(parseRulesConfig({ rules: null }).toggles.a, undefined, '坏段按空表');
    eq(parseRulesConfig({ rules: { a: false, b: true, c: 'x' } }).toggles.c, undefined, '非布尔值忽略');
    eq(parseRulesConfig({ rules: { a: false } }).toggles.a, false, '布尔值保留');
  });

  await test('rules: assembleMessages 把激活规则拼进系统提示', () => {
    const on = { name: 'on-rule', description: '生效中', body: '必须写测试', source: 'data', path: '/x', pathsKind: 'omitted', always: true };
    const off = { name: 'off-rule', description: '已关闭', body: '不该出现', source: 'data', path: '/y', pathsKind: 'omitted', always: true };
    const scoped = { name: 'scoped', description: '只管 ts', body: 'ts 专属规范', source: 'data', path: '/z', pathsKind: 'array', paths: ['**/*.ts'], always: false };
    const base = { harness: getHarness('standard'), workspace: '/tmp/ws', records: [] };
    const msgs = assembleMessages({ ...base, rules: [on, off, scoped], ruleToggles: { 'off-rule': false }, rulePaths: ['README.md'] });
    assert(msgs[0].content.includes('【项目规则】'), '有激活规则时出现规则块');
    assert(msgs[0].content.includes('必须写测试'), '激活规则全文进系统提示');
    assert(!msgs[0].content.includes('不该出现'), 'toggle 关掉的不进');
    assert(!msgs[0].content.includes('ts 专属规范'), '路径未命中不进');
    const hit = assembleMessages({ ...base, rules: [scoped], rulePaths: ['src/a.ts'] });
    assert(hit[0].content.includes('ts 专属规范'), '路径命中后进');
    const none = assembleMessages(base);
    assert(!none[0].content.includes('【项目规则】'), '无规则不出现规则块');
  });
}
