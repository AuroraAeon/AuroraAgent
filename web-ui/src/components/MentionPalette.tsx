/** @ 提及时调色板：工作目录文件（只读搜索）+ 技能目录合并呈现，浮于输入框上方。
 *  交互范式复用 SkillPalette（指针 ❯、↑↓/Enter/Esc、类型徽标）；文件插入 @相对路径，技能插入 /名称。 */
import { useEffect, useMemo, useRef } from 'react';
import { IconChevronDown, IconFile, IconTag } from '../icons';
import type { SkillRow } from '../types';

export type MentionItem =
  | { kind: 'file'; key: string; label: string }
  | { kind: 'skill'; key: string; label: string; desc: string };

export function MentionPalette({ files, skills, query, active, onPick, onClose }: {
  files: string[];
  skills: SkillRow[];
  query: string;
  active: number;
  onPick: (item: MentionItem) => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const kw = query.trim().toLowerCase();
  const items = useMemo<MentionItem[]>(() => {
    const fs = files.filter((f) => !kw || f.toLowerCase().includes(kw)).slice(0, 12).map((f) => ({ kind: 'file' as const, key: `f:${f}`, label: f }));
    const ss = skills.filter((s) => !kw || s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw)).slice(0, 6).map((s) => ({ kind: 'skill' as const, key: `s:${s.name}`, label: s.name, desc: s.description }));
    return [...fs, ...ss];
  }, [files, skills, query]);

  useEffect(() => {
    const onDoc = (ev: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(ev.target as Node)) onClose(); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  return (
    <div className="mentionpal" ref={boxRef} role="listbox" aria-label="文件与技能提及">
      <div className="mentionpal-head">
        <span className="mentionpal-title">提及</span>
        <span className="mentionpal-sub">@相对路径 指文件 · 技能将插入 /名称 调用</span>
      </div>
      <div className="mentionpal-hint">↑↓ navigate · Enter 插入 · Esc cancel</div>
      <div className="mentionpal-list">
        {items.map((it, i) => (
          <button
            type="button"
            key={it.key}
            className={`mentionpal-item${i === active ? ' cur' : ''}`}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => { e.preventDefault(); onPick(it); }}
          >
            <span className="mentionpal-ptr">{i === active ? '❯' : ' '}</span>
            {it.kind === 'file' ? <IconFile size={13} /> : <IconTag size={13} />}
            <span className="mentionpal-name">{it.kind === 'file' ? `@${it.label}` : `/${it.label}`}</span>
            {it.kind === 'skill' ? <span className="mentionpal-desc">{it.desc}</span> : null}
            <span className="mentionpal-src">{it.kind === 'file' ? '文件' : '技能'}</span>
          </button>
        ))}
        {!items.length ? <div className="mentionpal-empty">没有匹配的文件或技能</div> : null}
      </div>
      <div className="mentionpal-foot">
        <IconChevronDown size={11} />
        <span>{items.length} 项</span>
      </div>
    </div>
  );
}
