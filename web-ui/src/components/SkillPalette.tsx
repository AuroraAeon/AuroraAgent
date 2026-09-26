/** 技能斜杠调色板：输入 / 时浮于输入框上方，过滤技能目录。
 *  词汇与终端 TUI 对齐（docs/tui-design.md）：指针 ❯、来源徽标、hint 行不高亮键位。 */
import { useEffect, useRef } from 'react';
import { IconChevronDown } from '../icons';
import type { SkillRow } from '../types';

const SOURCE_LABEL: Record<string, string> = { builtin: '内置', user: '自定义' };

export function SkillPalette({ skills, query, active, onPick, onClose }: {
  skills: SkillRow[];
  query: string;
  active: number;
  onPick: (s: SkillRow) => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const kw = query.trim().toLowerCase();
  const shown = skills.filter((s) => !kw || s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw));

  useEffect(() => {
    const onDoc = (ev: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(ev.target as Node)) onClose(); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [onClose]);

  return (
    <div className="skillpal" ref={boxRef} role="listbox" aria-label="技能命令">
      <div className="skillpal-head">
        <span className="skillpal-title">技能命令</span>
        <span className="skillpal-sub">/&lt;名称&gt; 调用，参数跟在名称后</span>
      </div>
      <div className="skillpal-hint">↑↓ navigate · Enter 插入 · Esc cancel</div>
      <div className="skillpal-list">
        {shown.map((s, i) => (
          <button
            type="button"
            key={s.name}
            className={`skillpal-item${i === active ? ' cur' : ''}`}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => { e.preventDefault(); onPick(s); }}
          >
            <span className="skillpal-ptr">{i === active ? '❯' : ' '}</span>
            <span className="skillpal-name">/{s.name}</span>
            <span className="skillpal-desc">{s.description}</span>
            <span className={`skillpal-src${s.source === 'user' ? ' user' : ''}`}>{SOURCE_LABEL[s.source] || s.source}</span>
          </button>
        ))}
        {!shown.length ? <div className="skillpal-empty">没有匹配的技能</div> : null}
      </div>
      <div className="skillpal-foot">
        <IconChevronDown size={11} />
        <span>{shown.length} / {skills.length}</span>
      </div>
    </div>
  );
}
