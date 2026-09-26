/**
 * 仓库守卫（对齐 kimi-code 的 guard 思路，零依赖）：产品零 emoji、TUI 颜色单一真值源、
 * 主题对比度、新模块行数预算。由 run-tests.mjs 注入 test/assert/eq 后调用，
 * 也可经 tools/guard.mjs 独立运行（npm run guard）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
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

export const GUARDS = [
  ['产品源码零 emoji', guardNoEmoji],
  ['TUI 颜色单一真值源（仅 theme.mjs 出 SGR）', guardNoRawColorOutsideTheme],
  ['主题色板对比度达标', guardContrast],
  ['新模块行数预算 ≤500', guardLineBudget],
];

export async function runGuardTests(test, assert) {
  console.log('\n仓库守卫');
  for (const [name, fn] of GUARDS) {
    await test(`守卫: ${name}`, () => { fn(); assert(true); });
  }
}
