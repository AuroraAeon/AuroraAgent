/** 设置「外观」section（复刻 ZCode SettingsPage 的 appearance 一级目录全量选项）：
 *  ZCode 规格原文：section = Palette 图标 +「外观」标题；内容三段——
 *   - h3「界面设置」+ 描述，Card（border + bg-card + shadow-none）里排 SettingsRow：
 *     界面主题（Select，trigger h-8 rounded-lg 输入框形态、260px）+ 界面字号（FontSizeInput 12~20）；
 *   - h3「代码设置」+ 描述，Card 里排：浅色 / 深色代码主题（各一个 Select）、
 *     显示行号（Switch）、长行自动换行（Switch）、代码字号（FontSizeInput 12~20）；
 *   - h3「代码预览」+ 描述，浅色 / 深色两张 ThemePreviewCard 并排，当前界面明暗对应的那张标「当前生效」。
 *  SettingsRow 形态：左标签 14px/500 + 描述 13px/leading-6 三次色，右控件 justify-end，行间 1px 分隔（first 无分隔）。
 *  主题偏好沿用 theme.ts、其余偏好走 appearance.ts（localStorage 持久化 + 首帧防闪），零依赖。 */
import { Markdown } from '../markdown';
import { useThemePreference } from '../theme';
import { prefersDark } from '../theme';
import { useAppearance, CODE_THEME_OPTIONS, codePalette, paletteVars, MIN_FONT_SIZE_PX, MAX_FONT_SIZE_PX } from '../appearance';
import { NumberField } from '../NumberField';
import { Select, type SelectOption } from '../Select';
import { Switch } from '../Switch';
import { IconMonitor, IconMoon, IconSun } from '../icons';

/** 主题选项（ZCode THEME_MODES 同序：系统 / 深色 / 浅色，各带图标） */
const THEME_OPTIONS: SelectOption[] = [
  { value: 'system', label: '系统', icon: <IconMonitor size={16} /> },
  { value: 'dark', label: '深色', icon: <IconMoon size={16} /> },
  { value: 'light', label: '浅色', icon: <IconSun size={16} /> },
];

/** 预览样例：覆盖关键字 / 字符串 / 数字 / 注释 / 函数 / 类型六个高亮类别 */
const PREVIEW_CODE = '```ts\nfunction greet(name: string): number {\n  // 统计下一轮迭代\n  const count = name.length + 1;\n  return count;\n}\n```';

export function AppearancePanel() {
  const [themePref, chooseTheme] = useThemePreference();
  const [prefs, update] = useAppearance();
  const dark = prefersDark(themePref);

  return (
    <div className="ap-block">
      <div className="ap-head">
        <h4 className="ap-title">界面设置</h4>
        <p className="ap-desc">设置应用主题和界面文字大小。</p>
      </div>
      <div className="ap-card">
        <div className="ap-row">
          <div className="ap-row-text">
            <span className="ap-row-t">界面主题</span>
            <span className="ap-row-d">选择浅色、深色或跟随系统主题。</span>
          </div>
          <Select value={themePref} options={THEME_OPTIONS} onChange={(v) => chooseTheme(v as typeof themePref)} ariaLabel="界面主题" width={260} />
        </div>
        <div className="ap-row">
          <div className="ap-row-text">
            <span className="ap-row-t">界面字号</span>
            <span className="ap-row-d">调整应用界面的文字大小，图标和布局尺寸不受影响。</span>
          </div>
          <NumberField
            value={prefs.uiFontSize}
            min={MIN_FONT_SIZE_PX}
            max={MAX_FONT_SIZE_PX}
            onChange={(uiFontSize) => update({ uiFontSize })}
            ariaLabel="界面字号"
          />
        </div>
      </div>

      <div className="ap-head">
        <h4 className="ap-title">代码设置</h4>
        <p className="ap-desc">设置代码内容的主题、字号和显示方式，不受界面字号影响。</p>
      </div>
      <div className="ap-card">
        <div className="ap-row">
          <div className="ap-row-text">
            <span className="ap-row-t">浅色代码主题</span>
            <span className="ap-row-d">浅色界面下代码内容使用的高亮主题。</span>
          </div>
          <Select
            value={prefs.codeLightTheme}
            options={CODE_THEME_OPTIONS}
            onChange={(v) => update({ codeLightTheme: v as typeof prefs.codeLightTheme })}
            ariaLabel="浅色代码主题"
            width={260}
          />
        </div>
        <div className="ap-row">
          <div className="ap-row-text">
            <span className="ap-row-t">深色代码主题</span>
            <span className="ap-row-d">深色界面下代码内容使用的高亮主题。</span>
          </div>
          <Select
            value={prefs.codeDarkTheme}
            options={CODE_THEME_OPTIONS}
            onChange={(v) => update({ codeDarkTheme: v as typeof prefs.codeDarkTheme })}
            ariaLabel="深色代码主题"
            width={260}
          />
        </div>
        <div className="ap-row">
          <div className="ap-row-text">
            <span className="ap-row-t">显示行号</span>
            <span className="ap-row-d">在代码块左侧显示行号。</span>
          </div>
          <Switch checked={prefs.codeLineNumbers} onChange={(codeLineNumbers) => update({ codeLineNumbers })} ariaLabel="显示行号" />
        </div>
        <div className="ap-row">
          <div className="ap-row-text">
            <span className="ap-row-t">长行自动换行</span>
            <span className="ap-row-d">代码内容过长时自动换行，不做横向滚动。</span>
          </div>
          <Switch checked={prefs.codeWrap} onChange={(codeWrap) => update({ codeWrap })} ariaLabel="长行自动换行" />
        </div>
        <div className="ap-row">
          <div className="ap-row-text">
            <span className="ap-row-t">代码字号</span>
            <span className="ap-row-d">调整代码块的默认字号。</span>
          </div>
          <NumberField
            value={prefs.codeFontSize}
            min={MIN_FONT_SIZE_PX}
            max={MAX_FONT_SIZE_PX}
            onChange={(codeFontSize) => update({ codeFontSize })}
            ariaLabel="代码字号"
          />
        </div>
      </div>

      <div className="ap-head">
        <h4 className="ap-title">代码预览</h4>
        <p className="ap-desc">同时预览浅色与深色代码主题，当前界面使用的主题会标记为「当前生效」。</p>
      </div>
      <div className="ap-prevs">
        <div className="ap-prev" data-mode="light" style={paletteVars(codePalette(prefs.codeLightTheme, 'light'))}>
          <div className="ap-prev-head">
            <span className="ap-prev-t">浅色预览</span>
            {dark ? null : <span className="ap-prev-badge">当前生效</span>}
          </div>
          <Markdown text={PREVIEW_CODE} />
        </div>
        <div className="ap-prev" data-mode="dark" style={paletteVars(codePalette(prefs.codeDarkTheme, 'dark'))}>
          <div className="ap-prev-head">
            <span className="ap-prev-t">深色预览</span>
            {dark ? <span className="ap-prev-badge">当前生效</span> : null}
          </div>
          <Markdown text={PREVIEW_CODE} />
        </div>
      </div>
    </div>
  );
}
