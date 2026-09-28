/** 工作台 Header（像素级复刻 ZCode WorkspaceHeader + WorkspaceHeaderSections）：
 *  ZCode 规格原文：header = relative w-full shrink-0 h-12 border-b；内行 = flex h-12 flex-1
 *  min-w-0 items-center justify-between gap-2 overflow-hidden p-2；标题区按内容占宽不铺满
 *  （父级是拖拽区，铺满会让空白处无法拖动）；操作区 = flex shrink-0 items-center gap-0.5。
 *  入口钮统一 Button ghost icon-md：28px + rounded-lg + 只过渡颜色（ZCode 注释：基础钮的
 *  transition-all 会在缩放窗口时把尺寸变化也动画化，这里只要色彩过渡）。
 *  标题区（ZCode WorkspaceHeaderTitleSection 形态）：
 *   - 工作区上下文钮（folder 图标，ghost icon-md）：hover 即显信息卡、点击 pin，
 *     卡内三行——工作目录（home 缩写）、最近活动、git 分支（ZCode WorkspaceContextPath
 *     + WorkspaceLastActivity + 分支行；分支由 GET /api/workspace 零依赖直读 .git/HEAD）；
 *   - 会话标题 h1：14px/600、truncate、max-w 400px（ZCode max-w-100），容器查询窄档
 *     30vw / 22vw；双击标题或在更多菜单选「重命名」进原位编辑（Enter 提交 / Esc 取消）；
 *   - 更多菜单（ellipsis，DropdownMenu 语义）：重命名 / 复制会话 ID / 复制工作目录 /
 *     派生 / 删除（ZCode TaskActionMenuContent 子集：pin / archive / split 无对应概念不移植）。
 *  操作区：帮助菜单（CircleHelp）——文档 / 反馈外链 + 快捷键与关于两个信息面板
 *  （ZCode WorkspaceHelpMenuButton 子集：community / issue / resource manager / about），
 *  设置入口（Gear）。组件常驻不卸载：侧栏收回时左边整体消失只留 overlay 与这条 header，
 *  此时内行加左侧内距给 overlay 让位（ZCode shouldOffsetHeaderForWindowControls 同思路）。 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconClock, IconCopy, IconEllipsis, IconFilePlus, IconFolder, IconGear, IconGitBranch,
  IconInfo, IconKeyboard, IconPencil, IconRefresh, IconSpark, IconTrash, IconBookOpen, IconCircleHelp,
} from '../icons';
import { ControlTooltip } from '../ControlTooltip';
import { Menu, MenuItem, MenuSeparator } from '../Menu';
import { getWorkspace } from '../api';
import { fmtRel } from '../projection';
import { toast } from '../toast';
import type { SessionMeta, WorkspaceInfo } from '../types';

const REPO_URL = 'https://github.com/AuroraAeon/AuroraAgent';

/** 路径 home 缩写（ZCode formatWorkspaceContextPath：~/ 代替主目录前缀） */
export function abbreviateHome(path: string, home: string): string {
  if (!home) return path;
  if (path === home) return '~';
  if (path.startsWith(home.endsWith('/') ? home : home + '/')) return `~${path.slice(home.length)}`;
  return path;
}

type Props = {
  session: SessionMeta | null;
  version: string;
  /** 侧栏收回态：内行加左侧内距给顶部浮层让位 */
  collapsed: boolean;
  overlayInset: number;
  onRename: (name: string) => void | Promise<void>;
  onFork: () => void;
  onDelete: () => void;
  onOpenSettings: () => void;
  onCheckUpdate: () => void;
};

export function WorkspaceHeader({ session, version, collapsed, overlayInset, onRename, onFork, onDelete, onOpenSettings, onCheckUpdate }: Props) {
  // 工作区信息卡：hover 即显 + 点击 pin（ZCode workspaceContextOpen 受控模式）；
  // 卡内容懒拉取，按工作目录缓存，切会话不重复请求
  const [ctxHover, setCtxHover] = useState(false);
  const [ctxPinned, setCtxPinned] = useState(false);
  const [wsCache, setWsCache] = useState<Record<string, WorkspaceInfo>>({});
  const ctxVisible = ctxHover || ctxPinned;
  const wsPath = session?.workspace || '';
  const wsInfo = wsPath ? wsCache[wsPath] : undefined;

  useEffect(() => {
    if (!ctxVisible || !wsPath || wsCache[wsPath]) return;
    let dead = false;
    getWorkspace(wsPath)
      .then((info) => { if (!dead) setWsCache((prev) => ({ ...prev, [wsPath]: info })); })
      .catch(() => { /* 拉不到不挡事：卡片照样显示路径与活动时间 */ });
    return () => { dead = true; };
  }, [ctxVisible, wsPath, wsCache]);

  // 标题原位重命名（ZCode TaskRenameDialog 的轻量替代：单行编辑，Enter 提交 / Esc 取消）
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);
  const title = session?.name || '新会话';

  const startRename = () => { setDraft(title); setRenaming(true); setTimeout(() => renameRef.current?.select(), 0); };
  const commitRename = () => {
    const name = draft.trim();
    setRenaming(false);
    if (name && name !== title) void onRename(name);
  };

  const copy = async (text: string, ok: string) => {
    try { await navigator.clipboard.writeText(text); toast.success(ok); }
    catch { toast.error('复制失败', { description: '浏览器拒绝了剪贴板访问，可手动选择文本复制' }); }
  };

  // 帮助菜单面板：root / 快捷键 / 关于（ZCode 帮助菜单的信息项落在本地面板，不外跳）
  const [helpPane, setHelpPane] = useState<'root' | 'shortcuts' | 'about'>('root');
  const shortcuts: [string, string][] = [
    ['Ctrl/Cmd+K', '新建会话'],
    ['Ctrl/Cmd+B', '切换侧边栏'],
    ['Ctrl+/', '主 / 侧边对话切换'],
    ['/', '聚焦输入框'],
    ['Esc', '中断生成（保留已生成内容）'],
  ];

  const ctxCard = useMemo(() => (
    <div className="ct-rich-rows">
      <div className="ct-rich-row">
        <IconFolder size={16} />
        <span className="ct-rich-text">{abbreviateHome(wsPath, wsInfo?.home || '')}</span>
      </div>
      <div className="ct-rich-row">
        <IconClock size={16} />
        <span className="ct-rich-text">最近活动 · {fmtRel(session?.updatedAt) || '未知'}</span>
      </div>
      {wsInfo?.isGit ? (
        <div className="ct-rich-row git">
          <IconGitBranch size={16} />
          <span className="ct-rich-text">分支 {wsInfo.branch || '未知'}</span>
        </div>
      ) : null}
    </div>
  ), [wsPath, wsInfo, session?.updatedAt]);

  return (
    <header className="ws-head" data-workspace-header="">
      <div className="ws-head-row" style={collapsed ? { paddingLeft: overlayInset + 8 } : undefined}>
        <div className="ws-head-left">
          {session ? (
            <ControlTooltip
              title={ctxCard}
              side="bottom"
              align="start"
              open={ctxVisible}
              onOpenChange={(next) => { setCtxHover(next); if (!next) setCtxPinned(false); }}
            >
              <button
                type="button"
                className="ws-act ws-act-dim"
                aria-label={`工作区 ${title}`}
                onClick={() => setCtxPinned(true)}
              >
                <IconFolder size={16} />
              </button>
            </ControlTooltip>
          ) : null}
          {renaming ? (
            <input
              ref={renameRef}
              className="ws-title-input"
              value={draft}
              autoFocus
              aria-label="会话名称"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                else if (e.key === 'Escape') { e.preventDefault(); setRenaming(false); }
              }}
              onBlur={commitRename}
            />
          ) : (
            <h1 className="ws-title" title={`${title}${session ? ' · 双击重命名' : ''}`} onDoubleClick={session ? startRename : undefined}>
              <span className="ws-title-text">{session ? title : 'AuroraAgent'}</span>
            </h1>
          )}
          {session ? (
            <Menu
              label="会话操作"
              align="start"
              trigger={(
                <button type="button" className="ws-act ws-act-dim" aria-label="会话操作">
                  <IconEllipsis size={16} />
                </button>
              )}
            >
              <MenuItem icon={<IconPencil size={16} />} onSelect={startRename}>重命名会话</MenuItem>
              <MenuItem icon={<IconCopy size={16} />} onSelect={() => void copy(session.id, '会话 ID 已复制')}>复制会话 ID</MenuItem>
              <MenuItem icon={<IconFolder size={16} />} onSelect={() => void copy(session.workspace, '工作目录已复制')}>复制工作目录</MenuItem>
              <MenuSeparator />
              <MenuItem icon={<IconFilePlus size={16} />} onSelect={onFork}>派生会话</MenuItem>
              <MenuItem icon={<IconTrash size={16} />} danger onSelect={onDelete}>删除会话</MenuItem>
            </Menu>
          ) : null}
        </div>
        <div className="ws-head-right">
          <Menu
            label="帮助"
            tip={{ title: '帮助' }}
            trigger={(
              <button type="button" className="ws-act ws-act-dim" aria-label="帮助">
                <IconCircleHelp size={16} />
              </button>
            )}
          >
            {helpPane === 'root' ? (
              <>
                <MenuItem icon={<IconBookOpen size={16} />} onSelect={() => window.open(`${REPO_URL}#readme`, '_blank', 'noopener')}>使用文档</MenuItem>
                <MenuItem icon={<IconCircleHelp size={16} />} onSelect={() => window.open(`${REPO_URL}/issues`, '_blank', 'noopener')}>反馈问题</MenuItem>
                <MenuSeparator />
                <MenuItem icon={<IconKeyboard size={16} />} shortcut="/" onSelect={(e) => { e.preventDefault(); setHelpPane('shortcuts'); }}>快捷键</MenuItem>
                <MenuItem icon={<IconRefresh size={16} />} onSelect={onCheckUpdate}>检查更新</MenuItem>
                <MenuItem icon={<IconInfo size={16} />} onSelect={(e) => { e.preventDefault(); setHelpPane('about'); }}>关于 AuroraAgent</MenuItem>
              </>
            ) : null}
            {helpPane === 'shortcuts' ? (
              <>
                <MenuItem icon={<IconKeyboard size={16} />} onSelect={(e) => { e.preventDefault(); setHelpPane('root'); }}>返回</MenuItem>
                <MenuSeparator />
                {shortcuts.map(([key, label]) => (
                  <MenuItem key={key} shortcut={key} disabled>{label}</MenuItem>
                ))}
              </>
            ) : null}
            {helpPane === 'about' ? (
              <>
                <MenuItem icon={<IconInfo size={16} />} onSelect={(e) => { e.preventDefault(); setHelpPane('root'); }}>返回</MenuItem>
                <MenuSeparator />
                <MenuItem icon={<IconSpark size={16} />} disabled>{`AuroraAgent v${version}`}</MenuItem>
                <MenuItem icon={<IconSpark size={16} />} disabled>{session ? `当前模型 ${session.model}` : '尚未选择模型'}</MenuItem>
                <MenuItem icon={<IconFolder size={16} />} disabled>{abbreviateHome(wsPath, wsInfo?.home || '') || '未指定工作目录'}</MenuItem>
              </>
            ) : null}
          </Menu>
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
