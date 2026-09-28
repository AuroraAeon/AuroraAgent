/** 侧栏：像素级对齐 dsh web 的 SidebarRoot + WorkspaceBrowser 组合。
 *  数值自 @deepseek-ai/dsh-client-ui-sidebar 与 dsh-client-ui-workspace 的 CSS 模块迁移：
 *  栏宽 280px（右侧圆钮可整块收起：收回后左边只留 Header，偏好落 localStorage）、内边距 6px 12px、基准字号 14px；
 *  品牌行 60px（24px 标 + 18px/600 名 + 右侧 28px 圆钮，点品牌即新建会话——同 dsh）；
 *  新建会话钮 38px / 圆角 12px / 细描边 / 悬浮底 / 14px/500；
 *  会话区：36px 区头（「会话」标签 + 可展开搜索）+ 32px 行（圆角 8px、悬停底色、14px 标题、
 *  12px 相对时间悬停隐去、16px 操作钮悬停现形）；栏脚是 panelRow 形态的设置入口。
 *
 *  折叠后侧栏整块消失（ZCode 语义：不存在左侧边，只剩 WorkspaceHeader 承载入口），
 *  品牌行这枚 28px 圆钮即展开态唯一的切换入口，图标取「关闭面板」语义的 IconPanelLeftClose，
 *  气泡挂 ControlTooltip 显示「切换侧边栏 + ⌘B/Ctrl+B」（Cmd/Ctrl+B 快捷键在 App 绑定）。 */
import { useRef, useState } from 'react';
import { IconClose, IconCopy, IconGear, IconPanelLeftClose, IconPlus, IconSearch, IconSpark, IconTrash } from '../icons';
import { ControlTooltip } from '../ControlTooltip';
import { sidebarToggleLabel } from '../shortcut';
import { fmtRel } from '../projection';
import type { SessionMeta } from '../types';

type Props = {
  sessions: SessionMeta[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onFork: (id: string) => void;
  onOpenSettings: () => void;
  /** 首屏会话列表未回：显示骨架行，别把「加载中」显示成「还没有会话」 */
  loading?: boolean;
  version: string;
  /** 收回侧栏（受控：偏好持久化与 Ctrl/Cmd+B 快捷键都在 App 侧）；
   *  收回态由 App 把本组件连同裁剪容器一起淡出，这里不再有图标态变体。 */
  onToggleRail: () => void;
};

export function Sidebar({
  sessions, currentId, onSelect, onNew, onDelete, onFork, onOpenSettings, loading, version, onToggleRail,
}: Props) {
  const [q, setQ] = useState('');
  const [searchOn, setSearchOn] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const kw = q.trim().toLowerCase();
  const shown = kw ? sessions.filter((s) => (s.name || '').toLowerCase().includes(kw)) : sessions;

  const openSearch = () => { setSearchOn(true); setTimeout(() => searchRef.current?.focus(), 0); };
  const closeSearch = () => { setSearchOn(false); setQ(''); };

  return (
    <aside className="sidebar">
      <div className="sb-logo">
        <button type="button" className="sb-brand" aria-label="新建会话" onClick={onNew}>
          <span className="sb-brand-mark" aria-hidden="true"><IconSpark size={15} /></span>
          <span className="sb-brand-name">AuroraAgent</span>
        </button>
        <ControlTooltip title="切换侧边栏" shortcut={sidebarToggleLabel()} side="bottom">
          <button
            type="button"
            className="sb-iconbtn sb-toggle"
            aria-label="切换侧边栏"
            onClick={onToggleRail}
          >
            <IconPanelLeftClose size={16} />
          </button>
        </ControlTooltip>
      </div>
      <button type="button" className="sb-new" onClick={onNew} title="新会话">
        <IconPlus size={14} />
        <span className="sb-new-label">新会话</span>
      </button>
      <div className="sb-region">
        <div className="sb-sechead">
          <span className="sb-seclabel">会话</span>
          <div className={`sb-search${searchOn ? ' on' : ''}`}>
            <button type="button" className="sb-search-btn" aria-label="搜索会话" title="搜索会话" onClick={openSearch}>
              <IconSearch size={16} />
            </button>
            <input
              ref={searchRef}
              className="sb-search-input"
              type="text"
              value={q}
              placeholder="搜索会话"
              aria-label="搜索会话"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeSearch(); } }}
            />
            {q ? (
              <button type="button" className="sb-search-clear" aria-label="清空搜索" title="清空搜索" onClick={closeSearch}>
                <IconClose size={12} />
              </button>
            ) : null}
          </div>
        </div>
        <nav className="sb-list" aria-label="会话列表" aria-busy={loading ? 'true' : undefined}>
          {loading ? [0, 1, 2].map((i) => (
            <div className="sb-skel" key={i} aria-hidden="true">
              <span className="sb-skel-line w1" />
              <span className="sb-skel-line w2" />
            </div>
          )) : null}
          {!loading && sessions.length === 0 ? <div className="sb-empty">还没有会话</div> : null}
          {!loading && sessions.length > 0 && shown.length === 0 ? <div className="sb-empty">无匹配会话</div> : null}
          {shown.map((s) => (
            <div key={s.id} className={`sb-row${s.id === currentId ? ' on' : ''}`}>
              <button
                type="button"
                className="sb-row-main"
                aria-current={s.id === currentId ? 'true' : undefined}
                title={`${s.name || '新会话'}${s.preview ? ` · ${s.preview}` : ''}`}
                onClick={() => onSelect(s.id)}
              >
                <span className="sb-row-title">{s.name || '新会话'}</span>
                <span className="sb-row-time">{fmtRel(s.updatedAt)}</span>
              </button>
              <span className="sb-row-acts">
                <button
                  type="button"
                  className="sb-act"
                  title="派生会话（复制历史到新会话）"
                  aria-label={`派生会话 ${s.name || ''}`}
                  onClick={(ev) => { ev.stopPropagation(); onFork(s.id); }}
                >
                  <IconCopy size={14} />
                </button>
                <button
                  type="button"
                  className="sb-act sb-act-del"
                  title="删除会话"
                  aria-label={`删除会话 ${s.name || ''}`}
                  onClick={(ev) => { ev.stopPropagation(); onDelete(s.id); }}
                >
                  <IconTrash size={14} />
                </button>
              </span>
            </div>
          ))}
        </nav>
      </div>
      <div className="sb-foot">
        <button type="button" className="sb-foot-row" onClick={onOpenSettings} title="设置">
          <IconGear size={16} />
          <span className="sb-foot-label">设置</span>
          <span className="sb-ver">v{version}</span>
        </button>
      </div>
    </aside>
  );
}
