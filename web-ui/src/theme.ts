/**
 * 主题偏好（跟随系统 / 浅色 / 深色），零依赖。
 *
 * 形态对齐 workbuddy-switch 的 theme.ts：三段式偏好 + localStorage 持久化 +
 * 系统主题变更监听。与既有实现的差别：最终落地成 <html data-theme> 属性，
 * tokens.css 只覆盖同名变量，组件代码零改动。
 *
 * 首帧防闪由 index.html 的内联脚本负责（在样式表生效前就定好 data-theme），
 * 本文件负责运行期切换与跟随系统。
 */
import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';

const THEME_STORAGE_KEY = 'auroraagent.theme';
const LEGACY_DARK_STORAGE_KEY = 'auroraagent.dark'; // 旧版布尔开关，一次性迁移后清除

export const THEME_OPTIONS: { id: ThemePreference; label: string }[] = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];

function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

export function getThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(stored)) return stored;
    const legacyDark = localStorage.getItem(LEGACY_DARK_STORAGE_KEY);
    if (legacyDark === '1') return 'dark';
    if (legacyDark === '0') return 'light';
  } catch { /* 存储不可用仍可跟随系统主题 */ }
  return 'system';
}

/** 当前是否深色：偏好为 dark，或跟随系统且系统是深色 */
export function prefersDark(preference: ThemePreference = getThemePreference()): boolean {
  if (preference === 'dark') return true;
  if (preference === 'light') return false;
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return true; }
}

export function applyTheme(preference: ThemePreference): void {
  const dark = prefersDark(preference);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
    localStorage.removeItem(LEGACY_DARK_STORAGE_KEY);
  } catch { /* 存储不可用仍立即应用当前选择 */ }
  applyTheme(preference);
}

/** 系统主题变化时，仅在「跟随系统」下重新落地 */
export function watchSystemTheme(): () => void {
  let media: MediaQueryList;
  try { media = window.matchMedia('(prefers-color-scheme: dark)'); } catch { return () => {}; }
  const onChange = () => { if (getThemePreference() === 'system') applyTheme('system'); };
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}

/** 设置页用的主题状态：读一次偏好，切换即落盘并应用 */
export function useThemePreference(): [ThemePreference, (next: ThemePreference) => void] {
  const [pref, setPref] = useState<ThemePreference>(() => getThemePreference());
  const choose = useCallback((next: ThemePreference) => { setThemePreference(next); setPref(next); }, []);
  useEffect(() => { applyTheme(pref); return watchSystemTheme(); }, [pref]);
  return [pref, choose];
}
