/**
 * 外观偏好（界面字号 + 代码显示），零依赖。
 *
 * 复刻 ZCode 外观页（settingsPageConfig 的 appearance 一级目录）的全部选项：
 *  - 界面主题在 theme.ts（跟随系统 / 浅色 / 深色），本模块管其余全部；
 *  - 界面字号 12~20（ZCode uiFontSize）：只更新字号基准变量 --ui-font-size，
 *    不缩放根 font-size 以外的尺寸——图标、间距、圆角不受影响（ZCode 同纪律）；
 *  - 浅色 / 深色代码主题（ZCode lightTheme / darkTheme）：零依赖高亮器按类别
 *    上色（highlight.ts 的 c-key / c-str / c-num / c-com / c-fn / c-type），
 *    故「代码主题」落地为这六个 --code-* 令牌的调色板，不引 Shiki；
 *  - 显示行号 / 长行自动换行 / 代码字号（ZCode showLineNumbers / wrapLongLines / fontSize）。
 *
 * 落地形态：CSS 自定义属性 + documentElement dataset，既有组件零改动；
 * 迷你真外部存储（useSyncExternalStore）让 Markdown 的行号结构随改即变。
 * 首帧防闪由 index.html 内联脚本负责（字号 / 换行 / 行号在样式生效前落好；
 * 代码调色板表太大不进内联脚本，由 main.tsx 启动时补一次，同帧无感）。
 */
import { useCallback, useSyncExternalStore } from 'react';
import { prefersDark } from './theme';

export type CodeThemeId = 'aurora' | 'github' | 'vitesse' | 'catppuccin' | 'contrast';

/** 代码主题选项（ZCode CODE_PREVIEW_THEME_OPTIONS 同款家族，各配一套零依赖调色板） */
export const CODE_THEME_OPTIONS: { value: CodeThemeId; label: string }[] = [
  { value: 'aurora', label: '默认（Aurora）' },
  { value: 'github', label: 'GitHub' },
  { value: 'vitesse', label: 'Vitesse' },
  { value: 'catppuccin', label: 'Catppuccin' },
  { value: 'contrast', label: '高对比' },
];

export const CODE_TOKEN_KEYS = ['key', 'str', 'num', 'com', 'fn', 'type'] as const;
export type CodeTokenKey = (typeof CODE_TOKEN_KEYS)[number];
export type CodePalette = Record<CodeTokenKey, string>;

/** 各代码主题调色板：aurora 派生自主题令牌（随界面明暗翻转），其余按对应家族配色近似 */
const PALETTES: Record<CodeThemeId, { light: CodePalette; dark: CodePalette }> = {
  aurora: {
    light: { key: 'var(--accent-hi)', str: 'var(--ok-ink)', num: 'var(--think)', com: 'var(--faint)', fn: 'var(--text)', type: 'var(--think)' },
    dark: { key: 'var(--accent-hi)', str: 'var(--ok-ink)', num: 'var(--think)', com: 'var(--faint)', fn: 'var(--text)', type: 'var(--think)' },
  },
  github: {
    light: { key: '#cf222e', str: '#0a3069', num: '#0550ae', com: '#6e7781', fn: '#8250df', type: '#953800' },
    dark: { key: '#ff7b72', str: '#a5d6ff', num: '#79c0ff', com: '#8b949e', fn: '#d2a8ff', type: '#ffa657' },
  },
  vitesse: {
    light: { key: '#b9275f', str: '#4f9130', num: '#1f6f9f', com: '#a7b3bd', fn: '#3d7ced', type: '#a76165' },
    dark: { key: '#e5536b', str: '#a8d989', num: '#4cabfc', com: '#7f97b3', fn: '#5cb1f5', type: '#d78fd6' },
  },
  catppuccin: {
    light: { key: '#8839ef', str: '#40a02b', num: '#fe640b', com: '#9ca0b0', fn: '#1e66f5', type: '#df8e1d' },
    dark: { key: '#cba6f7', str: '#a6e3a1', num: '#fab387', com: '#6c7086', fn: '#89b4fa', type: '#f9e2af' },
  },
  contrast: {
    light: { key: '#a40e26', str: '#032f62', num: '#034fa1', com: '#59636e', fn: '#8250df', type: '#a95131' },
    dark: { key: '#ff9492', str: '#9be2ff', num: '#79c0ff', com: '#b3b1ad', fn: '#d2a8ff', type: '#ffa657' },
  },
};

export function codePalette(theme: CodeThemeId, mode: 'light' | 'dark'): CodePalette {
  return PALETTES[theme]?.[mode] || PALETTES.aurora[mode];
}

/** 调色板 → React 行内样式（预览卡用：容器级覆写 --code-*，内部渲染随变） */
export function paletteVars(palette: CodePalette): React.CSSProperties {
  return Object.fromEntries(CODE_TOKEN_KEYS.map((k) => [`--code-${k}`, palette[k]])) as React.CSSProperties;
}

export const MIN_FONT_SIZE_PX = 12;
export const MAX_FONT_SIZE_PX = 20;
export const DEFAULT_UI_FONT_SIZE_PX = 14;
export const DEFAULT_CODE_FONT_SIZE_PX = 13;

export interface AppearancePrefs {
  uiFontSize: number;
  codeLightTheme: CodeThemeId;
  codeDarkTheme: CodeThemeId;
  codeLineNumbers: boolean;
  codeWrap: boolean;
  codeFontSize: number;
}

/** 默认值刻意保持 AuroraAgent 现有观感：行号默认关、代码字号 13、调色板随主题令牌 */
export const DEFAULT_APPEARANCE_PREFS: AppearancePrefs = {
  uiFontSize: DEFAULT_UI_FONT_SIZE_PX,
  codeLightTheme: 'aurora',
  codeDarkTheme: 'aurora',
  codeLineNumbers: false,
  codeWrap: false,
  codeFontSize: DEFAULT_CODE_FONT_SIZE_PX,
};

const K = {
  uiFontSize: 'auroraagent.ui-font-size',
  codeLightTheme: 'auroraagent.code-theme-light',
  codeDarkTheme: 'auroraagent.code-theme-dark',
  codeLineNumbers: 'auroraagent.code-line-numbers',
  codeWrap: 'auroraagent.code-wrap',
  codeFontSize: 'auroraagent.code-font-size',
} as const;

function clampFontSize(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_FONT_SIZE_PX, Math.max(MIN_FONT_SIZE_PX, Math.round(n)));
}

function isCodeThemeId(value: string | null): value is CodeThemeId {
  return value !== null && CODE_THEME_OPTIONS.some((o) => o.value === value);
}

export function loadAppearance(): AppearancePrefs {
  const d = DEFAULT_APPEARANCE_PREFS;
  try {
    // 注意：localStorage 读不到是 null，Number(null) === 0 会被误当合法值钳成下限——
    // 必须先判空再转数（无偏好 = 默认值，不是 12px）
    const num = (key: string) => { const raw = localStorage.getItem(key); return raw === null ? Number.NaN : Number(raw); };
    const ui = num(K.uiFontSize);
    const codeFs = num(K.codeFontSize);
    const lt = localStorage.getItem(K.codeLightTheme);
    const dt = localStorage.getItem(K.codeDarkTheme);
    return {
      uiFontSize: Number.isFinite(ui) ? clampFontSize(ui, d.uiFontSize) : d.uiFontSize,
      codeLightTheme: isCodeThemeId(lt) ? lt : d.codeLightTheme,
      codeDarkTheme: isCodeThemeId(dt) ? dt : d.codeDarkTheme,
      codeLineNumbers: localStorage.getItem(K.codeLineNumbers) === '1',
      codeWrap: localStorage.getItem(K.codeWrap) === '1',
      codeFontSize: Number.isFinite(codeFs) ? clampFontSize(codeFs, d.codeFontSize) : d.codeFontSize,
    };
  } catch { return { ...d }; }
}

function saveAppearance(prefs: AppearancePrefs): void {
  try {
    localStorage.setItem(K.uiFontSize, String(prefs.uiFontSize));
    localStorage.setItem(K.codeLightTheme, prefs.codeLightTheme);
    localStorage.setItem(K.codeDarkTheme, prefs.codeDarkTheme);
    localStorage.setItem(K.codeLineNumbers, prefs.codeLineNumbers ? '1' : '0');
    localStorage.setItem(K.codeWrap, prefs.codeWrap ? '1' : '0');
    localStorage.setItem(K.codeFontSize, String(prefs.codeFontSize));
  } catch { /* 无痕模式等场景下静默：选择仍然当场生效 */ }
}

/** 把偏好落到文档上：字号基准变量 + 代码调色板 + 行号 / 换行 dataset */
export function applyAppearance(prefs: AppearancePrefs): void {
  const root = document.documentElement;
  root.style.setProperty('--ui-font-size', `${prefs.uiFontSize}px`);
  root.style.setProperty('--code-font-size', `${prefs.codeFontSize}px`);
  root.dataset.codeLn = prefs.codeLineNumbers ? 'on' : 'off';
  root.dataset.codeWrap = prefs.codeWrap ? 'on' : 'off';
  // 代码主题按界面当前明暗取对应半套；aurora 派生自主题令牌，无需按明暗区分
  const dark = prefersDark();
  const palette = codePalette(dark ? prefs.codeDarkTheme : prefs.codeLightTheme, dark ? 'dark' : 'light');
  for (const key of CODE_TOKEN_KEYS) root.style.setProperty(`--code-${key}`, palette[key]);
}

let current: AppearancePrefs = loadAppearance();
const listeners = new Set<() => void>();

export function getAppearance(): AppearancePrefs { return current; }

export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function updateAppearance(patch: Partial<AppearancePrefs>): void {
  current = { ...current, ...patch };
  saveAppearance(current);
  applyAppearance(current);
  for (const listener of listeners) listener();
}

/** 组件侧入口：读当前偏好 + 打补丁（落盘、应用、通知订阅方一气呵成） */
export function useAppearance(): [AppearancePrefs, (patch: Partial<AppearancePrefs>) => void] {
  const prefs = useSyncExternalStore(subscribeAppearance, getAppearance);
  const update = useCallback((patch: Partial<AppearancePrefs>) => updateAppearance(patch), []);
  return [prefs, update];
}

/** 启动时补一次落地 + 系统主题翻转时重选代码调色板（index.html 首帧脚本的运行期搭档） */
export function watchAppearance(): () => void {
  applyAppearance(current);
  let media: MediaQueryList;
  try { media = window.matchMedia('(prefers-color-scheme: dark)'); } catch { return () => {}; }
  const onChange = () => applyAppearance(current);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
