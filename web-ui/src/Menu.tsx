/**
 * 零依赖下拉菜单（复刻 ZCode DropdownMenu 的交互与视觉语义）：
 *  - 交互：点击触发器开合；Esc 关并把焦点还给触发器；点外面关；Tab 关；
 *    键盘上下移动 / Home / End / 回车或空格触发（ARIA menu 惯例），悬停同步激活项；
 *  - 视觉：对齐既有 mpick-menu 词汇——12px 圆角壳、1px --line-strong 边、--panel 底、
 *    --shadow-pop、6px 壳距；菜单项 8px 圆角、8px 10px 内距、13px，图标 16px --dim，
 *    danger 项用 --danger-ink；进入 120ms 淡入缩放（@starting-style），只动透明度与变换；
 *  - 工程：全部实例经 createPortal 挂模块级单例 root（与 ControlTooltip 同一思路：
 *    别按实例建上下文；portal 同时绕开 Header 的 overflow:hidden 裁剪），
 *    打开时按触发器实测位置定位并做视口钳制（下方空间不足时上翻），滚动 / resize 重定位。
 */
import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuProps {
  /** 无障碍名称（菜单用途，如「会话操作」） */
  label: string;
  /** 触发器：按钮元素；克隆后挂 ref、aria 与开合逻辑（onClick 被接管） */
  trigger: ReactElement<Record<string, unknown>>;
  /** 对齐触发器的方式：start = 左缘对齐，end = 右缘对齐（默认） */
  align?: 'start' | 'end';
  /** 受控开放（可选）：给了就由外部掌控开合，onClose 必填 */
  open?: boolean;
  onClose?: () => void;
  children: ReactNode;
}

export interface MenuItemProps {
  icon?: ReactNode;
  /** 键帽提示（如 ⌘B）；菜单项右侧渲染 */
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  children: ReactNode;
}

const EDGE = 8;
const FADE_MS = 120;

/** 菜单内上下文：菜单项选中后关菜单（ZCode DropdownMenuItem onSelect 语义） */
const MenuCtx = createContext<{ close: () => void } | null>(null);

let root: HTMLDivElement | null = null;
function ensureRoot(): HTMLDivElement {
  if (root && root.isConnected) return root;
  root = document.createElement('div');
  root.id = 'menu-root';
  document.body.appendChild(root);
  return root;
}

export function Menu({ label, trigger, align = 'end', open: controlledOpen, onClose, children }: MenuProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  /** 退出动画期间保留挂载（与 ControlTooltip 同思路：淡出在按钮原地发生，不闪） */
  const [render, setRender] = useState(open);
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const setOpen = useCallback((next: boolean) => {
    if (controlledOpen === undefined) setInnerOpen(next);
    if (!next) onClose?.();
  }, [controlledOpen, onClose]);

  useEffect(() => {
    if (open) { setRender(true); return; }
    const id = window.setTimeout(() => setRender(false), FADE_MS);
    return () => window.clearTimeout(id);
  }, [open]);

  /** 打开后按触发器实测位置定位：默认在下方，水平按 align 对齐并做双向视口钳制 */
  useLayoutEffect(() => {
    if (!render) { setPos(null); return; }
    const place = () => {
      const el = menuRef.current, trig = triggerRef.current;
      if (!el || !trig) return;
      const r = trig.getBoundingClientRect();
      let left = align === 'end' ? r.right - el.offsetWidth : r.left;
      left = Math.max(EDGE, Math.min(left, window.innerWidth - el.offsetWidth - EDGE));
      const below = r.bottom + 4;
      const spaceBelow = window.innerHeight - below - EDGE;
      const spaceAbove = r.top - 4 - EDGE;
      const flip = spaceBelow < 160 && spaceAbove > spaceBelow;
      const maxHeight = Math.max(120, flip ? spaceAbove : spaceBelow);
      const top = flip ? Math.max(EDGE, r.top - 4 - Math.min(el.offsetHeight, maxHeight)) : below;
      setPos((cur) => (cur && cur.left === left && cur.top === top && cur.maxHeight === maxHeight ? cur : { left, top, maxHeight }));
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [render, align]);

  /** 点外面关（trigger 上的点击走自己的 toggle，不算外面） */
  useEffect(() => {
    if (!render) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (menuRef.current?.contains(t) || triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [render, setOpen]);

  /** 键盘：上下移动 / Home / End / 回车空格触发 / Esc 与 Tab 关 */
  useEffect(() => {
    if (!render) return;
    const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') || []);
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
  }, [render, setOpen]);

  /** 打开即聚焦容器（ARIA：焦点进菜单；具体激活项由上下键驱动，不抢首项高亮） */
  useEffect(() => {
    if (open) menuRef.current?.focus();
  }, [open]);

  const triggerEl = isValidElement(trigger) ? cloneElement(trigger, {
    ref: (el: HTMLElement | null) => { triggerRef.current = el; },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    onClick: (e: MouseEvent) => { e.stopPropagation(); setOpen(!open); },
  }) : trigger;

  const menu = render ? createPortal(
    <div
      ref={menuRef}
      className="menu-pop"
      role="menu"
      aria-label={label}
      tabIndex={-1}
      data-phase={open ? 'in' : 'out'}
      style={{
        left: pos?.left ?? 0, top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
        maxHeight: pos?.maxHeight,
      }}
    >
      <MenuCtx.Provider value={{ close: () => setOpen(false) }}>{children}</MenuCtx.Provider>
    </div>,
    ensureRoot(),
  ) : null;

  return <>{triggerEl}{menu}</>;
}

export function MenuItem({ icon, shortcut, danger, disabled, onSelect, children }: MenuItemProps) {
  const menu = useContext(MenuCtx);
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item${danger ? ' danger' : ''}`}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onSelect?.(); menu?.close(); }}
    >
      {icon ? <span className="menu-item-icon" aria-hidden="true">{icon}</span> : null}
      <span className="menu-item-label">{children}</span>
      {shortcut ? <kbd className="menu-item-kbd">{shortcut}</kbd> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="menu-sep" role="separator" />;
}
