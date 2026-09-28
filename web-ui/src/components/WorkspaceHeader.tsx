/** 工作台 Header（复刻 ZCode WorkspaceHeader 的职责与节奏）。
 *  ZCode 的真实语义：侧栏收回后左侧边整体消失，只剩这条 48px header 承载全部入口
 *  （WorkspaceHeader h-12 + border-b，DesktopTopOverlay 的 isNewTaskButtonVisible ?? !isSidebarVisible）。
 *  因此这里的切换钮与侧栏收起动画同拍出现，用的是 ZCode 那枚 28px ghost 方钮：
 *  静止显 20px 品牌砖，hover 淡出并淡入 16px 面板图标（收回态取「打开面板」语义的
 *  IconPanelLeftOpen），气泡挂 ControlTooltip 显示「切换侧边栏 + ⌘B/Ctrl+B」。
 *  组件常驻不卸载：展开态高度 0 + 淡出 + inert，靠 height / opacity 过渡完成双向动画，
 *  于是「侧栏擦除」与「header 生长」是同一段 200ms ease-out，观感是一体的。 */
import { IconGear, IconPanelLeftOpen, IconPlus, IconSpark } from '../icons';
import { ControlTooltip } from '../ControlTooltip';
import { sidebarToggleLabel } from '../shortcut';

type Props = {
  /** 侧栏是否已收回（true = 只留 header 的态） */
  collapsed: boolean;
  onToggle: () => void;
  onNew: () => void;
  onOpenSettings: () => void;
  version: string;
};

export function WorkspaceHeader({ collapsed, onToggle, onNew, onOpenSettings, version }: Props) {
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
          <button type="button" className="ws-new" onClick={onNew} title="新会话">
            <IconPlus size={14} />
            <span className="ws-new-label">新会话</span>
          </button>
        </div>
        <div className="ws-head-right">
          <span className="ws-ver">v{version}</span>
          <ControlTooltip title="设置" side="bottom">
            <button type="button" className="ws-iconbtn" aria-label="设置" onClick={onOpenSettings}>
              <IconGear size={16} />
            </button>
          </ControlTooltip>
        </div>
      </div>
    </header>
  );
}
