/** 设置「外观」section（复刻 ZCode SettingsPage 的 appearance 一级目录）：
 *  ZCode 规格原文：section = Palette 图标 +「外观」标题；内容 = h3「界面设置」+ 描述段，
 *  下面一张 Card（border + bg-card + shadow-none）里排 SettingsRow——
 *  标签 14px/500 + 描述 13px/leading-6 三次色在左、控件在右，行间 1px 分隔（first 无分隔）。
 *  主题行（ZCode settings.themeMode）控件是 Select 下拉（trigger h-8 rounded-lg 输入框形态、
 *  260px 宽，选项带 Monitor / Moon / Sun 图标 + 对勾指示），不是分段按钮——
 *  选项带图标时分段控件排不下，且下拉与设置页其它选择器语言一致。
 *  主题偏好本身沿用 theme.ts（跟随系统 / 浅色 / 深色，localStorage 持久化 + 首帧防闪），
 *  零依赖，不引第三方状态管理。 */
import { useThemePreference } from '../theme';
import { Select, type SelectOption } from '../Select';
import { IconMonitor, IconMoon, IconSun } from '../icons';

/** 主题选项（ZCode THEME_MODES 同序：系统 / 深色 / 浅色，各带图标） */
const THEME_OPTIONS: SelectOption[] = [
  { value: 'system', label: '系统', icon: <IconMonitor size={16} /> },
  { value: 'dark', label: '深色', icon: <IconMoon size={16} /> },
  { value: 'light', label: '浅色', icon: <IconSun size={16} /> },
];

export function AppearancePanel() {
  const [themePref, chooseTheme] = useThemePreference();
  return (
    <div className="ap-block">
      <div className="ap-head">
        <h4 className="ap-title">界面设置</h4>
        <p className="ap-desc">设置应用主题；选择只影响本机浏览器，不同步服务端。</p>
      </div>
      <div className="ap-card">
        <div className="ap-row">
          <div className="ap-row-text">
            <span className="ap-row-t">界面主题</span>
            <span className="ap-row-d">选择浅色、深色或跟随系统主题。</span>
          </div>
          <Select
            value={themePref}
            options={THEME_OPTIONS}
            onChange={(v) => chooseTheme(v as typeof themePref)}
            ariaLabel="界面主题"
            width={260}
          />
        </div>
      </div>
    </div>
  );
}
