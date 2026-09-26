/**
 * 技能系统单测（util/agent/skills.mjs + skills/ 内置目录）：
 * frontmatter 解析、目录加载与覆盖、系统提示清单块、斜杠注入文本。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkillSource, loadSkills, skillCatalogBlock, skillInvocationText, findSkill, builtinSkillsDir } from '../util/agent/skills.mjs';

const VALID = `---\nname: demo\ndescription: 演示技能\n---\n\n# 正文\n按规范执行。\n`;

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

  await test('skills: parseSkillSource 拒绝非法输入', () => {
    eq(parseSkillSource('# 没有 frontmatter'), null);
    eq(parseSkillSource('---\ndescription: 缺 name\n---\n正文'), null, '缺 name');
    eq(parseSkillSource('---\nname: Bad_Name\ndescription: d\n---\n正文'), null, 'name 非法字符');
    eq(parseSkillSource('---\nname: ok\ndescription: \n---\n正文'), null, 'description 为空');
    eq(parseSkillSource('---\nname: ok\ndescription: d\n---\n'), null, '正文为空');
    eq(parseSkillSource(`---\nname: ok\ndescription: ${'x'.repeat(201)}\n---\n正文`), null, 'description 超长');
  });

  await test('skills: 内置目录加载出技能且字段完整', () => {
    const skills = loadSkills({ builtinDir: builtinSkillsDir() });
    assert(skills.length >= 3, `内置技能至少 3 个，实际 ${skills.length}`);
    for (const s of skills) {
      assert(s.name && s.description && s.body, `${s.name} 字段完整`);
      assert(s.body.length > 100, `${s.name} 正文有实质内容`);
    }
    const ops = findSkill(skills, 'AuroraAgent-Ops');
    assert(ops && ops.name === 'auroraagent-ops', 'findSkill 大小写不敏感');
    eq(findSkill(skills, 'nope'), null);
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

  await test('skills: skillCatalogBlock 只含名称与描述、不含正文', () => {
    const skills = [{ name: 'a', description: '甲', body: 'SECRET-BODY' }, { name: 'b', description: '乙', body: 'x' }];
    const block = skillCatalogBlock(skills);
    assert(block.includes('- a: 甲') && block.includes('- b: 乙'), '清单行');
    assert(!block.includes('SECRET-BODY'), '正文不进清单');
    eq(skillCatalogBlock([]), '', '无技能返回空');
  });

  await test('skills: skillInvocationText 包裹正文与用户请求', () => {
    const text = skillInvocationText({ name: 'demo', body: '指令内容' }, '审查这个文件');
    assert(text.includes('[技能：demo]') && text.includes('指令内容') && text.includes('[技能结束]'), '三段结构');
    assert(text.endsWith('审查这个文件'), '用户请求垫后');
    assert(skillInvocationText({ name: 'demo', body: 'b' }).includes('请按照上述技能的规范处理当前任务'), '无参数时的默认请求');
  });
}
