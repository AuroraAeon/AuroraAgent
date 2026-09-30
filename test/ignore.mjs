/**
 * 忽略文件单元测试（util/ignore.mjs + util/agent/tools.mjs 的闸门接线）：
 * 取反、!include（含穿越拒绝）、目录模式、** 跨层、锚定语义，
 * 以及六个文件类工具的命中拒绝与检索剪枝、shell 子进程环境净化。
 * 数据隔离：全部用临时目录当工作区，绝不碰真实数据目录。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IgnoreController, parseIgnoreText, parseIgnoreConfig, LOCK_TEXT_SYMBOL } from '../util/ignore.mjs';
import { getTool, sanitizeChildEnv } from '../util/agent/tools.mjs';

function ws(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aurora-ign-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text);
  }
  return dir;
}

export async function runIgnoreTests(test, assert, eq) {
  console.log('\n忽略文件与安全闸门单元测试');

  await test('ignore: 取反——先忽略再豁免，最后命中说了算', () => {
    const { patterns } = parseIgnoreText('*.log\n!keep.log\n');
    const c = Object.create(IgnoreController.prototype);
    c.root = '/ws'; c.patterns = patterns;
    eq(c.isIgnored('/ws/a.log').ignored, true, '*.log 应挡住一般日志');
    eq(c.isIgnored('/ws/keep.log').ignored, false, '!keep.log 取反应放行');
    eq(c.isIgnored('/ws/keep.log').pattern, null, '放行时不报命中规则');
    eq(c.isIgnored('/ws/deep/a.log').ignored, true, '不含斜杠的模式按基名任意深度匹配');
  });

  await test('ignore: !include 引入附加规则并拒绝穿越工作目录', () => {
    const dir = ws({
      '.auroraagentignore': '!include team.ignore\n*.tmp\n',
      'team.ignore': 'secrets/\n!secrets/readme.md\n',
      'a.tmp': 'x', 'secrets/k.pem': 'x', 'secrets/readme.md': 'x',
    });
    try {
      const c = new IgnoreController({ workspace: dir }).load();
      eq(c.isIgnored(join(dir, 'a.tmp')).ignored, true, '主文件规则生效');
      eq(c.isIgnored(join(dir, 'secrets', 'k.pem')).ignored, true, 'include 的目录规则生效');
      eq(c.isIgnored(join(dir, 'secrets', 'readme.md')).ignored, false, 'include 内的取反同样有效');
      writeFileSync(join(dir, '.auroraagentignore'), '!include ../../etc/passwd\n*.tmp\n');
      c.reload();
      eq(c.isIgnored(join(dir, 'a.tmp')).ignored, true, '穿越 include 被拒绝但其余规则仍生效');
      c.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  await test('ignore: 目录模式只挡目录（同名文件不挡）与 ** 跨层', () => {
    const dir = ws({
      '.auroraagentignore': 'build/\n**/temp/*.log\n',
      'build/out.js': 'x', 'a/temp/x.log': 'x', 'a/temp/keep.txt': 'x',
    });
    const fileOnly = ws({ '.auroraagentignore': 'build/\n', build: 'x' });
    try {
      const c = new IgnoreController({ workspace: dir }).load();
      eq(c.isIgnored(join(dir, 'build', 'out.js')).ignored, true, '目录模式下其内容被挡');
      eq(c.isIgnored(join(dir, 'build')).ignored, true, '目录本身被挡');
      eq(c.isIgnored(join(dir, 'a', 'temp', 'x.log')).ignored, true, '** 跨任意层');
      eq(c.isIgnored(join(dir, 'a', 'temp', 'keep.txt')).ignored, false, '不匹配的不挡');
      c.close();
      const f = new IgnoreController({ workspace: fileOnly }).load();
      eq(f.isIgnored(join(fileOnly, 'build')).ignored, false, '同名文件不该被目录模式挡住');
      f.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(fileOnly, { recursive: true, force: true });
    }
  });

  await test('ignore: 含斜杠模式锚定到根，工作目录之外的路径不归它管', () => {
    const { patterns } = parseIgnoreText('/src/gen/*.js\n');
    const c = Object.create(IgnoreController.prototype);
    c.root = '/ws'; c.patterns = patterns;
    eq(c.isIgnored('/ws/src/gen/a.js').ignored, true, '锚定根下匹配');
    eq(c.isIgnored('/ws/lib/src/gen/a.js').ignored, false, '锚定模式不在任意深度生效');
    eq(c.isIgnored('/etc/passwd').ignored, false, '工作目录外路径返回不忽略（禁锢由 resolveInside 负责）');
  });

  await test('ignore: 配置段解析——缺省开、显式关、坏值回退开', () => {
    eq(parseIgnoreConfig(undefined).enabled, true, '缺省开');
    eq(parseIgnoreConfig({ ignore: { enabled: false } }).enabled, false, '显式关');
    eq(parseIgnoreConfig({ ignore: {} }).enabled, true, '空对象算开');
    eq(parseIgnoreConfig({ ignore: 'nope' }).enabled, true, '坏值回退开');
  });

  await test('ignore: 文件类工具命中禁入区即拒（中文原因 + 锁形标记）', async () => {
    const dir = ws({
      '.auroraagentignore': '*.pem\nlocked/\n',
      'k.pem': 'secret', 'locked/a.txt': 'x', 'ok.txt': 'fine',
    });
    const ctx = { workspace: dir, ignore: new IgnoreController({ workspace: dir }).load() };
    try {
      for (const [tool, args] of [['read_file', { path: 'k.pem' }], ['write_file', { path: 'k.pem', content: 'x' }], ['edit_file', { path: 'k.pem', old_string: 'secret', new_string: 'x' }], ['list_dir', { path: 'locked' }], ['grep', { path: 'locked' }], ['glob', { pattern: '**/*.txt', path: 'locked' }]]) {
        let err = null;
        try { await getTool(tool).run(args, ctx); } catch (e) { err = e; }
        assert(err, `${tool} 应拒绝`);
        eq(err.code, 'ignored', `${tool} 的错误码应是 ignored`);
        assert(err.message.includes(LOCK_TEXT_SYMBOL), `${tool} 的拒绝原因应带锁形标记`);
        assert(err.message.includes('.auroraagentignore'), `${tool} 的拒绝原因应指出忽略文件名`);
      }
      const okText = String(await getTool('read_file').run({ path: 'ok.txt' }, ctx));
      assert(okText.includes('fine'), '未命中文件照常可读');
    } finally { ctx.ignore.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  await test('ignore: grep / glob 遍历按规则剪枝（禁入区文件不出现在结果里）', async () => {
    const dir = ws({
      '.auroraagentignore': 'secret/\n',
      'secret/hidden.txt': 'needle', 'src/visible.txt': 'needle',
    });
    const ctx = { workspace: dir, ignore: new IgnoreController({ workspace: dir }).load() };
    try {
      const grepOut = await getTool('grep').run({ pattern: 'needle' }, ctx);
      assert(grepOut.includes('src/visible.txt'), '可见文件应被搜到');
      assert(!grepOut.includes('hidden.txt'), '禁入区文件不应出现在检索结果里');
      const globOut = await getTool('glob').run({ pattern: '**/*.txt' }, ctx);
      assert(globOut.includes('src/visible.txt'), 'glob 应列出可见文件');
      assert(!globOut.includes('hidden.txt'), 'glob 应剪掉禁入区');
    } finally { ctx.ignore.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  await test('shell: 子进程环境净化剔除凭据形态变量、保留基础白名单', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aurora-env-'));
    const ctx = { workspace: dir, sanitizeChildEnv: true };
    const prev = process.env.AURORAAGENT_API_KEY;
    process.env.AURORAAGENT_API_KEY = 'sk-should-not-leak';
    process.env.MY_APP_TOKEN = 'tok-should-not-leak';
    try {
      const env = sanitizeChildEnv(process.env, true);
      assert(!('AURORAAGENT_API_KEY' in env), 'API Key 应被剔除');
      assert(!('MY_APP_TOKEN' in env), 'TOKEN 形态变量应被剔除');
      assert('PATH' in env && 'HOME' in env, 'PATH / HOME 白名单应保留');
      eq(sanitizeChildEnv({ A: '1' }, false).A, '1', 'enabled=false 时原样透传（排障用）');
      const out = await getTool('shell').run({ command: 'echo "key=[$AURORAAGENT_API_KEY] tok=[$MY_APP_TOKEN] home=[$HOME]"' }, ctx);
      assert(out.includes('key=[]'), '子进程里读不到 API Key');
      assert(out.includes('tok=[]'), '子进程里读不到 TOKEN');
      assert(out.includes(`home=[${process.env.HOME}]`), 'HOME 仍在子进程里');
    } finally {
      if (prev === undefined) delete process.env.AURORAAGENT_API_KEY; else process.env.AURORAAGENT_API_KEY = prev;
      delete process.env.MY_APP_TOKEN;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
