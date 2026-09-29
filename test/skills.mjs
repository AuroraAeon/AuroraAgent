/**
 * 技能系统单测（util/agent/skills.mjs + skills/ 内置目录）：
 * frontmatter 解析（含规范新字段与宽松校验）、目录加载与覆盖、附属资源索引、
 * L1 目录预算与 implicit 过滤、L2 结构化激活包裹、只读白名单根 skillDirs。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSkillSource, loadSkills, skillCatalogBlock, skillInvocationText, findSkill,
  builtinSkillsDir, renderSkillContent, skillDirs, SKILL_FOLLOWUP,
} from '../util/agent/skills.mjs';
import { normalizeSkillRows } from '../web-ui/src/skill-rows.mjs';
import { resolveInside, ToolError } from '../util/agent/tools.mjs';

const VALID = `---\nname: demo\ndescription: 演示技能\n---\n\n# 正文\n按规范执行。\n`;

/** 构造一个最小可用技能对象（skillCatalogBlock / renderSkillContent 的入参） */
const mkSkill = (over = {}) => ({
  name: 'demo', description: '演示', body: '正文', source: 'user', path: '', dir: '',
  license: '', compatibility: '', metadata: {}, allowedTools: [], implicit: true,
  bodyLines: 1, files: [], warnings: [], ...over,
});

export async function runSkillsTests(test, assert, eq) {
  console.log('\n技能系统单测');

  await test('skills: parseSkillSource 解析 frontmatter 与正文', () => {
    const s = parseSkillSource(VALID, { source: 'user', path: '/x/SKILL.md' });
    eq(s.name, 'demo');
    eq(s.description, '演示技能');
    assert(s.body.includes('按规范执行'), '正文提取');
    assert(!s.body.includes('---'), '正文不含分隔线');
    eq(s.source, 'user');
    eq(parseSkillSource(VALID.replace(/\r\n/g, '\r\n')).name, 'demo', 'CRLF 容错');
    eq(parseSkillSource('---\nname: "q"\ndescription: \'带引号\'\n---\n正文').description, '带引号', '引号剥离');
  });

  await test('skills: parseSkillSource 解析规范新增 frontmatter 字段', () => {
    const s = parseSkillSource([
      '---',
      'name: demo',
      'description: 演示',
      'license: Apache-2.0',
      'compatibility: Requires Node 18+',
      'metadata:',
      '  author: example-org',
      '  version: "1.0"',
      'allowed-tools: Bash(git:*) Read read_file',
      'implicit: false',
      '---',
      '正文',
    ].join('\n'), { source: 'user', path: '/x/demo/SKILL.md' });
    eq(s.license, 'Apache-2.0', 'license');
    eq(s.compatibility, 'Requires Node 18+', 'compatibility');
    eq(s.metadata.author, 'example-org', 'metadata 缩进行');
    eq(s.metadata.version, '1.0', 'metadata 引号剥离');
    eq(s.allowedTools.join(' '), 'shell read_file', 'allowed-tools 归一（括号作用域丢弃、别名映射、去重）');
    eq(s.implicit, false, 'implicit: false');
    eq(parseSkillSource('---\nname: d\ndescription: x\nimplicit: no\n---\n正文').implicit, false, 'implicit: no 同义');
    eq(parseSkillSource('---\nname: d\ndescription: x\n---\n正文').implicit, true, '缺省允许隐式调用');
  });

  await test('skills: parseSkillSource 拒绝非法输入', () => {
    eq(parseSkillSource('# 没有 frontmatter'), null);
    eq(parseSkillSource('---\ndescription: 缺 name\n---\n正文'), null, '缺 name');
    eq(parseSkillSource('---\nname: Bad_Name\ndescription: d\n---\n正文'), null, 'name 非法字符');
    eq(parseSkillSource('---\nname: ok\ndescription: \n---\n正文'), null, 'description 为空');
    eq(parseSkillSource('---\nname: ok\ndescription: d\n---\n'), null, '正文为空');
    eq(parseSkillSource(`---\nname: ${'x'.repeat(65)}\ndescription: d\n---\n正文`), null, 'name 超 64 字符');
  });

  await test('skills: 宽松校验——超限与命名不一致只告警不拒载', () => {
    const long = parseSkillSource(`---\nname: ok\ndescription: ${'x'.repeat(1024)}\n---\n正文`, { path: '/x/ok/SKILL.md' });
    eq(long.name, 'ok', 'description 达上限仍加载');
    eq(long.warnings.length, 0, '恰好 1024 不告警');
    const over = parseSkillSource(`---\nname: ok\ndescription: ${'x'.repeat(1025)}\n---\n正文`, { path: '/x/ok/SKILL.md' });
    eq(over.name, 'ok', 'description 超上限仍加载');
    assert(over.warnings.some((w) => w.includes('description')), 'description 超长告警');
    const fat = parseSkillSource(`---\nname: ok\ndescription: d\n---\n${Array.from({ length: 501 }, () => 'line').join('\n')}`, { path: '/x/ok/SKILL.md' });
    eq(fat.bodyLines, 501, '正文行数如实记录');
    assert(fat.warnings.some((w) => w.includes('正文')), '正文超 500 行告警');
    const mismatch = parseSkillSource('---\nname: right\ndescription: d\n---\n正文', { path: '/x/wrongdir/SKILL.md' });
    assert(mismatch.warnings.some((w) => w.includes('父目录名')), 'name 与目录不一致告警');
  });

  await test('skills: 内置目录加载出技能且字段完整', () => {
    const skills = loadSkills({ builtinDir: builtinSkillsDir() });
    assert(skills.length >= 3, `内置技能至少 3 个，实际 ${skills.length}`);
    for (const s of skills) {
      assert(s.name && s.description && s.body, `${s.name} 字段完整`);
      assert(s.body.length > 100, `${s.name} 正文有实质内容`);
      assert(s.description.length <= 1024, `${s.name} 描述未超规范上限`);
      assert(Array.isArray(s.files) && Array.isArray(s.warnings), `${s.name} 资源索引与告警在位`);
    }
    const ops = findSkill(skills, 'AuroraAgent-Ops');
    assert(ops && ops.name === 'auroraagent-ops', 'findSkill 大小写不敏感');
    eq(findSkill(skills, 'nope'), null);
  });

  await test('skills: 内置技能含 references 附属资源（dogfood 三层结构）', () => {
    const skills = loadSkills({ builtinDir: builtinSkillsDir() });
    const ops = findSkill(skills, 'auroraagent-ops');
    const opsPaths = ops.files.map((f) => f.path);
    assert(opsPaths.includes('references/data-dir.md'), 'auroraagent-ops 拆出 data-dir.md');
    assert(opsPaths.includes('references/commands.md'), 'auroraagent-ops 拆出 commands.md');
    assert(opsPaths.includes('references/release.md'), 'auroraagent-ops 拆出 release.md');
    const tw = findSkill(skills, 'test-writing');
    assert(tw.files.map((f) => f.path).includes('references/e2e-conventions.md'), 'test-writing 拆出 e2e-conventions.md');
    assert(!opsPaths.includes('SKILL.md'), 'SKILL.md 自身不算附属资源');
    assert(ops.bodyLines <= 500, 'SKILL.md 正文未超建议行数');
  });

  await test('skills: 用户目录覆盖内置并追加新技能，坏文件跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-skills-'));
    try {
      mkdirSync(join(dir, 'demo'), { recursive: true });
      writeFileSync(join(dir, 'demo', 'SKILL.md'), VALID);
      mkdirSync(join(dir, 'broken'), { recursive: true });
      writeFileSync(join(dir, 'broken', 'SKILL.md'), '坏文件');
      writeFileSync(join(dir, 'stray.txt'), '不是目录直接忽略');
      const builtin = mkdtempSync(join(tmpdir(), 'aurora-builtin-'));
      try {
        mkdirSync(join(builtin, 'demo'), { recursive: true });
        writeFileSync(join(builtin, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: 内置版\n---\n内置正文');
        const skills = loadSkills({ builtinDir: builtin, userDir: dir });
        eq(skills.length, 1, '坏技能被跳过');
        eq(skills[0].source, 'user', '用户目录覆盖内置');
        assert(skills[0].body.includes('按规范执行'), '覆盖后取用户正文');
      } finally { rmSync(builtin, { recursive: true, force: true }); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await test('skills: 附属资源索引——相对路径、跳噪音目录、SKILL.md 除外', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-res-'));
    try {
      mkdirSync(join(dir, 'demo', 'references'), { recursive: true });
      mkdirSync(join(dir, 'demo', 'scripts'), { recursive: true });
      mkdirSync(join(dir, 'demo', 'node_modules', 'pkg'), { recursive: true });
      mkdirSync(join(dir, 'demo', '.git'), { recursive: true });
      writeFileSync(join(dir, 'demo', 'SKILL.md'), VALID);
      writeFileSync(join(dir, 'demo', 'references', 'a.md'), 'a');
      writeFileSync(join(dir, 'demo', 'scripts', 'run.mjs'), 'b');
      writeFileSync(join(dir, 'demo', 'node_modules', 'pkg', 'index.js'), 'c');
      writeFileSync(join(dir, 'demo', '.git', 'HEAD'), 'd');
      const [skill] = loadSkills({ builtinDir: dir });
      eq(skill.files.map((f) => f.path).sort().join(','), 'references/a.md,scripts/run.mjs', '只索引真实附属文件');
      assert(skill.files.every((f) => f.bytes > 0), '记录字节数');
      eq(skillDirs([skill, skill]).length, 1, 'skillDirs 去重');
      eq(skillDirs([]).join(','), '', '无技能返回空');
      eq(skillDirs([{ path: '/a/b/SKILL.md' }]).join(','), '/a/b', '无 dir 字段时从 path 推导');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await test('skills: skillCatalogBlock 只含名称与描述、不含正文', () => {
    const skills = [mkSkill({ name: 'a', description: '甲', body: 'SECRET-BODY' }), mkSkill({ name: 'b', description: '乙', body: 'x' })];
    const block = skillCatalogBlock(skills);
    assert(block.includes('- a: 甲') && block.includes('- b: 乙'), '清单行');
    assert(!block.includes('SECRET-BODY'), '正文不进清单');
    eq(skillCatalogBlock([]), '', '无技能返回空');
  });

  await test('skills: skillCatalogBlock 剔除 implicit:false 的技能', () => {
    const skills = [mkSkill({ name: 'shown', description: '可见' }), mkSkill({ name: 'hidden', description: '隐身', implicit: false })];
    const block = skillCatalogBlock(skills);
    assert(block.includes('- shown: 可见'), '隐式可调用技能在目录里');
    assert(!block.includes('- hidden:'), '仅显式调用的技能不进模型目录');
  });

  await test('skills: skillCatalogBlock 受 token 预算约束，超出只留显式入口', () => {
    const many = Array.from({ length: 30 }, (_, i) => mkSkill({ name: `s${String(i).padStart(2, '0')}`, description: 'd'.repeat(200) }));
    const block = skillCatalogBlock(many, { budgetTokens: 200 });
    const listed = block.split('\n').filter((l) => l.startsWith('- ')).length;
    assert(listed >= 1 && listed < 30, `只列入部分技能：${listed}`);
    assert(block.includes('另有 ') && block.includes('显式调用'), '超预算技能给出 /<名称> 入口提示');
    assert(block.includes('- s00:'), '预算内至少保留一个技能');
    eq(skillCatalogBlock(many, { budgetTokens: 1 }).split('\n').filter((l) => l.startsWith('- ')).length, 1, '预算极小也保留一个');
  });

  await test('skills: renderSkillContent 给出绝对目录与附属资源清单', () => {
    const skill = mkSkill({
      name: 'demo', dir: '/abs/skills/demo', compatibility: 'Requires Node 18+',
      allowedTools: ['shell'], body: '指令内容',
      files: [{ path: 'references/a.md', bytes: 2048 }, { path: 'scripts/run.mjs', bytes: 512 }],
    });
    const out = renderSkillContent(skill);
    assert(out.startsWith('<skill_content name="demo">'), '结构化开头');
    assert(out.endsWith('</skill_content>'), '结构化结尾');
    assert(out.includes('<compatibility>Requires Node 18+</compatibility>'), '环境要求');
    assert(out.includes('<allowed_tools>shell</allowed_tools>'), '放行工具');
    assert(out.includes('指令内容'), '正文');
    assert(out.includes('Skill directory: /abs/skills/demo'), '绝对目录');
    assert(out.includes('<file>references/a.md（2.0 KB）</file>'), '资源清单含体积');
    assert(out.includes('<file>scripts/run.mjs（512 B）</file>'), '小文件按字节显示');
    const bare = renderSkillContent(mkSkill());
    assert(!bare.includes('<compatibility>') && !bare.includes('<allowed_tools>') && !bare.includes('<skill_resources>'), '缺省字段不出现空标记');
  });

  await test('skills: skillInvocationText 包裹正文与用户请求', () => {
    const text = skillInvocationText(mkSkill({ name: 'demo', dir: '/abs/demo', body: '指令内容' }), '审查这个文件');
    assert(text.includes('<skill_content name="demo">') && text.includes('指令内容') && text.includes('</skill_content>'), '三段结构');
    assert(text.includes('Skill directory: /abs/demo'), '带出技能绝对目录');
    assert(text.endsWith('审查这个文件'), '用户请求垫后');
    assert(skillInvocationText(mkSkill()).includes('请按照上述技能的规范处理当前任务'), '无参数时的默认请求');
    eq(SKILL_FOLLOWUP, '请按照上述技能规范处理用户请求。');
  });

  await test('skills: resolveInside 放开已加载技能目录为只读白名单根', () => {
    const ws = mkdtempSync(join(tmpdir(), 'aurora-ws-'));
    const sd = mkdtempSync(join(tmpdir(), 'aurora-skill-'));
    try {
      eq(resolveInside(ws, 'a/b.txt'), join(ws, 'a/b.txt'), '工作目录内放行');
      const skillFile = join(sd, 'references', 'a.md');
      eq(resolveInside(ws, skillFile, [sd]), skillFile, '白名单根内放行（绝对路径）');
      eq(resolveInside(ws, join(sd, 'x.md'), [sd]), join(sd, 'x.md'), '白名单根本身放行');
      const rejects = (fn, msg) => {
        try { fn(); assert(false, `${msg}（未抛错）`); } catch (e) { assert(e instanceof ToolError, `${msg}：${e.message}`); }
      };
      rejects(() => resolveInside(ws, '../escape.txt', [sd]), '穿越仍被拒');
      rejects(() => resolveInside(ws, join(sd, '..', 'escape'), [sd]), '白名单根外侧仍被拒');
      try { resolveInside(ws, '../escape.txt', [sd]); } catch (e) { eq(e.code, 'path_escape', '沿用既有错误码'); }
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(sd, { recursive: true, force: true });
    }
  });

  await test('skills: normalizeSkillRows 把旧版响应当规整为完整行（防设置页白屏）', () => {
    // a4be825 之前的旧形状：目录口只回 name/description/source——集合字段全缺
    const rows = normalizeSkillRows([{ name: 'demo', description: '演示', source: 'user' }]);
    eq(rows.length, 1, '行数保留');
    eq(rows[0].name, 'demo', '既有字段原样');
    eq(rows[0].resources.length, 0, '缺 resources 回退空数组（不再 .length 白屏）');
    eq(rows[0].allowedTools.length, 0, '缺 allowedTools 回退空数组');
    eq(rows[0].warnings.length, 0, '缺 warnings 回退空数组');
    eq(rows[0].implicit, true, '缺 implicit 回退 true（未声明即允许隐式调用）');
    eq(rows[0].bodyLines, 0, '缺 bodyLines 回退 0');
    eq(rows[0].compatibility, '', '缺 compatibility 回退空串');
    // 畸形值：类型不对、混入非字符串元素、非对象行
    const weird = normalizeSkillRows([
      { name: 'a', description: 5, source: null, resources: 'references/x.md', allowedTools: [1, 'read', null], warnings: 3, implicit: 'no', bodyLines: -2 },
      null, 'nope', 42,
    ]);
    eq(weird.length, 1, '非对象行剔除');
    eq(weird[0].resources.length, 0, '非数组 resources 回退空数组');
    eq(weird[0].allowedTools.join(' '), 'read', '字符串数组成员过滤');
    eq(weird[0].warnings.length, 0, '非数组 warnings 回退空数组');
    eq(weird[0].implicit, true, '非布尔 implicit 回退默认值');
    eq(weird[0].bodyLines, 0, '负数 bodyLines 钳为 0');
    eq(weird[0].description, '', '非字符串 description 回退空串');
    eq(weird[0].source, '', '非字符串 source 回退空串');
    eq(normalizeSkillRows(undefined).length, 0, '非数组输入回退空列表');
    eq(normalizeSkillRows({ skills: [] }).length, 0, '对象输入回退空列表');
    // 完整形状原样通过（不缺字段时不加工）
    const full = normalizeSkillRows([{ name: 'demo', description: '演示', source: 'builtin', resources: ['references/a.md'], implicit: false, compatibility: 'Node 18+', allowedTools: ['shell'], bodyLines: 33, warnings: ['description 超长'] }]);
    eq(full[0].resources.join(','), 'references/a.md', 'resources 保留');
    eq(full[0].allowedTools.join(','), 'shell', 'allowedTools 保留');
    eq(full[0].implicit, false, '显式 false 保留');
    eq(full[0].bodyLines, 33, 'bodyLines 保留');
    eq(full[0].warnings.join(','), 'description 超长', 'warnings 保留');
  });
}
