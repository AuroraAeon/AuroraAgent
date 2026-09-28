/** 斜杠命令菜单：输入 / 时浮于输入框上方，随输入实时过滤（命令组 + 技能组合并成一张列表）。
 *  数值对齐 dsh web 的 MenuView（dsh-client-ui-input-trigger）：
 *  菜单 bottom:calc(100% + 4px) / max-height:320px / radius:20px / padding:4px，
 *  行 min-height:40px / radius:10px / padding:8px 10px / 字号 14px，组标题 26px / 12px。
 *  无障碍对齐同一份实现：role=listbox + aria-activedescendant，行是 role=option 的按钮。 */
import { useEffect, useRef } from 'react';
import { rowArgHint, rowName } from '../slash-commands';
import type { SlashRow } from '../slash-commands';

const SOURCE_LABEL: Record<string, string> = { builtin: '内置', user: '自定义' };

/** 行归属的组标题：命令与技能两组（dsh 的 sectionTitle 在组切换处插一行） */
const sectionOf = (r: SlashRow, prev: SlashRow | undefined): string | null => {
  if (!prev) return r.kind === 'command' ? '命令' : '技能';
  return prev.kind === r.kind ? null : '技能';
};

export function CommandPalette({ rows, query, active, onPick, onHover, onClose }: {
  rows: SlashRow[];
  query: string;
  active: number;
  onPick: (r: SlashRow) => void;
  /** 指针悬停即接管高亮（与键盘 ↑↓ 同一个高亮位，后输入者赢——对齐 dsh 的 hover） */
  onHover: (i: number) => void;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const optionId = (i: number) => `cmdpal-opt-${i}`;

  // 窗外点击关闭（与技能 / 提及调色板同一套接线）；mousedown 期间不抢输入框焦点
  useEffect(() => {
    const onDoc = (ev: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(ev.target as Node)) onClose(); };
    document.addEventListener('mousedown', onDoc);
    return () => { document.removeEventListener('mousedown', onDoc); };
  }, [onClose]);

  // 高亮行滚入可视区（键盘 ↑↓ 时长列表不丢光标）
  useEffect(() => {
    const el = boxRef.current?.querySelector<HTMLElement>(`#${optionId(Math.max(0, active))}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, rows.length]);

  return (
    <div className="cmdpal" ref={boxRef} role="listbox" aria-label="斜杠命令" aria-activedescendant={rows.length ? optionId(Math.max(0, active)) : undefined}>
      <div className="cmdpal-viewport">
        {rows.map((r, i) => {
          const prev = rows[i - 1];
          const section = sectionOf(r, prev);
          const hint = rowArgHint(r);
          return (
            <div key={`${r.kind}:${rowName(r)}`} role="presentation">
              {section ? <div className="cmdpal-section">{section}</div> : null}
              <button
                type="button"
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                className={`cmdpal-item${i === active ? ' on' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); onPick(r); }}
                onMouseMove={() => { if (i !== active) onHover(i); }}
              >
                <span className="cmdpal-name">/{rowName(r)}</span>
                <span className="cmdpal-desc">{r.kind === 'command' ? r.entry.summary : r.description}</span>
                {r.kind === 'skill' ? <span className={`cmdpal-src${r.source === 'user' ? ' user' : ''}`}>{SOURCE_LABEL[r.source] || r.source}</span> : null}
                {hint ? <span className="cmdpal-arg">{hint}</span> : null}
              </button>
            </div>
          );
        })}
        {!rows.length ? <div className="cmdpal-empty">没有匹配的命令{query ? `：/${query}` : ''}</div> : null}
      </div>
      {rows.length ? <div className="cmdpal-foot">Tab 补全 · Enter 执行或补全 · Esc 关闭</div> : null}
    </div>
  );
}
