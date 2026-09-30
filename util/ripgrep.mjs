/**
 * ripgrep 解析与调用（零依赖 spawn，唯一捆绑的第三方二进制）。
 *
 * grep / glob 两个检索工具原先靠 Node 逐目录 readdir + 逐文件读盘比对，大仓库上既慢又吃内存
 * （一个 node_modules 就能让 list_dir 之外的全部检索退化成分钟级）。ripgrep 是 C 写的、
 * 自带目录遍历与 .gitignore 语义，正适合这件事。但它是外部二进制，装机环境里未必有，
 * 因此解析顺序固定为：
 *
 *   1. tools/bin/<arch>/rg        随仓库提交的二进制（tools/download-ripgrep.mjs 落 here）
 *   2. PATH 里的 rg               用户自己装的（brew install ripgrep）
 *   3. null                       两个都没有 → 调用方回退到纯 JS 遍历实现
 *
 * 关键约束：**回退路径必须与 ripgrep 路径行为一致**。rg 默认会读 .gitignore / .ignore 并跳过
 * 隐藏文件，而项目既有的遍历实现只跳 SKIP_DIRS、不过 gitignore。为了让「装没装 rg」不影响
 * 检索结果，一律显式关掉 rg 的忽略文件与隐藏文件过滤（--no-ignore --hidden），目录黑名单
 * 与 .auroraagentignore 闸门仍由 tools.mjs 单一真值源负责（前者转成 -g 排除，后者在结果上过滤）。
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 随仓库提交的 ripgrep 路径（按当前 CPU 架构分流；文件不存在即视为未捆绑） */
export function bundledRipgrepPath(arch = process.arch) {
  const p = join(REPO_ROOT, 'tools', 'bin', arch, 'rg');
  try { return statSync(p).isFile() ? p : null; } catch { return null; }
}

/** 排查开关：AURORAAGENT_NO_RIPGREP=1 时一律当作没有 rg，强制走纯 JS 回退路径。
 *  存在意义有两条：rg 出新版本改了行为时能一键比对两条路径的答案；回退路径长期没人走会烂掉，
 *  有个开关才能让测试真的去跑它（而不是只跑 rg 那一条）。 */
const DISABLED = process.env.AURORAAGENT_NO_RIPGREP === '1';

let cached; // undefined = 还没解析过；null = 解析过但不可用；string = 可用路径

/** 解析 ripgrep 可执行路径（结果按进程缓存：PATH 探测是同步 IO，不该每次检索都做） */
export function findRipgrep() {
  if (cached !== undefined) return cached;
  if (DISABLED) { cached = null; return cached; }
  const bundled = bundledRipgrepPath();
  if (bundled) { cached = bundled; return cached; }
  // PATH 里找：用 spawnSync 跑 `rg --version` 比手工拼 PATH 更稳（Windows 的 PATHEXT 也算）
  const probe = spawnSync('rg', ['--version'], { encoding: 'utf8', timeout: 5000 });
  cached = probe.status === 0 && !probe.error ? 'rg' : null;
  return cached;
}

/** 测试用：清掉解析缓存（换了 tools/bin 内容或改了 PATH 后重新探） */
export function resetRipgrepCache() { cached = undefined; }

/**
 * 目录黑名单 → rg 的 -g 排除参数。SKIP_DIRS 是 tools.mjs 的单一真值源，这里只做转换，
 * 不复制名单（复制一份就意味着两处会各自漂移）。
 * 每条目录给两个模式：一个挡目录本身，一个挡任意深度下同名目录里的文件
 * （写成 glob 字符串时会带星号，这里不再展开，见 excludeGlobs 的实现）。
 */
export function excludeGlobs(names) {
  const out = [];
  for (const n of names || []) {
    const clean = String(n || '').trim();
    if (!clean) continue;
    out.push(`!${clean}`, `!**/${clean}/**`);
  }
  return out;
}

/**
 * 跑一次 ripgrep。
 * @param {string[]} args rg 参数（不含可执行名）
 * @param {{ cwd?: string, timeoutMs?: number, maxBuffer?: number }} opts
 * @returns {{ status: number, stdout: string, stderr: string } | null} 二进制不可用给 null；
 *          status 2 = rg 自身报错（正则不被 Rust regex 支持等），调用方应回退
 */
export function runRipgrep(args, { cwd, timeoutMs = 20000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  const bin = findRipgrep();
  if (!bin) return null;
  const r = spawnSync(bin, args, { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer, windowsHide: true });
  if (r.error) return null; // 起不来（捆绑二进制架构不匹配等）→ 回退
  return { status: r.status ?? 1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * 异步版跑 ripgrep（spawn 而非 spawnSync）：网页服务与终端共用一个进程，
 * 同步 spawn 会把整个事件循环堵住几秒——那期间 SSE 心跳、其它会话的流全停。
 * 检索是工具调用里最可能跑久的，因此走异步；返回值与 runRipgrep 一致。
 */
export function runRipgrepAsync(args, { cwd, timeoutMs = 20000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  const bin = findRipgrep();
  if (!bin) return Promise.resolve(null);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd, windowsHide: true });
    } catch { resolve(null); return; }
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (d) => { out += d; if (out.length > maxBuffer) out = out.slice(0, maxBuffer); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 64 * 1024) err = err.slice(0, 64 * 1024); });
    child.on('error', () => { clearTimeout(timer); resolve(null); }); // 起不来（架构不匹配等）→ 回退
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) { resolve({ status: 2, stdout: '', stderr: 'ripgrep 超时' }); return; }
      resolve({ status: code ?? 1, stdout: out, stderr: err });
    });
  });
}

/** rg 是否可用（探测一次即缓存；给 /api/health 与设置页展示用） */
export function ripgrepStatus() {
  const bin = findRipgrep();
  return { available: Boolean(bin), path: bin === 'rg' ? 'PATH' : (bin || null), bundled: Boolean(bundledRipgrepPath()) };
}

/** 仓库里是否已捆绑 ripgrep（给 download 脚本与文档说明用） */
export function hasBundledRipgrep() { return Boolean(bundledRipgrepPath()); }
