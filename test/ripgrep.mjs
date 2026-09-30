/**
 * ripgrep 层单测（util/ripgrep.mjs + tools.mjs 的 grep / glob 两条路径）。
 * 关注点不是「rg 好不好用」，而是三条不变式：
 *   1. 解析顺序固定：捆绑二进制 → PATH → null（回退）；
 *   2. rg 路径与纯 JS 路径对同一问题的答案一致（装没装 rg 只影响快慢）；
 *   3. rg 不可用 / 自己报错时干净回退，不把错误暴露给模型。
 * 数据隔离：全部用临时目录当仓库，绝不碰真实数据目录。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  findRipgrep, resetRipgrepCache, bundledRipgrepPath, excludeGlobs, ripgrepStatus, runRipgrep,
} from '../util/ripgrep.mjs';
import { getTool } from '../util/agent/tools.mjs';

function ws(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurora-rg-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  return dir;
}

export async function runRipgrepTests(test, assert, eq) {
  console.log('\nripgrep 检索层单测');

  await test('rg: 解析顺序与状态自洽', () => {
    resetRipgrepCache();
    const bundled = bundledRipgrepPath();
    const found = findRipgrep();
    if (bundled) eq(found, bundled, '有捆绑二进制时优先用它（不依赖 PATH）');
    else assert(found === 'rg' || found === null, '没有捆绑二进制时退回 PATH 或 null');
    const status = ripgrepStatus();
    eq(status.available, Boolean(found), 'available 与解析结果一致');
    eq(status.bundled, Boolean(bundled), 'bundled 标记与磁盘事实一致');
    eq(excludeGlobs(['.git', 'node_modules']).length, 4, '每个目录给两个排除模式');
    assert(excludeGlobs(['.git']).every((g) => g.startsWith('!')), '排除模式一律取反');
    eq(excludeGlobs([]).length, 0, '空名单给空参数');
    eq(excludeGlobs([null, '  ']).length, 0, '空目录名跳过');
  });

  await test('rg: 二进制缺失时干净回退（不抛错、不返回半截结果）', () => {
    resetRipgrepCache();
    const dir = ws({ 'a.txt': 'x' });
    // 用一个必然不存在的可执行名顶掉解析结果：runRipgrep 的 spawn 失败必须走 null 分支
    const origPath = process.env.PATH;
    const bundled = bundledRipgrepPath();
    if (bundled) {
      // 有捆绑二进制时改成校验「参数错了也不炸」：空参数列表只是打印帮助，不会是崩溃
      const out = runRipgrep(['--version'], { cwd: dir });
      assert(out && out.status === 0, '正常调用应拿到退出码 0');
    } else {
      process.env.PATH = join(dir, 'definitely-not-here');
      resetRipgrepCache();
      eq(runRipgrep(['--version'], { cwd: dir }), null, '找不到二进制给 null，调用方据此回退');
      process.env.PATH = origPath;
      resetRipgrepCache();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  await test('grep: ripgrep 路径的答案与纯 JS 路径一致（目录黑名单 / 隐藏文件 / glob 过滤）', async () => {
    const dir = ws({
      'src/a.mjs': 'const NEEDLE = 1;\nconsole.log(NEEDLE);\n',
      'src/deep/b.mjs': '// 无关文件\n',
      'notes.txt': 'NEEDLE 在文本里\nNEEDLE 时间 10:20:30 带冒号\n',
      '.git/objects/x': 'NEEDLE git 内部\n',
      'node_modules/pkg/i.js': 'NEEDLE 依赖\n',
      '.hidden.txt': 'NEEDLE 隐藏文件\n',
      'bin.dat': 'NEEDLE\0二进制\n',
    });
    const grep = getTool('grep');
    const ctx = { workspace: dir };
    const all = await grep.run({ pattern: 'NEEDLE' }, ctx);
    assert(all.includes('src/a.mjs:1') && all.includes('src/a.mjs:2'), '跨行命中带 文件:行号');
    assert(all.includes('notes.txt:1'), '根目录文件也命中');
    assert(all.includes('.hidden.txt:1'), '隐藏文件参与检索（与纯 JS 路径一致）');
    assert(!all.includes('.git/objects'), '.git 整枝剪掉');
    assert(!all.includes('node_modules'), '依赖目录整枝剪掉');
    assert(!all.includes('bin.dat'), '二进制文件不搜');
    assert(all.includes('时间 10:20:30 带冒号'), '正文里的冒号不被当成分隔符（JSON 输出按字段取）');
    const filtered = await grep.run({ pattern: 'NEEDLE', glob: '*.txt' }, ctx);
    assert(filtered.includes('notes.txt') && !filtered.includes('a.mjs'), 'glob 按文件名过滤');
    const capped = await grep.run({ pattern: 'NEEDLE', max_results: 1 }, ctx);
    assert(capped.includes('已达上限 1 条'), '预算上限有提示');
    eq((await grep.run({ pattern: '绝对不存在XYZ' }, ctx)).includes('未匹配到'), true, '无匹配给明确空态');
    let threw = false;
    try { await grep.run({ pattern: '([' }, ctx); } catch (e) { threw = e.code === 'bad_args'; }
    assert(threw, '非法正则仍报 bad_args');
    // Rust regex 不支持的语法（环视）必须干净回退到纯 JS 路径，而不是把 rg 的报错丢给模型
    const lookahead = await grep.run({ pattern: 'NEEDLE(?= 在)' }, ctx);
    assert(lookahead.includes('notes.txt:1'), '环视正则回退后仍能搜到');
    let escaped = false;
    try { await grep.run({ pattern: 'root', path: '/etc' }, ctx); } catch (e) { escaped = e.code === 'path_escape'; }
    assert(escaped, '搜索起点仍受路径禁锢');
    rmSync(dir, { recursive: true, force: true });
  });

  await test('grep: 命中忽略规则的文件在 ripgrep 路径上同样被滤掉', async () => {
    const dir = ws({ 'app.pem': 'SECRET', 'ok.txt': 'NEEDLE fine' });
    writeFileSync(join(dir, '.auroraagentignore'), '*.pem\n');
    const { IgnoreController } = await import('../util/ignore.mjs');
    const ignore = new IgnoreController({ workspace: dir, log: () => {} }).load();
    const out = await getTool('grep').run({ pattern: 'NEEDLE' }, { workspace: dir, ignore });
    assert(!out.includes('SECRET'), '禁入区内容不进检索结果');
    assert(out.includes('ok.txt'), '非禁入区文件照常命中');
    rmSync(dir, { recursive: true, force: true });
  });

  await test('glob: ripgrep 路径与纯 JS 路径同一答案（锚定 / 基名 / 上限 / 空态）', async () => {
    const dir = ws({
      'src/a.mjs': 'x', 'src/deep/b.mjs': 'x', 'notes.txt': 'x',
      '.git/objects/x': 'x', 'node_modules/pkg/i.js': 'x', '.hidden.txt': 'x',
    });
    const glob = getTool('glob');
    const ctx = { workspace: dir };
    const mjs = await glob.run({ pattern: '**/*.mjs' }, ctx);
    assert(mjs.includes('src/a.mjs') && mjs.includes('src/deep/b.mjs'), '跨目录');
    assert(!mjs.includes('notes.txt'), '按扩展名过滤');
    assert(!mjs.includes('node_modules'), '依赖目录不列');
    const named = await glob.run({ pattern: 'notes.txt' }, ctx);
    assert(named.includes('notes.txt'), '无斜杠模式匹配 basename');
    const scoped = await glob.run({ pattern: 'src/*.mjs' }, ctx);
    assert(scoped.includes('src/a.mjs') && !scoped.includes('src/deep/b.mjs'), '单星不跨目录');
    assert(!scoped.includes('.hidden.txt'), '锚定模式不放大到任意深度');
    const hidden = await glob.run({ pattern: '.hidden.txt' }, ctx);
    assert(hidden.includes('.hidden.txt'), '隐藏文件可被显式点名（与纯 JS 路径一致）');
    eq((await glob.run({ pattern: '*.rs' }, ctx)).includes('未匹配到'), true, '空态明确');
    let threw = false;
    try { await glob.run({ pattern: 'passwd', path: '../../..' }, ctx); } catch (e) { threw = e.code === 'path_escape'; }
    assert(threw, '起点仍受路径禁锢');
    rmSync(dir, { recursive: true, force: true });
  });

  await test('rg: 关掉开关后两条路径答案一致（回退路径不是死代码）', async () => {
    const dir = ws({
      'src/a.mjs': 'NEEDLE 甲\nNEEDLE 乙\n',
      'src/deep/b.mjs': '无关\n',
      'notes.txt': 'NEEDLE 时间 10:20:30\n',
      '.git/objects/x': 'NEEDLE git 内部\n',
      'node_modules/pkg/i.js': 'NEEDLE 依赖\n',
      '.hidden.txt': 'NEEDLE 隐藏\n',
    });
    // 子进程里关掉 rg：回退路径是另一条独立代码，必须真的跑一遍才知道它烂没烂
    const script = `
      const t = await import(${JSON.stringify(join(dirname(fileURLToPath(import.meta.url)), '..', 'util', 'agent', 'tools.mjs'))});
      const out = {};
      out.grep = await t.getTool('grep').run({ pattern: 'NEEDLE' }, { workspace: ${JSON.stringify(dir)} });
      out.glob = await t.getTool('glob').run({ pattern: '**/*.mjs' }, { workspace: ${JSON.stringify(dir)} });
      out.named = await t.getTool('glob').run({ pattern: 'notes.txt' }, { workspace: ${JSON.stringify(dir)} });
      console.log(JSON.stringify(out));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, AURORAAGENT_NO_RIPGREP: '1' }, encoding: 'utf8', timeout: 30000,
    });
    assert(child.status === 0, `子进程应正常退出: ${child.stderr}`);
    const slow = JSON.parse(child.stdout.trim().split('\n').pop());
    const fast = {
      grep: await getTool('grep').run({ pattern: 'NEEDLE' }, { workspace: dir }),
      glob: await getTool('glob').run({ pattern: '**/*.mjs' }, { workspace: dir }),
      named: await getTool('glob').run({ pattern: 'notes.txt' }, { workspace: dir }),
    };
    for (const key of Object.keys(fast)) {
      const norm = (s) => String(s).replace(/（扫描 \d+ 个文本文件）/, '').split('\n').slice(1).sort().join('\n');
      eq(norm(slow[key]), norm(fast[key]), `两条路径对 ${key} 的答案应一致`);
    }
    assert(!slow.grep.includes('.git/objects') && !slow.grep.includes('node_modules'), '回退路径同样剪掉黑名单目录');
    assert(slow.grep.includes('.hidden.txt'), '回退路径同样收录隐藏文件');
    rmSync(dir, { recursive: true, force: true });
  });

  await test('rg: 异步调用必定收口（超时 / 坏参数都不挂 Promise）', async () => {
    const { runRipgrepAsync } = await import('../util/ripgrep.mjs');
    if (!findRipgrep()) return; // 环境没装 rg 时无从验证，跳过而非假通过
    const dir = ws({ 'a.txt': 'NEEDLE\n'.repeat(200) });
    const t0 = Date.now();
    const timedOut = await runRipgrepAsync(['--regexp', 'NEEDLE', '.', '--no-ignore', '--hidden'], { cwd: dir, timeoutMs: 1 });
    assert(timedOut !== null, '起了进程就一定有回值（不会被无限挂住）');
    assert(Date.now() - t0 < 5000, `1ms 超时应立刻收口，实际 ${Date.now() - t0}ms`);
    const bad = await runRipgrepAsync(['--json', '--regexp', 'NEEDLE', '.', '--not-a-flag'], { cwd: dir });
    eq(bad.status, 2, 'rg 自己报错时给退出码 2，调用方据此回退');
    const none = await runRipgrepAsync(['--files', '.'], { cwd: dir });
    assert(none && Array.isArray(none.stdout.split('\n')), '正常调用给 stdout 文本');
    rmSync(dir, { recursive: true, force: true });
  });
}
