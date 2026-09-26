/**
 * 终端主题：语义色板（暗 / 亮双调）+ 对比度审计 + 每帧从当前色板生成的 Painter。
 * 这是全仓库唯一允许出现原始 SGR 颜色码的文件（守卫 tools/guard.mjs 强制）。
 * token 命名对齐 kimi-code ColorPalette；新增语义必须先加 token 并补齐两套色板，
 * 组件一律 chalk.hex(colors.<token>) 等价物 painter.<token>(text)，禁止 named color。
 */
const ESC = '\x1b[';
const RESET = `${ESC}0m`;

/** 语义 token 全集（色板必须全覆盖） */
export const TOKEN_NAMES = [
  'bg', 'primary', 'accent', 'text', 'textStrong', 'textDim', 'textMuted',
  'border', 'borderFocus', 'success', 'warning', 'error',
  'diffAdded', 'diffRemoved', 'diffAddedStrong', 'diffRemovedStrong', 'diffGutter', 'diffMeta',
  'roleUser', 'shellMode', 'think', 'status',
];

/** 暗色（默认，取自 web-ui tokens.css 的暗色基调） */
const DARK = {
  bg: '#0e1014',
  primary: '#4d8df6', accent: '#6ba4f8',
  text: '#e8ebf2', textStrong: '#ffffff', textDim: '#9aa2b4', textMuted: '#7b8399',
  border: '#3f4759', borderFocus: '#4d8df6',
  success: '#4ec97f', warning: '#e8b339', error: '#ff6b6b',
  diffAdded: '#4ec97f', diffRemoved: '#ff6b6b', diffAddedStrong: '#8fe3b4', diffRemovedStrong: '#ff9a9a',
  diffGutter: '#7b8399', diffMeta: '#6ba4f8',
  roleUser: '#c78ce8', shellMode: '#e8b339', think: '#5ec8d8', status: '#9aa2b4',
};

/** 亮色（文本对白底 ≥4.5:1，边框与大件 ≥3:1） */
const LIGHT = {
  bg: '#f5f6f8',
  primary: '#2a63bd', accent: '#2a63bd',
  text: '#1a1d24', textStrong: '#000000', textDim: '#545b6b', textMuted: '#5d6478',
  border: '#78829a', borderFocus: '#2f6fd6',
  success: '#157a40', warning: '#8a6508', error: '#c02626',
  diffAdded: '#157a40', diffRemoved: '#c02626', diffAddedStrong: '#166e3f', diffRemovedStrong: '#9a1f1f',
  diffGutter: '#5d6478', diffMeta: '#2f6fd6',
  roleUser: '#8b3fb0', shellMode: '#8a6508', think: '#12707d', status: '#545b6b',
};

export const PALETTES = { dark: DARK, light: LIGHT };

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  if (!Number.isFinite(n) || full.length !== 6) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function relLuminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** WCAG 对比度 */
export function contrastRatio(a, b) {
  const la = relLuminance(a);
  const lb = relLuminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** 'auto' 依据终端背景猜测（缺省暗）；显式 dark / light 直接采用 */
export function resolveThemeName(choice, env = process.env) {
  if (choice === 'light' || choice === 'dark') return choice;
  const fg = String(env.COLORFGBG || '');
  if (/;15\b/.test(fg) || /;white\b/i.test(fg)) return 'light';
  return 'dark';
}

export function paletteFor(choice, env = process.env) {
  const name = resolveThemeName(choice, env);
  return { name, colors: PALETTES[name] };
}

/** 从当前色板生成 Painter（每次渲染新建，主题切换当帧生效；勿在模块顶层缓存） */
export function createPainter(colors) {
  const palette = colors && colors.primary ? colors : PALETTES.dark;
  const token = (t) => palette[t] || palette.text;
  const wrap = (codes, s) => `${ESC}${codes}m${String(s ?? '')}${RESET}`;
  const fgCode = (t) => { const { r, g, b } = hexToRgb(token(t)); return `38;2;${r};${g};${b}`; };
  const bgCode = (t) => { const { r, g, b } = hexToRgb(token(t)); return `48;2;${r};${g};${b}`; };
  const fg = (t) => (s) => wrap(fgCode(t), s);
  const bg = (t) => (s) => wrap(bgCode(t), s);
  const paint = (t, s) => wrap(fgCode(t), s);
  const bold = (t, s) => wrap(`1;${fgCode(t)}`, s);
  const underline = (t, s) => wrap(`4;${fgCode(t)}`, s);
  const api = { palette, fg, bg, paint, bold, underline, RESET };
  for (const t of TOKEN_NAMES) api[t] = fg(t);
  api.dim = fg('textDim');
  api.muted = fg('textMuted');
  api.styles = {
    primary: fg('primary'), accent: fg('accent'), text: fg('text'), strong: fg('textStrong'),
    dim: fg('textDim'), muted: fg('textMuted'), success: fg('success'), warning: fg('warning'),
    error: fg('error'), think: fg('think'),
  };
  return api;
}

/** 对比度审计：文本类 ≥4.5、次要 ≥3、边框 ≥1.5、聚焦边框 ≥3（守卫与文档共用） */
const TEXT_TOKENS = ['text', 'textStrong', 'primary', 'accent', 'success', 'warning', 'error', 'think', 'roleUser', 'shellMode', 'status', 'diffAdded', 'diffRemoved', 'diffAddedStrong', 'diffRemovedStrong'];
const SECONDARY_TOKENS = ['textDim', 'textMuted', 'diffGutter', 'diffMeta'];

export function auditPalette(colors) {
  const bg = colors.bg;
  const issues = [];
  for (const t of TEXT_TOKENS) {
    const r = contrastRatio(colors[t], bg);
    if (r < 4.5) issues.push({ token: t, ratio: Number(r.toFixed(2)), min: 4.5 });
  }
  for (const t of SECONDARY_TOKENS) {
    const r = contrastRatio(colors[t], bg);
    if (r < 3) issues.push({ token: t, ratio: Number(r.toFixed(2)), min: 3 });
  }
  for (const t of ['border']) {
    const r = contrastRatio(colors[t], bg);
    if (r < 1.5) issues.push({ token: t, ratio: Number(r.toFixed(2)), min: 1.5 });
  }
  for (const t of ['borderFocus']) {
    const r = contrastRatio(colors[t], bg);
    if (r < 3) issues.push({ token: t, ratio: Number(r.toFixed(2)), min: 3 });
  }
  return issues;
}
