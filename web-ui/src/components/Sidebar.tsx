/** 侧栏：品牌 / 新建会话 / 会话列表（相对时间）/ 模式切换 / 设置入口。 */
import { IconGear, IconPlus, IconSpark, IconTrash } from '../icons';
import { fmtRel } from '../projection';
import type { Harness, SessionMeta } from '../types';

type Props = {
  sessions: SessionMeta[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  harnesses: Harness[];
  harness: string;
  onHarness: (id: string) => void;
  onOpenSettings: () => void;
  version: string;
};

export function Sidebar({
  sessions, currentId, onSelect, onNew, onDelete, harnesses, harness, onHarness, onOpenSettings, version,
}: Props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <span className="brand-mark"><IconSpark size={17} /></span>
        <span className="brand-text">
          <strong>AuroraAgent</strong>
          <small>本地 Agent 运行时</small>
        </span>
      </div>
      <button type="button" className="newbtn" onClick={onNew}>
        <IconPlus size={15} />
        新建会话
      </button>
      <nav className="sess-list" aria-label="会话列表">
        {sessions.length === 0 ? <div className="sess-empty">还没有会话</div> : null}
        {sessions.map((s) => (
          <div key={s.id} className={`sess ${s.id === currentId ? 'cur' : ''}`}>
            <button type="button" className="sess-main" onClick={() => onSelect(s.id)} title={s.name}>
              <span className="sess-name">{s.name || '新会话'}</span>
              <span className="sess-sub">
                <span className="sess-mode">{harnesses.find((h) => h.id === s.harness)?.label || s.harness}</span>
                <span className="sess-preview">{s.preview || '（暂无消息）'}</span>
              </span>
              <span className="sess-time">{fmtRel(s.updatedAt)}</span>
            </button>
            <button
              type="button"
              className="sess-del"
              title="删除会话"
              aria-label={`删除会话 ${s.name || ''}`}
              onClick={(ev) => { ev.stopPropagation(); onDelete(s.id); }}
            >
              <IconTrash size={14} />
            </button>
          </div>
        ))}
      </nav>
      <div className="side-foot">
        <div className="mode-seg" role="radiogroup" aria-label="模式">
          {harnesses.map((h) => (
            <button
              key={h.id}
              type="button"
              role="radio"
              aria-checked={h.id === harness}
              className={`mode-btn ${h.id === harness ? 'on' : ''}`}
              title={h.summary}
              onClick={() => onHarness(h.id)}
            >
              {h.label}
            </button>
          ))}
        </div>
        <button type="button" className="side-btn" onClick={onOpenSettings}>
          <IconGear size={15} />
          设置
          <span className="side-ver">v{version}</span>
        </button>
      </div>
    </aside>
  );
}
