/** 顶部浮层（复刻 ZCode DesktopTopOverlay）：absolute left-0 top-0 常驻，盖在侧栏面板
 *  上方（宽度随动）；侧栏收回后浮到屏幕最左，入口一个不少。ZCode 规格：
 *   - 交互容器 = pointer-events-auto flex items-center gap-1（外层 pointer-events-none，
 *     只有按钮吃事件——空白处的点击仍归下面的侧栏品牌行）；
 *   - 切换钮是「group relative overflow-hidden rounded-lg」ghost 方钮：静止显 20px 品牌砖
 *     （group-hover:opacity-0），hover 淡入 16px 面板图标（absolute inset-0 m-auto 绝对居中，
 *     opacity-0 → group-hover:opacity-100），150ms 只动透明度，气泡挂 ControlTooltip；
 *   - 新建会话随 isNewTaskButtonVisible = showNewTaskButton ?? !isSidebarVisible 语义：
 *     侧栏可见时收起（transition-[opacity,width] 300ms ease-out），收回时展开；
 *   - 更新按钮：ZCode 的教训是「收起态不能继续按侧栏宽度阈值隐藏更新入口，用户会在最需要
 *     全局入口时反而看不到」——两种状态都常驻（仅发现有新版时出现）。 */
import { IconArrowLeft, IconArrowRight, IconMessageCirclePlus, IconPanelLeftClose, IconPanelLeftOpen, IconRefresh, IconSpark } from '../icons';
import { ControlTooltip } from '../ControlTooltip';
import { newSessionLabel, sidebarToggleLabel } from '../shortcut';
import type { Ref } from 'react';

type Props = {
  /** 浮层根节点引用：App 实测宽度供 Header 收回态让位。
   *  必须挂在浮层本身——外包容器是零宽 flex 项（absolute 子元素不参与其尺寸计算），
   *  量外包容器恒为 0，Header 的左侧让位会失效 */
  ref?: Ref<HTMLDivElement>;
  /** 侧栏是否已收回 */
  collapsed: boolean;
  onToggle: () => void;
  onNew: () => void;
  /** 上一个 / 下一个提问（会话回合导航；会话不足两轮时禁用） */
  onNav: (dir: 'prev' | 'next') => void;
  canNav: boolean;
  /** 发现新版本：发布页 URL 与版本号（null = 无更新，不渲染该钮） */
  updateUrl: string | null;
  updateLatest: string | null;
};

export function WorkspaceTopOverlay({ ref, collapsed, onToggle, onNew, onNav, canNav, updateUrl, updateLatest }: Props) {
  return (
    <div className="ws-overlay" ref={ref} aria-label="工作区快捷入口">
      <div className="ws-overlay-group">
        <ControlTooltip title="切换侧边栏" shortcut={sidebarToggleLabel()} side="bottom">
          <button type="button" className="ws-toggle" aria-label="切换侧边栏" onClick={onToggle}>
            <span className="ws-toggle-logo" aria-hidden="true"><IconSpark size={13} /></span>
            {collapsed ? <IconPanelLeftOpen size={16} className="ws-toggle-icon" /> : <IconPanelLeftClose size={16} className="ws-toggle-icon" />}
          </button>
        </ControlTooltip>
        <ControlTooltip title="上一个提问" shortcut="↑" side="bottom">
          <button type="button" className="ws-act" aria-label="上一个提问" disabled={!canNav} onClick={() => onNav('prev')}>
            <IconArrowLeft size={16} />
          </button>
        </ControlTooltip>
        <ControlTooltip title="下一个提问" shortcut="↓" side="bottom">
          <button type="button" className="ws-act" aria-label="下一个提问" disabled={!canNav} onClick={() => onNav('next')}>
            <IconArrowRight size={16} />
          </button>
        </ControlTooltip>
        {/* 新建任务：收回态才显（ZCode isNewTaskButtonVisible 语义；展开态侧栏里有新建任务钮）。
            图标用 lucide MessageCirclePlus 精确路径（ZCode 同款：聊天气泡 + 加号，不是裸加号） */}
        <div className={`ws-overlay-new${collapsed ? ' on' : ' off'}`} aria-hidden={!collapsed}>
          <ControlTooltip title="新建任务" shortcut={newSessionLabel()} side="bottom">
            <button type="button" className="ws-act" aria-label="新建任务" tabIndex={collapsed ? undefined : -1} onClick={onNew}>
              <IconMessageCirclePlus size={16} />
            </button>
          </ControlTooltip>
        </div>
        {updateUrl ? (
          <ControlTooltip title={`发现新版本 v${updateLatest}`} description="点击前往发布页查看" side="bottom">
            <button type="button" className="ws-act ws-upd" aria-label={`发现新版本 v${updateLatest}`} onClick={() => window.open(updateUrl, '_blank', 'noopener')}>
              <IconRefresh size={16} />
            </button>
          </ControlTooltip>
        ) : null}
      </div>
    </div>
  );
}
