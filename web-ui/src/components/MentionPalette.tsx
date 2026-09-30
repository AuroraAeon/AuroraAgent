/** @ 提及时调色板：工作目录文件（只读搜索）+ 技能目录合并呈现，浮于输入框上方。
 *  交互范式复用 SkillPalette（指针 ❯、↑↓/Enter/Esc、类型徽标）；文件插入 @相对路径，技能插入 /名称。 */
import { useEffect, useMemo, useRef } from 'react';
import { IconAlert, IconChevronDown, IconFile, IconTag, IconTerminal } from '../icons';
import type { SkillRow } from '../types';
import { buildMentionItems } from '../mention-items.mjs';
import type { MentionItem, ObservationItem } from '../mention-items.mjs';

export type { MentionItem, ObservationItem } from '../mention-items.mjs';

/** 来源徽标文案（与插入形态一一对应：文件插 @路径、问题与命令插原文块、技能插 /名称） */
const SRC_LABEL: Record<MentionItem['kind'], string> = {
  file: '文件', problems: '问题', terminal: '命令', skill: '技能',
};

export function MentionPalette({ files, skills, problems = [], terminal = [], query, active, onPick, onClose }: {
  files: string[];
  skills: SkillRow[];
  problems?: ObservationItem[];
  terminal?: ObservationItem[];
  query: string;
  active: number;
  onPick: (item: MentionItem) => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const items = useMemo<MentionItem[]>(() => buildMentionItems(files, skills, problems, terminal, query), [files, skills, problems, terminal, query]);

  useEffect(() => {
    const onDoc = (ev: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(ev.target as Node)) onClose(); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  return (
    <div className="mentionpal" ref={boxRef} role="listbox" aria-label="文件、问题、命令与技能提及">
      <div className="mentionpal-head">
        <span className="mentionpal-title">提及</span>
        <span className="mentionpal-sub">@相对路径 指文件 · 问题与命令把原文带进上下文 · 技能插入 /名称 调用</span>
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
            {it.kind === 'file' ? <IconFile size={13} /> : it.kind === 'skill' ? <IconTag size={13} /> : it.kind === 'problems' ? <IconAlert size={13} /> : <IconTerminal size={13} />}
            <span className="mentionpal-name" title={it.kind === 'file' || it.kind === 'skill' ? undefined : it.label}>
              {it.kind === 'file' ? `@${it.label}` : it.kind === 'skill' ? `/${it.label}` : it.label}
            </span>
            {it.kind === 'skill' ? <span className="mentionpal-desc">{it.desc}</span> : null}
            <span className="mentionpal-src">{SRC_LABEL[it.kind]}</span>
          </button>
        ))}
        {!items.length ? <div className="mentionpal-empty">没有匹配的文件、问题、命令或技能</div> : null}
      </div>
      <div className="mentionpal-foot">
        <IconChevronDown size={11} />
        <span>{items.length} 项</span>
      </div>
    </div>
  );
}
