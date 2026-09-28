/** 输入区工具钮：模式（Minimal/Standard/Ultimate）/ 权限三档 / 标题生成方式。
 * 与模型选择器（Composer.tsx 的二级菜单）同为停靠芯片；标签宽度按最长项固定，
 * 切换选项不改变工具栏布局（输入框内部宽度不重排）。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { IconCheck, IconChevronDown, IconShield, IconTag } from '../icons';
import type { Harness } from '../types';

/** 浮层通用接线：打开时监听窗外点击与 Escape 关闭 */
function useDismiss(open: boolean, close: () => void, boxRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    if (!open) return;
    const onDoc = (ev: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(ev.target as Node)) close(); };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open, close, boxRef]);
}

export function HarnessPicker({
  harnesses, harness, onHarness, openNonce,
}: {
  harnesses: Harness[]; harness: string; onHarness: (id: string) => void;
  /** 外部打开请求：nonce 递增即展开菜单（/harness 斜杠命令用，与点击同效果） */
  openNonce?: number;
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const current = harnesses.find((h) => h.id === harness) || harnesses[0];

  useDismiss(open, () => setOpen(false), boxRef);

  const lastNonce = useRef(openNonce || 0);
  useEffect(() => {
    if (openNonce !== undefined && openNonce !== lastNonce.current) { lastNonce.current = openNonce; setOpen(true); }
  }, [openNonce]);

  return (
    <div className="hpick" ref={boxRef}>
      <button
        type="button"
        className="tchip tchip-harness"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={current ? current.summary : '选择模式'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="hpick-dot" />
        <span className="tchip-text">{current?.label || '模式'}</span>
        <IconChevronDown size={13} />
      </button>
      {open ? (
        <div className="hpick-menu" role="listbox" aria-label="选择模式">
          {harnesses.map((h) => (
            <button
              key={h.id}
              type="button"
              role="option"
              aria-selected={h.id === harness}
              className="hpick-item"
              onClick={() => { onHarness(h.id); setOpen(false); }}
            >
              <span className="hpick-item-head">
                <span className="mpick-ck">{h.id === harness ? <IconCheck size={13} /> : null}</span>
                {h.label}
                <span className="hpick-rounds">{h.maxRounds} 轮</span>
              </span>
              <span className="hpick-sum">{h.summary}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const PERM_LABEL: Record<string, string> = {
  always_ask: '始终询问',
  ask_when_needed: '必要时询问',
  never_ask: '完全自动',
};
const PERM_HINT: Record<string, string> = {
  always_ask: '每次工具调用都需授权（最谨慎）',
  ask_when_needed: '只读放行，写与执行需授权（默认）',
  never_ask: 'ask 类动作直接放行（deny 规则仍拒绝）',
};

/** 权限三档选择器：始终询问 / 必要时询问 / 完全自动（会话级，PATCH 落 meta） */
export function PermPicker({ mode, onMode }: { mode: string; onMode: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const cur = PERM_LABEL[mode] ? mode : 'ask_when_needed';
  useDismiss(open, () => setOpen(false), boxRef);
  return (
    <div className="hpick" ref={boxRef}>
      <button
        type="button"
        className="tchip tchip-perm"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`权限：${PERM_LABEL[cur]}（${PERM_HINT[cur]}）`}
        onClick={() => setOpen((v) => !v)}
      >
        <IconShield size={14} />
        <span className="tchip-text">{PERM_LABEL[cur]}</span>
        <IconChevronDown size={13} />
      </button>
      {open ? (
        <div className="hpick-menu" role="listbox" aria-label="选择权限模式">
          {Object.keys(PERM_LABEL).map((m) => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={m === cur}
              className="hpick-item"
              onClick={() => { onMode(m); setOpen(false); }}
            >
              <span className="hpick-item-head">
                <span className="mpick-ck">{m === cur ? <IconCheck size={13} /> : null}</span>
                {PERM_LABEL[m]}
              </span>
              <span className="hpick-sum">{PERM_HINT[m]}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

const TITLE_LABEL: Record<string, string> = {
  local: '本地总结',
  model: '模型总结',
};
const TITLE_HINT: Record<string, string> = {
  local: '按首条消息本地推导标题，零成本零延迟（默认）',
  model: '调模型总结标题：每个新会话多一次小额请求，失败自动回退本地推导',
};

/** 标题生成方式选择器：本地推导 / 模型总结（会话级，PATCH 落 meta） */
export function TitlePicker({ mode, onMode }: { mode: string; onMode: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const cur = TITLE_LABEL[mode] ? mode : 'local';
  useDismiss(open, () => setOpen(false), boxRef);
  return (
    <div className="hpick" ref={boxRef}>
      <button
        type="button"
        className="tchip tchip-title"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`标题：${TITLE_LABEL[cur]}（${TITLE_HINT[cur]}）`}
        onClick={() => setOpen((v) => !v)}
      >
        <IconTag size={14} />
        <span className="tchip-text">{TITLE_LABEL[cur]}</span>
        <IconChevronDown size={13} />
      </button>
      {open ? (
        <div className="hpick-menu" role="listbox" aria-label="选择标题生成方式">
          {Object.keys(TITLE_LABEL).map((m) => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={m === cur}
              className="hpick-item"
              onClick={() => { onMode(m); setOpen(false); }}
            >
              <span className="hpick-item-head">
                <span className="mpick-ck">{m === cur ? <IconCheck size={13} /> : null}</span>
                {TITLE_LABEL[m]}
              </span>
              <span className="hpick-sum">{TITLE_HINT[m]}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
