/** 侧栏：像素级复刻 ZCode WorkspaceSidebar（去掉 dsh 残留的最后两块）。
 *  ZCode 规格原文：<aside className="flex h-full flex-col overflow-hidden"> 内
 *   - 顶部 48px 空拖拽带（ZCode h-12 [app-region:drag]）：DesktopTopOverlay 浮层盖在这条带上，
 *     侧栏自己没有大 Logo——品牌只在浮层那枚切换钮里（静止显品牌砖、hover 显面板图标）；
 *   - 新建任务钮（ZCode NewTaskButtonGroup）：w-full h-8 rounded-lg ghost，
 *     pl-2.5 pr-2.5 gap-2 hover:bg-surface-hover；内容 = lucide MessageCirclePlus 16px
 *     +「新建任务」14px truncate + 右侧快捷键标签（12px 三次色，ml-auto）；
 *   - 会话区：36px 区头（「会话」标签 + 可展开搜索）+ 32px 行（ZCode TaskListItem 形态：
 *     左 10px 内距 + 16px 前置槽 + 8px 间距把标题整体右移，槽位在会话运行中填灰色加载圈；
 *     圆角 8px、悬停底色、14px 标题、12px 相对时间悬停隐去、16px 操作钮悬停现形）；
 *     栏脚是 panelRow 形态的设置入口。
 *
 *  折叠后侧栏整块消失（ZCode 语义：不存在左侧边，只剩顶部浮层与 WorkspaceHeader 承载入口）。
 *  切换入口统一在 WorkspaceTopOverlay 那枚「静止显品牌砖、hover 显面板图标」的 28px 幽灵钮上
 *  （复刻 ZCode DesktopTopOverlay）；侧栏顶部留出 48px 浮层带（.sidebar 的 padding-top），
 *  展开态浮层正好盖住这条带。 */
import { useEffect, useRef, useState } from 'react';
import { IconClose, IconCopy, IconGear, IconMessageCirclePlus, IconRefresh, IconSearch, IconTrash } from '../icons';
import { searchSessions } from '../api';
import { fmtRel } from '../projection';
import { newSessionLabel } from '../shortcut';
import type { SessionMeta, SessionSearchHit } from '../types';

/** 检索防抖：打字过程中不必每个键都打一次服务端索引 */
const SEARCH_DEBOUNCE_MS = 180;

type Props = {
  sessions: SessionMeta[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** 当前会话已是空新会话：禁止再新建（ZCode NewTaskButtonGroup disabled 语义） */
  newDisabled?: boolean;
  onDelete: (id: string) => void;
  onFork: (id: string) => void;
  onOpenSettings: () => void;
  /** 检查更新：与设置页「检查更新」按钮、顶栏帮助菜单同一 handler（强制重查 + Toast） */
  onCheckUpdate: () => void | Promise<void>;
  /** 首屏会话列表未回：显示骨架行，别把「加载中」显示成「还没有会话」 */
  loading?: boolean;
  /** 正在运行的会话 id 集合：行左侧 16px 槽位显示灰色加载圈（ZCode leadingIndicator=loading） */
  running?: ReadonlySet<string>;
  version: string;
};

export function Sidebar({
  sessions, currentId, onSelect, onNew, newDisabled, onDelete, onFork, onOpenSettings, onCheckUpdate, loading, running, version,
}: Props) {
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [q, setQ] = useState('');
  const [searchOn, setSearchOn] = useState(false);
  const [hits, setHits] = useState<SessionSearchHit[] | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const kw = q.trim().toLowerCase();

  // 输入即检索：服务端索引（util/search/）覆盖标题 + 转录全文，本地标题过滤只在检索失败时兜底——
  // 否则一次网络抖动就让搜索框退回「只搜标题」，用户以为会话丢了
  useEffect(() => {
    if (!kw) { setHits(null); return; }
    let alive = true;
    const timer = setTimeout(() => {
      searchSessions(kw)
        .then((r) => { if (alive) setHits(r.sessions); })
        .catch(() => { if (alive) setHits(null); });
    }, SEARCH_DEBOUNCE_MS);
    return () => { alive = false; clearTimeout(timer); };
  }, [kw]);

  const local = kw ? sessions.filter((s) => (s.name || '').toLowerCase().includes(kw)) : sessions;
  const shown: (SessionMeta & { snippet?: string })[] = hits && hits.length ? hits : local;

  const openSearch = () => { setSearchOn(true); setTimeout(() => searchRef.current?.focus(), 0); };
  const closeSearch = () => { setSearchOn(false); setQ(''); setHits(null); };

  return (
    <aside className="sidebar">
      {/* 新建任务（ZCode NewTaskButtonGroup）：全宽 32px ghost 钮，图标 + 文案 + 右侧快捷键。
          正常态不带 tooltip——按钮已自带文案与快捷键，再挂就是重复（ZCode 同款纪律）。
          当前会话已是空新会话时禁用（newDisabled）：再点只会堆一个空会话。 */}
      <button type="button" className="sb-new" onClick={onNew} disabled={newDisabled}>
        <IconMessageCirclePlus size={16} />
        <span className="sb-new-label">新建任务</span>
        <span className="sb-new-key">{newSessionLabel()}</span>
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
              <span className="sb-skel-lead" />
              <span className="sb-skel-line w1" />
              <span className="sb-skel-line w2" />
            </div>
          )) : null}
          {!loading && sessions.length === 0 ? <div className="sb-empty">还没有会话</div> : null}
          {!loading && sessions.length > 0 && shown.length === 0 ? <div className="sb-empty">无匹配会话</div> : null}
          {shown.map((s) => (
            <div key={s.id} className={`sb-row${s.id === currentId ? ' on' : ''}${s.snippet ? ' hit' : ''}`}>
              {/* 前置 16px 槽（ZCode TaskListItem leading slot）：静止留空，正在运行的会话
                  填灰色加载圈——转圈即「这个会话有活在跑」，切过去能看到实时进度 */}
              <span className="sb-row-lead" aria-hidden="true">
                {running?.has(s.id) ? <span className="sb-spin" /> : null}
              </span>
              <button
                type="button"
                className="sb-row-main"
                aria-current={s.id === currentId ? 'true' : undefined}
                title={`${s.name || '新会话'}${running?.has(s.id) ? ' · 正在运行' : ''}${s.preview ? ` · ${s.preview}` : ''}`}
                onClick={() => onSelect(s.id)}
              >
                <span className="sb-row-title">{s.name || '新会话'}</span>
                <span className="sb-row-time">{fmtRel(s.updatedAt)}</span>
                {s.snippet ? <span className="sb-row-snip">{s.snippet}</span> : null}
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
        <div className="sb-foot-row">
          <button type="button" className="sb-foot-main" onClick={onOpenSettings} title="设置">
            <IconGear size={16} />
            <span className="sb-foot-label">设置</span>
          </button>
          <span className="sb-ver">v{version}</span>
          <button
            type="button"
            className="sb-upd"
            aria-label="检查更新"
            title="检查更新"
            disabled={checkingUpdate}
            onClick={(ev) => {
              ev.stopPropagation();
              setCheckingUpdate(true);
              void Promise.resolve(onCheckUpdate()).finally(() => setCheckingUpdate(false));
            }}
          >
            <IconRefresh size={13} className={checkingUpdate ? 'sb-upd-spin' : undefined} />
          </button>
        </div>
      </div>
    </aside>
  );
}
