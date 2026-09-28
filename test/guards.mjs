/**
 * 仓库守卫（对齐 kimi-code 的 guard 思路，零依赖）：产品零 emoji、TUI 颜色单一真值源、
 * 主题对比度、新模块行数预算。由 run-tests.mjs 注入 test/assert/eq 后调用，
 * 也可经 tools/guard.mjs 独立运行（npm run guard）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PALETTES, auditPalette } from '../util/tui/theme.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'assets', 'public', 'docs', '.vitepress']);

function walk(dir, exts, acc = []) {
  let entries = [];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, exts, acc);
    else if (exts.some((e) => name.endsWith(e))) acc.push(p);
  }
  return acc;
}

/** 产品源码范围：后端 + 前端源码 + 根脚本 + 技能（不含构建产物与文档散文） */
function productFiles() {
  const files = [];
  for (const base of ['util', 'web-ui/src', 'skills']) {
    const abs = join(ROOT, base);
    if (statSync(abs, { throwIfNoEntry: false })) files.push(...walk(abs, ['.mjs', '.ts', '.tsx', '.css', '.md']));
  }
  for (const f of ['web.mjs', 'chat.mjs', 'check.mjs']) files.push(join(ROOT, f));
  return files;
}

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;
const ALLOWED_GLYPHS = new Set(['✓', '✗', '❯', '←', '→', '↑', '↓', '▼', '·', '…', '—', '─', '│', '╭', '╮', '╰', '╯', '▶', '◀', '★']);

export function guardNoEmoji() {
  const bad = [];
  for (const f of productFiles()) {
    const text = readFileSync(f, 'utf8');
    for (const ch of text) {
      if (EMOJI_RE.test(ch) && !ALLOWED_GLYPHS.has(ch)) {
        bad.push(`${f.replace(ROOT + '/', '')}: U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
        break;
      }
    }
  }
  if (bad.length) throw new Error(`产品源码含 emoji（一律内联 SVG / 符号）: ${bad.join(', ')}`);
}

const RAW_COLOR_RE = /\x1b\[(38;2|48;2|[349][0-9]|10[0-7])m/;
export function guardNoRawColorOutsideTheme() {
  const bad = [];
  for (const f of walk(join(ROOT, 'util/tui'), ['.mjs'])) {
    if (f.endsWith('theme.mjs')) continue;
    if (RAW_COLOR_RE.test(readFileSync(f, 'utf8'))) bad.push(f.replace(ROOT + '/', ''));
  }
  if (bad.length) throw new Error(`TUI 颜色必须走 theme.mjs 的 Painter，以下文件出现原始 SGR: ${bad.join(', ')}`);
}

export function guardContrast() {
  for (const name of ['dark', 'light']) {
    const issues = auditPalette(PALETTES[name]);
    if (issues.length) throw new Error(`${name} 色板对比度不足: ${JSON.stringify(issues)}`);
  }
}


/** 网页设计令牌对比度守卫：双主题的关键前景 / 背景组合都要达到可读阈值 */
const TOKEN_BLOCKS = [['dark', ':root {'], ['light', ':root[data-theme="light"] {']];
/** [前景, 背景, 阈值]：正文与语义色按 AA 4.5，最弱的 faint 元信息按 3.0（与原深色值同级） */
const TOKEN_PAIRS = [
  ['--text', '--bg', 4.5], ['--text', '--panel', 4.5], ['--text', '--code-bg', 4.5],
  ['--dim', '--panel', 4.5], ['--dim', '--surface', 4.5],
  ['--faint', '--panel', 3],
  ['--accent', '--panel', 4.5], ['--accent-hi', '--panel', 4.5],
  ['--ok-ink', '--panel', 4.5], ['--danger-ink', '--panel', 4.5], ['--think', '--panel', 3],
  ['--warn-ink', '--panel', 4.5], ['--warn-ink', '--surface', 4.5], ['--warn', '--panel', 3],
  ['--text', '--sidebar-fill', 4.5], ['--dim', '--sidebar-fill', 4.5], ['--faint', '--sidebar-fill', 3],
  ['--diff-add-ink', '--panel', 4.5], ['--diff-del-ink', '--panel', 4.5],
  ['--tooltip-ink', '--tooltip-bg', 4.5], ['--kbd-ink', '--kbd-bg', 4.5],
];

function parseHexTokens(block) {
  const out = {};
  for (const m of block.matchAll(/(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) out[m[1]] = m[2];
  return out;
}

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6);
  const rgb = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

export function guardWebTokenContrast() {
  const css = readFileSync(join(ROOT, 'web-ui', 'src', 'tokens.css'), 'utf8');
  const issues = [];
  for (const [name, marker] of TOKEN_BLOCKS) {
    const start = css.indexOf(marker);
    if (start < 0) throw new Error(`tokens.css 缺少 ${marker} 主题块`);
    const block = css.slice(start, css.indexOf('\n}', start));
    const tokens = parseHexTokens(block);
    for (const [fg, bg, min] of TOKEN_PAIRS) {
      const f = tokens[fg];
      const b = tokens[bg];
      if (!f || !b) { issues.push(`${name}: 缺 ${f ? bg : f}`); continue; }
      const l1 = luminance(f);
      const l2 = luminance(b);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      if (ratio < min) issues.push(`${name} ${fg}/${bg} = ${ratio.toFixed(2)} < ${min}`);
    }
  }
  if (issues.length) throw new Error(`网页令牌对比度不足: ${issues.join(', ')}`);
}

/** 过渡动画纪律（ZCode 教训：transition-all 会在大会话 / 连续缩放里批量启动
 *  scrollbar-color、尺寸等非合成动画，放大主线程 style/layout 压力）：
 *  产品样式只允许过渡颜色 / 透明度 / 变换类属性 */
const TRANSITION_ALL_RE = /transition\s*:\s*all\b/;
export function guardNoTransitionAll() {
  const bad = [];
  for (const f of walk(join(ROOT, 'web-ui', 'src'), ['.css'])) {
    if (TRANSITION_ALL_RE.test(readFileSync(f, 'utf8'))) bad.push(f.replace(ROOT + '/', ''));
  }
  if (bad.length) throw new Error(`过渡动画禁止 transition:all（只动颜色 / 透明度 / 变换）: ${bad.join(', ')}`);
}

const LINE_BUDGET = 500;
export function guardLineBudget() {
  const bad = [];
  for (const base of ['util/tui', 'util/llm']) {
    for (const f of walk(join(ROOT, base), ['.mjs'])) {
      const n = readFileSync(f, 'utf8').split('\n').length;
      if (n > LINE_BUDGET) bad.push(`${f.replace(ROOT + '/', '')}: ${n} 行`);
    }
  }
  if (bad.length) throw new Error(`超过 ${LINE_BUDGET} 行预算: ${bad.join(', ')}`);
}


/** 文档站契约：中英页面一一对应、设计规范单一真值源在站点内、发布笔记标记在场、依赖例外已登记 */
export function guardDocsSite() {
  const site = join(ROOT, 'docs-site');
  if (!existsSync(join(site, '.vitepress', 'config.mjs'))) throw new Error('文档站缺少 .vitepress/config.mjs');
  if (!existsSync(join(site, 'AGENTS.md'))) throw new Error('文档站缺少写作规约 docs-site/AGENTS.md');
  const pages = (lang) => walk(join(site, lang), ['.md']).map((f) => f.slice(join(site, lang).length + 1)).sort();
  const zh = pages('zh');
  const en = pages('en');
  if (zh.join('|') !== en.join('|')) throw new Error('文档站中英页面未一一对应: zh=[' + zh.join(',') + '] en=[' + en.join(',') + ']');
  if (!existsSync(join(site, 'zh', 'reference', 'tui-design.md'))) throw new Error('终端设计规范应位于 docs-site/zh/reference/tui-design.md');
  if (existsSync(join(ROOT, 'docs', 'tui-design.md'))) throw new Error('docs/tui-design.md 是迁站前的旧位置，规范只应存在文档站内');
  for (const [file, marker] of [['zh/release-notes/index.md', 'RELEASE-NOTES:ZH'], ['en/release-notes/index.md', 'RELEASE-NOTES:EN']]) {
    const text = readFileSync(join(site, file), 'utf8');
    if (!text.includes(`<!-- ${marker} -->`) || !text.includes(`<!-- /${marker} -->`)) throw new Error(`${file} 缺少 ${marker} 开闭标记`);
  }
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  if (!gitignore.includes('docs-site/node_modules/')) throw new Error('.gitignore 应排除 docs-site/node_modules/');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const s of ['docs:dev', 'docs:build', 'docs:notes']) {
    if (!pkg.scripts[s]) throw new Error(`package.json 应提供 ${s} 脚本`);
  }
}
/** 文档新鲜度守卫：release-please 只改 package.json，README 的版本标注会静默过期 */
export function guardDocsFreshness() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const m = readme.match(/版本随 package\.json（([0-9][^）]*)）/);
  if (!m) throw new Error('README.md 缺少「版本随 package.json（X.Y.Z）」标注');
  if (m[1] !== pkg.version) {
    throw new Error(`README 版本标注（${m[1]}）与 package.json（${pkg.version}）不一致：合并发布 PR 后应同步 README`);
  }
}

/** 架构地图守卫（对齐 ZCode architecture-baseline 思路）：util/ 顶层与 util/agent/ 的每个模块
 *  都必须登记进 AGENTS.md 架构地图；基线豁免记在 test/architecture-baseline.json，
 *  只让「新漏报」变红，历史欠账不阻塞（还清一笔删一条） */
export function guardArchitectureMap() {
  const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  const map = agents.slice(agents.indexOf('## 1. 架构地图'), agents.indexOf('## 2. 常用命令'));
  const baseline = new Set(JSON.parse(readFileSync(join(ROOT, 'test', 'architecture-baseline.json'), 'utf8')).exempt || []);
  const missing = [];
  for (const dir of ['util', 'util/agent']) {
    let names = [];
    try { names = readdirSync(join(ROOT, dir)); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.mjs')) continue;
      const rel = `${dir}/${name}`;
      if (!map.includes(name) && !baseline.has(rel)) missing.push(rel);
    }
  }
  if (missing.length) throw new Error(`以下模块未登记进 AGENTS.md 架构地图（补表格或记入 test/architecture-baseline.json）: ${missing.join(', ')}`);
}

export const GUARDS = [
  ['产品源码零 emoji', guardNoEmoji],
  ['网页设计令牌双主题对比度达标', guardWebTokenContrast],
  ['TUI 颜色单一真值源（仅 theme.mjs 出 SGR）', guardNoRawColorOutsideTheme],
  ['主题色板对比度达标', guardContrast],
  ['新模块行数预算 ≤500', guardLineBudget],
  ['过渡动画禁 transition:all（只动颜色/透明度/变换）', guardNoTransitionAll],
  ['文档站结构契约（中英对应 / 标记 / 依赖例外）', guardDocsSite],
  ['文档新鲜度（package.json 版本 ↔ README 标注）', guardDocsFreshness],
  ['架构地图覆盖 util/ 与 util/agent/ 模块', guardArchitectureMap],
];

export async function runGuardTests(test, assert) {
  console.log('\n仓库守卫');
  for (const [name, fn] of GUARDS) {
    await test(`守卫: ${name}`, () => { fn(); assert(true); });
  }
}
