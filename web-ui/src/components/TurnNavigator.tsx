/** 会话回合导航（复刻 ZCode ConversationTurnNavigator）：
 *  对话区左缘的离散「梯状」历史轨——每个用户提问一条 10px 短棒。悬浮 / 聚焦某条时以它为
 *  山峰向上下衰减（不透明度 + 横向缩放），右侧浮出预览卡（用户提问 + 助手回复摘录），
 *  点击平滑跳转到对应提问；滚动位置驱动活动条（当前读到哪一问）。
 *  少于 2 问不渲染；会话区窄于 864px 整体淡出（对齐 ZCode 容器查询）。零依赖自实现虚拟窗口。 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import {
  TURN_NAV_ITEM_HEIGHT, TURN_NAV_MIN_WIDTH, TURN_NAV_OVERSAN,
  buildTurnNavItems, resolveActiveItemIndex, resolveBarVisualState, resolveRailScrollTopForActive, resolveVisibleRange,
} from '../turn-nav.mjs';
import type { LiveTurn, MsgView } from '../types';

const CARD_OPEN_MS = 120;
const CARD_CLOSE_MS = 80;
const CARD_GAP = 8;
const CARD_EDGE = 8;

/** 预览卡挂载根：懒创建（与 ControlTooltip 同思路，portal 绕开裁切容器） */
let tipRoot: HTMLDivElement | null = null;
function ensureTipRoot(): HTMLDivElement {
  if (tipRoot && tipRoot.isConnected) return tipRoot;
  tipRoot = document.createElement('div');
  tipRoot.id = 'turn-nav-tip-root';
  document.body.appendChild(tipRoot);
  return tipRoot;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return reduced;
}

type Props = {
  views: MsgView[];
  live: LiveTurn | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** 顶部浮层上一个 / 下一个提问请求（ZCode DesktopTopOverlay 任务导航的会话内对应物） */
  navRequest?: { dir: 'prev' | 'next'; nonce: number } | null;
};

export function TurnNavigator({ views, live, scrollRef, navRequest }: Props) {
  const reduced = usePrefersReducedMotion();
  const items = useMemo(() => buildTurnNavItems(views, { running: Boolean(live), liveParts: live?.parts ?? null }), [views, live]);
  const [wide, setWide] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [hover, setHover] = useState<number | null>(null);
  const [cardKey, setCardKey] = useState<string | null>(null);
  const [railScrollTop, setRailScrollTop] = useState(0);
  const [railHeight, setRailHeight] = useState(0);
  const railRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);

  const ready = wide && items.length >= 2;

  /** 实测用户行位置：rect 相对滚动内容换算；content-visibility 跳过的行用记忆高度估算，
   *  活动条目只信视口附近（已真实渲染）的行，点击跳转后随滚动自校正 */
  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !items.length) { setActiveIndex(-1); return; }
    const base = el.getBoundingClientRect().top;
    const rows = el.querySelectorAll<HTMLElement>('.row-user');
    const next: { index: number; key: string; start: number; end: number }[] = [];
    rows.forEach((row, index) => {
      const r = row.getBoundingClientRect();
      if (r.height === 0 && r.top === 0) return;
      const start = r.top - base + el.scrollTop;
      next.push({ index, key: row.dataset.turnKey || String(index), start, end: start + r.height });
    });
    setActiveIndex(resolveActiveItemIndex(next, el.scrollTop, el.clientHeight));
  }, [items.length, scrollRef]);

  /** 宽度门控（对齐 ZCode 864px 容器查询） */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !items.length) { setWide(false); return; }
    const ro = new ResizeObserver(() => setWide(el.clientWidth >= TURN_NAV_MIN_WIDTH));
    ro.observe(el);
    setWide(el.clientWidth >= TURN_NAV_MIN_WIDTH);
    return () => ro.disconnect();
  }, [items.length, scrollRef]);

  /** 条目变化 / 滚动 / 窗口尺寸变化后重测（rAF 合并不抖） */
  useEffect(() => {
    if (!ready) return;
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => { frame = 0; measure(); });
    };
    measure();
    el.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      el.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, [ready, measure, scrollRef]);

  /** 活动项变化时把对应短棒滚进行内可视带 */
  useEffect(() => {
    const rail = railRef.current;
    if (!rail || activeIndex < 0) return;
    const target = resolveRailScrollTopForActive(activeIndex, rail.scrollTop, rail.clientHeight);
    if (Math.abs(target - rail.scrollTop) >= 1) rail.scrollTop = target;
    setRailScrollTop(rail.scrollTop);
  }, [activeIndex, items.length]);

  /** 跳转到对应提问：手动算偏移量，尊重 prefers-reduced-motion */
  const jump = useCallback((key: string) => {
    const el = scrollRef.current;
    if (!el) return;
    const row = el.querySelector<HTMLElement>(`.row-user[data-turn-key="${CSS.escape(key)}"]`);
    if (!row) return;
    const top = row.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop - 12;
    el.scrollTo({ top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' });
  }, [reduced, scrollRef]);

  /** 浮层导航请求：相对当前活动项上 / 下移一项；无活动项（贴底或未测量）时上一个回落到最后一项 */
  useEffect(() => {
    if (!navRequest || items.length < 2) return;
    const last = items.length - 1;
    const from = activeIndex < 0 ? last : activeIndex;
    const target = navRequest.dir === 'prev' ? Math.max(0, from - 1) : Math.min(last, from + 1);
    if (target !== from) jump(items[target].key);
    // 只按 nonce 变化响应：活动项随滚动自校正，不进来重跑
  }, [navRequest]);

  /** 悬浮 / 焦点：视觉焦点即时（梯状即时反应），预览卡延迟 120ms 开、80ms 关（对齐 ZCode HoverCard） */
  const clearTimers = useCallback(() => {
    if (openTimer.current) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  useEffect(() => clearTimers, [clearTimers]);
  const onEnter = useCallback((index: number, key: string) => {
    setHover(index);
    if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    if (openTimer.current) window.clearTimeout(openTimer.current);
    openTimer.current = window.setTimeout(() => setCardKey(key), CARD_OPEN_MS);
  }, []);
  const onLeave = useCallback(() => {
    setHover(null);
    if (openTimer.current) { window.clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setCardKey(null), CARD_CLOSE_MS);
  }, []);
  const onFocusItem = useCallback((index: number, key: string) => {
    setHover(index);
    if (openTimer.current) window.clearTimeout(openTimer.current);
    if (closeTimer.current) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    setCardKey(key);
  }, []);

  /** 预览卡定位：贴短棒右侧、竖直居中并做视口钳制；滚动 / resize 期间跟随 */
  const cardIndex = cardKey ? items.findIndex((it) => it.key === cardKey) : -1;
  useLayoutEffect(() => {
    if (cardIndex < 0) return;
    const place = () => {
      const card = cardRef.current, rail = railRef.current;
      if (!card || !rail) return;
      const bar = rail.querySelector<HTMLElement>(`.tn-item[data-key="${CSS.escape(items[cardIndex].key)}"] .tn-btn`);
      const r = (bar || rail).getBoundingClientRect();
      let left = r.right + CARD_GAP;
      left = Math.min(left, window.innerWidth - card.offsetWidth - CARD_EDGE);
      let top = r.top + r.height / 2 - card.offsetHeight / 2;
      top = Math.max(CARD_EDGE, Math.min(top, window.innerHeight - card.offsetHeight - CARD_EDGE));
      card.style.left = `${Math.max(CARD_EDGE, left)}px`;
      card.style.top = `${top}px`;
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [cardIndex, items]);

  if (!ready) return null;

  const range = resolveVisibleRange(items.length, railScrollTop, railHeight, TURN_NAV_ITEM_HEIGHT, TURN_NAV_OVERSAN);
  const cardItem = cardIndex >= 0 ? items[cardIndex] : null;

  return (
    <>
      <nav className="turn-nav on" aria-label="对话问题导航" data-item-count={items.length}>
        <div
          className="turn-nav-rail"
          ref={railRef}
          onScroll={(e) => { setRailScrollTop(e.currentTarget.scrollTop); setRailHeight(e.currentTarget.clientHeight); }}
          onPointerLeave={onLeave}
        >
          <div className="turn-nav-inner" style={{ height: `${items.length * TURN_NAV_ITEM_HEIGHT}px` }}>
            {items.slice(range.start, range.end).map((item, i) => {
              const index = range.start + i;
              const active = index === activeIndex;
              const vs = resolveBarVisualState(index, hover ?? undefined);
              const showScrollActive = hover === null && active;
              const opacity = item.running ? Math.max(vs.opacity, 0.72) : vs.opacity;
              return (
                <div className="tn-item" key={item.key} data-key={item.key} style={{ transform: `translateY(${index * TURN_NAV_ITEM_HEIGHT}px)` }}>
                  <button
                    type="button"
                    className="tn-btn"
                    aria-current={active ? 'location' : undefined}
                    aria-label={`跳转到第 ${index + 1} 条问题`}
                    aria-posinset={index + 1}
                    aria-setsize={items.length}
                    data-active={active ? 'true' : 'false'}
                    data-running={item.running ? 'true' : 'false'}
                    data-tone={vs.tone}
                    onClick={() => jump(item.key)}
                    onPointerEnter={() => onEnter(index, item.key)}
                    onPointerLeave={onLeave}
                    onFocus={() => onFocusItem(index, item.key)}
                    onBlur={onLeave}
                  >
                    <span
                      className="tn-bar"
                      style={{
                        opacity: showScrollActive ? 0.9 : opacity,
                        transform: `scaleX(${vs.scaleX})`,
                        background: vs.colorTone === 'focus' || showScrollActive ? 'var(--text)' : 'var(--faint)',
                      }}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </nav>
      {cardItem ? createPortal(
        <div className="tn-tip" ref={cardRef} role="tooltip">
          <p className="tn-tip-user">{cardItem.userPreview}</p>
          <p className={`tn-tip-ai tn-tip-ai-${cardItem.assistantKind}`}>{cardItem.assistantPreview}</p>
        </div>,
        ensureTipRoot(),
      ) : null}
    </>
  );
}
