#!/usr/bin/env node
/**
 * 下载 ripgrep 二进制到 tools/bin/<arch>/rg（随仓库提交，App Bundle 里也随之带上）。
 *
 *   node tools/download-ripgrep.mjs            只下当前架构
 *   node tools/download-ripgrep.mjs --all      下全部 macOS 架构（arm64 + x64）
 *   node tools/download-ripgrep.mjs 14.1.1     指定版本（默认见 RG_VERSION）
 *
 * 为什么捆绑：grep / glob 两个检索工具优先用 ripgrep（util/ripgrep.mjs），没装时会回退到
 * 纯 JS 遍历——功能不缺，但大仓库上慢一个量级。捆一份进仓库，任何机器开箱就是快的那条路，
 * 且不引入 npm 依赖（零依赖底线只允许「随仓库提交的二进制」这一种例外）。
 *
 * 零依赖实现：https 直连 + 手动跟随 302 + node:zlib 解 gzip + 手写 tar 头解析
 * （tar 就是 512 字节定长头的顺序格式，不值得为它引一个包）。
 */
import { request } from 'node:https';
import { gunzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RG_VERSION = '14.1.1';
const RELEASE_BASE = `https://github.com/BurntSushi/ripgrep/releases/download`;
/** node 平台架构 → { triple, dir }：triple 是 release 资产的命名，dir 是落地目录名。
 * dir 与 process.arch 一致（arm64 / x64），因为 util/ripgrep.mjs 就按 process.arch 找
 * tools/bin/<arch>/rg——两边对不上就等于白捆（本项目只支持 macOS，故只覆盖这两个）。 */
const TARGETS = {
  'darwin-arm64': { triple: 'aarch64-apple-darwin', dir: 'arm64' },
  'darwin-x64': { triple: 'x86_64-apple-darwin', dir: 'x64' },
};
const MAX_REDIRECTS = 5;

const wantAll = process.argv.includes('--all');
const versionArg = process.argv.find((a) => /^\d+\.\d+\.\d+$/.test(a));
const VERSION = versionArg || RG_VERSION;
const arches = wantAll ? Object.keys(TARGETS) : [`${process.platform}-${process.arch}`];

/** 下一个跳转目标（GitHub release 资产会 302 到 objects.githubusercontent.com） */
function redirectOf(res) {
  if (![301, 302, 303, 307, 308].includes(res.statusCode)) return null;
  const loc = res.headers.location;
  return loc ? new URL(loc, res.url || `${RELEASE_BASE}/`).toString() : null;
}

/** 下载一个 URL 到 Buffer（跟随跳转，封顶防环） */
function download(url, hops = 0) {
  return new Promise((resolve, reject) => {
    if (hops > MAX_REDIRECTS) { reject(new Error('跳转次数过多')); return; }
    const req = request(url, (res) => {
      const next = redirectOf(res);
      if (next) { res.resume(); resolve(download(next, hops + 1)); return; }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} ${url}`)); return; }
      const chunks = [];
      let size = 0;
      res.on('data', (d) => { size += d.length; if (size > 64 * 1024 * 1024) { req.destroy(new Error('文件超过 64MB，不正常')); return; } chunks.push(d); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * 从 tar 字节流里取出名为 <prefix>rg 的条目（只认普通文件，权限位照抄）。
 * tar 头：name[0:100] size[124:136]（八进制 ASCII） mode[100:108] typeflag[156]。
 */
function extractFile(tarBuf, wantName) {
  for (let off = 0; off + 512 <= tarBuf.length;) {
    const header = tarBuf.subarray(off, off + 512);
    // 全零头 = 归档结束
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    const typeflag = String.fromCharCode(header[156] || 0);
    const mode = parseInt(header.subarray(100, 108).toString('ascii').replace(/\0.*$/, '').trim() || '644', 8);
    const body = tarBuf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (typeflag !== '0' && typeflag !== '\0') continue; // 目录 / 链接等一概跳过
    if (name !== wantName && !name.endsWith(`/${wantName}`)) continue;
    return { body, mode };
  }
  return null;
}

async function fetchArch(arch) {
  const target = TARGETS[arch];
  if (!target) throw new Error(`不支持的架构：${arch}（可用：${Object.keys(TARGETS).join('、')}）`);
  const asset = `ripgrep-${VERSION}-${target.triple}`;
  const url = `${RELEASE_BASE}/${VERSION}/${asset}.tar.gz`;
  process.stdout.write(`  下载 ${url} ... `);
  const gz = await download(url);
  const tar = gunzipSync(gz);
  const hit = extractFile(tar, 'rg');
  if (!hit) throw new Error('归档里找不到 rg 可执行文件');
  const out = join(ROOT, 'tools', 'bin', target.dir, 'rg');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, hit.body);
  chmodSync(out, 0o755);
  const kb = Math.round(statSync(out).size / 1024);
  console.log(`OK -> ${out}（${kb} KB）`);
}

if (existsSync(join(ROOT, 'tools', 'bin')) && process.argv.includes('--clean')) {
  rmSync(join(ROOT, 'tools', 'bin'), { recursive: true, force: true });
}

console.log(`ripgrep ${VERSION}`);
for (const arch of arches) {
  try { await fetchArch(arch); }
  catch (e) { console.error(`失败（${arch}）：${e.message}`); process.exitCode = 1; }
}
console.log('完成。检索工具会优先用这份二进制，找不到时回退到 PATH 里的 rg，再不行回退纯 JS 遍历。');
