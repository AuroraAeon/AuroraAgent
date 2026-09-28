/**
 * 轻量提示气泡（零依赖，复刻 ZCode ControlHintTooltip 的交互与视觉规格）：
 *  - 视觉：8px 圆角 + 1px 边框 + tooltip 令牌底；标题 12px/500，快捷键渲染 16px 高 kbd 键帽
 *    （6px 圆角、10px/500，非 Apple 平台等宽字体），标题与键帽间距 8px；
 *  - 富内容卡：title 传节点时切 popover 变体（--panel 底、288px 宽、12px 距、左对齐），
 *    承载 ZCode 工作区上下文卡（工作目录 / 最近活动 / git 分支）；
 *  - 交互：hover / 聚焦即时显示（对齐 ZCode delayDuration=0），失焦 / Esc / 离开关闭，
 *    进入淡入缩放 120ms（@starting-style），退出保留上次定位淡出 120ms 后卸载——
 *    清了定位会让气泡瞬间跳到 left/top 0 被 visibility 过渡继续绘制，就是「闪现」根因；
 *  - 受控：传 open / onOpenChange 即交由外部掌控开合（ZCode workspaceContextOpen 模式：
 *    hover 即显、点击触发器的 pin 语义由消费方叠加）；
 *  - 工程：全部实例经 createPortal 挂进模块级单例 root——ZCode 的教训是别按消息量建
 *    Provider 上下文，同时 portal 绕开 .sb-logo 的 overflow:hidden 裁剪；
 *    同一时刻只开一个（模块级 activeHide），滚动 / resize 期间重新定位。
 */
import { cloneElement, isValidElement, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { isAppleKeyboardPlatform } from './shortcut';

export interface ControlTooltipProps {
  /** 提示标题：动词开头短标签（术语表纪律）；传节点则切富内容卡变体 */
  title: string | ReactNode;
  /** 快捷键展示标签（平台相关，调用方经 shortcut.ts 生成），渲染为 kbd 键帽 */
  shortcut?: string;
  /** 可选补充说明：有它时标题与键帽占一行、说明另起一行 */
  description?: string;
  /** 气泡方向：默认 top，Header 钮用 bottom */
  side?: 'top' | 'bottom';
  /** 触发器水平对齐：start = 左缘对齐（ZCode align=start），center = 居中（默认），end = 右缘 */
  align?: 'start' | 'center' | 'end';
  /** 受控开放：给了就由外部掌控开合（onOpenChange 必填） */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}

const GAP = 2;
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

export function ControlTooltip({ title, shortcut, description, side = 'top', align = 'center', open: controlledOpen, onOpenChange, children }: ControlTooltipProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const [tipId] = useState(() => `ct-tip-${++seq}`);
  const [innerOpen, setInnerOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const visible = isControlled ? controlledOpen : innerOpen;
  /** 退出动画期间保留挂载：淡出发生在按钮原地，不清定位（见文件头「闪现」根因） */
  const [render, setRender] = useState(visible);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const token = useRef<object>({});
  const show = useCallback(() => {
    if (isControlled) { onOpenChange?.(true); return; }
    if (activeToken !== token.current) {
      activeHide?.();
      activeToken = token.current;
      activeHide = () => setInnerOpen(false);
    }
    setInnerOpen(true);
  }, [isControlled, onOpenChange]);
  const hide = useCallback(() => {
    if (isControlled) { onOpenChange?.(false); return; }
    setInnerOpen(false);
    if (activeToken === token.current) { activeToken = null; activeHide = null; }
  }, [isControlled, onOpenChange]);

  useEffect(() => {
    if (visible) { setRender(true); return; }
    const id = window.setTimeout(() => setRender(false), FADE_MS);
    return () => window.clearTimeout(id);
  }, [visible]);

  /** 打开后按触发器实测位置定位：bottom 在下方、top 在上方，水平按 align 对齐并做视口钳制 */
  useLayoutEffect(() => {
    if (!render) return;
    const place = () => {
      const el = tipRef.current, trig = triggerRef.current;
      if (!el || !trig) return;
      const r = trig.getBoundingClientRect();
      let left = align === 'start' ? r.left : align === 'end' ? r.right - el.offsetWidth : r.left + r.width / 2 - el.offsetWidth / 2;
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
  }, [render, side, align, title, shortcut, description]);

  /** Esc 关闭（a11y 惯例） */
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') hide(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, hide]);

  const rich = typeof title !== 'string';
  const child = isValidElement(children) ? (children as ReactElement<Record<string, unknown>>) : null;
  // ref 组合（ZCode 教训）：触发器可能已带 ref（如 Menu 克隆出的 trigger 要量定位），
  // 直接覆盖会让消费方的 ref 永远拿不到节点。callback ref 同时写两处，且身份随渲染稳定。
  const childRef = child ? (child.props as { ref?: Ref<HTMLElement> }).ref : undefined;
  const composedRef = useCallback((el: HTMLElement | null) => {
    triggerRef.current = el;
    if (typeof childRef === 'function') childRef(el);
    else if (childRef && typeof childRef === 'object') (childRef as { current: HTMLElement | null }).current = el;
  }, [childRef]);
  const trigger = child ? cloneElement(child, {
    className: ['ct-trigger', child.props.className].filter(Boolean).join(' '),
    ref: composedRef,
    onMouseEnter: () => show(),
    onMouseLeave: () => hide(),
    onFocus: () => show(),
    onBlur: () => hide(),
    'aria-describedby': visible ? tipId : undefined,
  }) : (
    <span className="ct-trigger" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      {children}
    </span>
  );

  const tip = render ? (
    createPortal(
      <div
        ref={tipRef}
        id={tipId}
        role="tooltip"
        className={`ct-tip${rich ? ' ct-tip-rich' : ''}`}
        data-side={side}
        data-phase={visible ? 'in' : 'out'}
        data-desc={!rich && description ? '1' : undefined}
        style={{ left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      >
        {rich ? title : (
          <>
            <span className="ct-tip-title">{title}</span>
            {shortcut ? <kbd className={`ct-kbd${isAppleKeyboardPlatform() ? ' apple' : ''}`}>{shortcut}</kbd> : null}
            {description ? <span className="ct-tip-desc">{description}</span> : null}
          </>
        )}
      </div>,
      ensureRoot(),
    )
  ) : null;

  return <>{trigger}{tip}</>;
}
