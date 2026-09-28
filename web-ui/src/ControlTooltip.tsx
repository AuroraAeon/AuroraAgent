/**
 * 轻量提示气泡（零依赖，复刻 ZCode ControlHintTooltip 的交互与视觉规格）：
 *  - 视觉：8px 圆角 + 1px 边框 + tooltip 令牌底；标题 12px/500，快捷键渲染 16px 高 kbd 键帽
 *    （6px 圆角、10px/500，非 Apple 平台等宽字体），标题与键帽间距 6px；
 *  - 交互：hover / 聚焦即时显示（对齐 ZCode delayDuration=0），失焦 / Esc / 离开关闭，
 *    进入淡入缩放 120ms（@starting-style），退出淡出后卸载；
 *  - 工程：全部实例经 createPortal 挂进模块级单例 root——ZCode 的教训是别按消息量建
 *    Provider 上下文，同时 portal 绕开 .sb-logo 的 overflow:hidden 裁剪；
 *    同一时刻只开一个（模块级 activeHide），滚动 / resize 期间重新定位。
 */
import { cloneElement, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isAppleKeyboardPlatform } from './shortcut';

export interface ControlTooltipProps {
  /** 提示标题：动词开头短标签（术语表纪律），如「切换侧边栏」 */
  title: string;
  /** 快捷键展示标签（平台相关，调用方经 shortcut.ts 生成），渲染为 kbd 键帽 */
  shortcut?: string;
  /** 可选补充说明：有它时标题与键帽占一行、说明另起一行 */
  description?: string;
  /** 气泡方向：默认 top，侧栏导轨钮用 bottom */
  side?: 'top' | 'bottom';
  children: ReactNode;
}

const GAP = 4;
const EDGE = 8;
const FADE_MS = 120;

/** 单例 root：懒创建，断连（热更新 / 测试重置）时重建 */
let root: HTMLDivElement | null = null;
function ensureRoot(): HTMLDivElement {
  if (root && root.isConnected) return root;
  root = document.createElement('div');
  root.id = 'tooltip-root';
  document.body.appendChild(root);
  return root;
}

/** 同一时刻只开一个气泡：新开前先收旧的（token 比对防止误关自己） */
let activeHide: (() => void) | null = null;
let activeToken: object | null = null;

let seq = 0;

export function ControlTooltip({ title, shortcut, description, side = 'top', children }: ControlTooltipProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [tipId] = useState(() => `ct-tip-${++seq}`);
  /** null = 未挂载；phase in = 可见；out = 退出动画中（FADE_MS 后卸载） */
  const [phase, setPhase] = useState<'in' | 'out' | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const token = useRef<object>({});
  const hide = useCallback(() => {
    setPhase((cur) => (cur === 'in' ? 'out' : cur));
  }, []);

  /** 幂等：enter 与 focus 可能连发，不能把已打开的自己关掉 */
  const show = useCallback(() => {
    if (activeToken !== token.current) {
      activeHide?.();
      activeToken = token.current;
      activeHide = hide;
    }
    setPhase('in');
  }, [hide]);

  useEffect(() => {
    if (phase !== 'out') return;
    const id = window.setTimeout(() => {
      setPhase(null);
      if (activeToken === token.current) { activeToken = null; activeHide = null; }
    }, FADE_MS);
    return () => window.clearTimeout(id);
  }, [phase]);

  /** 打开后按触发器实测位置定位：bottom 在下方、top 在上方，水平居中并做视口钳制 */
  useLayoutEffect(() => {
    if (phase !== 'in') { setPos(null); return; }
    const place = () => {
      const el = tipRef.current, trig = triggerRef.current;
      if (!el || !trig) return;
      const r = trig.getBoundingClientRect();
      let left = r.left + r.width / 2 - el.offsetWidth / 2;
      left = Math.max(EDGE, Math.min(left, window.innerWidth - el.offsetWidth - EDGE));
      const top = side === 'bottom' ? r.bottom + GAP : r.top - el.offsetHeight - GAP;
      setPos((cur) => (cur && cur.left === left && cur.top === top ? cur : { left, top }));
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [phase, side, title, shortcut, description]);

  /** Esc 关闭（a11y 惯例） */
  useEffect(() => {
    if (phase !== 'in') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, hide]);

  const child = isValidElement(children) ? (children as ReactElement<Record<string, unknown>>) : null;
  const trigger = child ? cloneElement(child, {
    className: ['ct-trigger', child.props.className].filter(Boolean).join(' '),
    ref: (el: HTMLElement | null) => { triggerRef.current = el; },
    onMouseEnter: () => show(),
    onMouseLeave: () => hide(),
    onFocus: () => show(),
    onBlur: () => hide(),
    'aria-describedby': phase === 'in' ? tipId : undefined,
  }) : (
    <span className="ct-trigger" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
    </span>
  );

  const tip = phase ? (
    createPortal(
      <div
        ref={tipRef}
        id={tipId}
        role="tooltip"
        className="ct-tip"
        data-side={side}
        data-phase={phase}
        data-desc={description ? '1' : undefined}
        style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      >
        <span className="ct-tip-title">{title}</span>
        {shortcut ? <kbd className={`ct-kbd${isAppleKeyboardPlatform() ? ' apple' : ''}`}>{shortcut}</kbd> : null}
        {description ? <span className="ct-tip-desc">{description}</span> : null}
      </div>,
      ensureRoot(),
    )
  ) : null;

  return <>{trigger}{tip}</>;
}
