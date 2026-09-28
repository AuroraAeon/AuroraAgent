/** 工作台 Header（逐像素复刻 ZCode WorkspaceHeader + DesktopTopOverlay 的规格）。
 *  ZCode 的真实语义：侧栏收回后左侧边整体消失，只剩这条 48px header 承载全部入口
 *  （WorkspaceHeader h-12 + border-b；入口按 DesktopTopOverlay 的
 *  `isNewTaskButtonVisible ?? !isSidebarVisible` 收进顶部浮层）。逐项对齐的数值：
 *   - header：h-12 + border-b + shrink-0 + w-full；内行 h-12 / p-2 / items-center /
 *     justify-between / gap-2 / overflow-hidden；
 *   - 左组 gap-1：切换钮与新建钮都是 Button ghost icon-md——28px + rounded-lg，
 *     且只过渡颜色（ZCode 踩过 transition-all 让缩放窗口时按钮尺寸也被动画化的坑）；
 *   - 右组 gap-0.5：设置入口同规格。
 *  切换钮是 ZCode 那枚「静止显 size-5 品牌砖、hover 淡出并淡入 size-4 面板图标」的
 *  ghost 方钮，收回态取「打开面板」语义的 IconPanelLeftOpen；气泡挂 ControlTooltip
 *  显示「切换侧边栏 + ⌘B/Ctrl+B」。新建钮带 ⌘K/Ctrl+K 提示（对齐 ZCode newTaskShortcutLabel）。
 *  组件常驻不卸载：展开态高 0 + 淡出 + inert，height / opacity / box-shadow（分隔线走
 *  inset 阴影，border 在 height:0 时仍占位）与侧栏「擦除」同拍 200ms ease-out，
 *  两段动画观感是一体的。 */
import { IconGear, IconPanelLeftOpen, IconPlus, IconSpark } from '../icons';
import { ControlTooltip } from '../ControlTooltip';
import { newSessionLabel, sidebarToggleLabel } from '../shortcut';

type Props = {
  /** 侧栏是否已收回（true = 只留 header 的态） */
  collapsed: boolean;
  onToggle: () => void;
  onNew: () => void;
  onOpenSettings: () => void;
};

export function WorkspaceHeader({ collapsed, onToggle, onNew, onOpenSettings }: Props) {
  return (
    <header
      className={`ws-head${collapsed ? ' on' : ''}`}
      data-collapsed={collapsed ? 'true' : undefined}
      aria-hidden={collapsed ? undefined : true}
      inert={!collapsed}
    >
      <div className="ws-head-row">
        <div className="ws-head-left">
          <ControlTooltip title="切换侧边栏" shortcut={sidebarToggleLabel()} side="bottom">
            <button type="button" className="ws-toggle" aria-label="切换侧边栏" onClick={onToggle}>
              <span className="ws-toggle-logo" aria-hidden="true"><IconSpark size={13} /></span>
              <IconPanelLeftOpen size={16} className="ws-toggle-icon" />
            </button>
          </ControlTooltip>
          <ControlTooltip title="新会话" shortcut={newSessionLabel()} side="bottom">
            <button type="button" className="ws-act" aria-label="新会话" onClick={onNew}>
              <IconPlus size={16} />
            </button>
          </ControlTooltip>
        </div>
        <div className="ws-head-right">
          <ControlTooltip title="设置" side="bottom">
            <button type="button" className="ws-act ws-act-dim" aria-label="设置" onClick={onOpenSettings}>
              <IconGear size={16} />
            </button>
          </ControlTooltip>
        </div>
      </div>
    </header>
  );
}
