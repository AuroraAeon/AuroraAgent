/**
 * 零依赖下拉选择框（复刻 ZCode Select 的交互与视觉规格）：
 *  - 触发器（ZCode selectTrigger variant=input size=lg）：h-8 + rounded-lg + 1px --line-strong 边
 *    + --surface 底、pl-3 pr-2、14px 文案，右侧 14px chevron（--dim），只过渡颜色
 *    （ZCode 注释：基础控件 transition-all 会在缩放窗口时把尺寸 / 滚动条变化也动画化）；
 *  - 内容（ZCode SelectContent）：rounded-lg + 1px --line-strong 边 + --panel 底 + --shadow-pop、
 *    p-1（4px 壳距）、与触发器等宽；选项 min-h-7 rounded-md px-2 gap-2，选中项右侧 16px 对勾，
 *    键盘高亮走 --surface-hover（ZCode data-[highlighted]:bg-menu-hover 同义）；
 *  - 交互（复刻 Radix Select 键盘全集）：点击开合、上下移动 / Home / End / 回车或空格选中、
 *    Esc 关并把焦点还给触发器、Tab 关、点外面关；打开即聚焦选中项；
 *  - 工程：portal 挂载点取「最近的 dialog，否则 body」——设置弹层是模态 <dialog>（top-layer），
 *    portal 进 body 会被对话框整体盖住；.dlg-panel 有 overflow:hidden + 动画 transform，
 *    也不能挂它。fixed + 视口坐标定位，滚动 / resize 期间重定位，退出淡出 120ms 后卸载。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { IconCheck, IconChevronDown } from './icons';

export interface SelectOption {
  value: string;
  label: string;
  /** 选项图标（ZCode 主题选项带 Monitor / Moon / Sun） */
  icon?: ReactNode;
}

type Props = {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  /** 触发器宽度（ZCode 外观节 w-[260px]） */
  width?: number;
};

const EDGE = 8;
const FADE_MS = 120;

/** portal 宿主：模态 dialog 内必须挂进 dialog 本身（top-layer 盖住 body 子节点） */
function ensureRoot(trigger: HTMLElement | null): HTMLElement {
  const host = trigger?.closest('dialog') ?? document.body;
  let root = host.querySelector<HTMLDivElement>('#select-root');
  if (!root || !root.isConnected) {
    root = document.createElement('div');
    root.id = 'select-root';
    host.appendChild(root);
  }
  return root;
}

export function Select({ value, options, onChange, ariaLabel, width }: Props) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  /** 退出动画期间保留挂载：淡出在原地发生，不清定位（与 Menu / ControlTooltip 同教训） */
  const [render, setRender] = useState(open);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const current = options.find((o) => o.value === value) ?? options[0];

  useEffect(() => {
    if (open) { setRender(true); return; }
    const id = window.setTimeout(() => setRender(false), FADE_MS);
    return () => window.clearTimeout(id);
  }, [open]);

  /** 打开后按触发器实测位置定位：下方优先，空间不足上翻；水平与触发器左缘对齐并做视口钳制 */
  useLayoutEffect(() => {
    if (!render) { setPos(null); return; }
    const place = () => {
      const el = popRef.current, trig = triggerRef.current;
      if (!el || !trig) return;
      const r = trig.getBoundingClientRect();
      const left = Math.max(EDGE, Math.min(r.left, window.innerWidth - el.offsetWidth - EDGE));
      const below = r.bottom + 4;
      const spaceBelow = window.innerHeight - below - EDGE;
      const spaceAbove = r.top - 4 - EDGE;
      const flip = spaceBelow < 160 && spaceAbove > spaceBelow;
      const top = flip ? Math.max(EDGE, r.top - 4 - Math.min(el.offsetHeight, Math.max(120, spaceAbove))) : below;
      setPos((cur) => (cur && cur.left === left && cur.top === top ? cur : { left, top }));
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [render]);

  /** 点外面关（trigger 上的点击走自己的 toggle，不算外面） */
  useEffect(() => {
    if (!render) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (popRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [render]);

  /** 键盘全集（Radix Select 语义）：Esc / Tab 关，上下 + Home / End 移动，回车空格选中 */
  useEffect(() => {
    if (!render) return;
    const items = () => Array.from(popRef.current?.querySelectorAll<HTMLElement>('[role="option"]') || []);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); triggerRef.current?.focus(); return; }
      if (e.key === 'Tab') { setOpen(false); return; }
      const list = items();
      if (!list.length) return;
      const cur = list.findIndex((el) => el === document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const dir = e.key === 'ArrowDown' ? 1 : -1;
        const next = cur < 0 ? (dir > 0 ? 0 : list.length - 1) : (cur + dir + list.length) % list.length;
        list[next]?.focus();
      } else if (e.key === 'Home') { e.preventDefault(); list[0]?.focus(); }
      else if (e.key === 'End') { e.preventDefault(); list[list.length - 1]?.focus(); }
      else if (e.key === 'Enter' || e.key === ' ') {
        if (cur >= 0) { e.preventDefault(); list[cur]?.click(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [render]);

  /** 打开即聚焦选中项（Radix Select 语义：焦点进列表而非容器） */
  useEffect(() => {
    if (!open) return;
    const list = Array.from(popRef.current?.querySelectorAll<HTMLElement>('[role="option"]') || []);
    (list.find((el) => el.getAttribute('aria-selected') === 'true') ?? list[0])?.focus();
  }, [open]);

  const pick = useCallback((next: string) => {
    setOpen(false);
    triggerRef.current?.focus();
    if (next !== value) onChange(next);
  }, [value, onChange]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="sel-trigger"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={ariaLabel}
        style={width ? { width: `${width}px` } : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        {current?.icon ? <span className="sel-value-icon" aria-hidden="true">{current.icon}</span> : null}
        <span className="sel-value">{current?.label ?? ''}</span>
        <IconChevronDown size={14} className="sel-chevron" />
      </button>
      {render ? createPortal(
        <div
          ref={popRef}
          className="sel-pop"
          role="listbox"
          aria-label={ariaLabel}
          data-phase={open ? 'in' : 'out'}
          style={{
            left: pos?.left ?? 0, top: pos?.top ?? 0,
            visibility: pos ? 'visible' : 'hidden',
            width: width ? `${width}px` : undefined,
          }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`sel-item${o.value === value ? ' on' : ''}`}
              onClick={() => pick(o.value)}
            >
              {o.icon ? <span className="sel-item-icon" aria-hidden="true">{o.icon}</span> : null}
              <span className="sel-item-label">{o.label}</span>
              {o.value === value ? <IconCheck size={16} className="sel-item-check" /> : null}
            </button>
          ))}
        </div>,
        ensureRoot(triggerRef.current),
      ) : null}
    </>
  );
}
