/**
 * 轻量通知（零依赖，设计语言对齐 sonner——shadcn/ui 同款那一版：顶部居中栈、实底面板 +
 * 1px 细边 + 单层轻影，不玻璃不光晕无彩底；四级语义只靠 16px 图标本色传达；卡片底部
 * 2px 中性倒计时条是本产品增量）。与既有「顶部错误横幅」互补：横幅留给需要用户回读的长文本
 * 错误，toast 用于一次性操作反馈（保存成功 / 切换失败 / 已复制）。模块级单例 store +
 * useSyncExternalStore，任意组件 `import { toast } from '../toast'` 即可调用，无需挂 Provider。
 *
 * 细节：同标题 + 描述 3 秒内只弹一条（合并计数，避免重复点击刷屏）；最多同屏 4 条，超出丢最旧；
 * 悬停 / 聚焦暂停全部计时（含进度条，恢复时把剩余时长顺延，不再一松手就蒸发）；
 * error 8s、warning 6s、其余 4s、loading 常驻直到被 update/dismiss；
 * 视口 aria-live，错误用 role=alert；prefers-reduced-motion 时不做位移动画；
 * 划走阈值 45px（对齐 sonner 的 SWIPE_THRESHOLD）。
 *
 * 工程：整栈一个 `popover="manual"` 常驻 top layer——模态 <dialog>（含 ::backdrop）也盖不住，
 * 不再需要 MutationObserver 找「最上层打开的 dialog」当 portal 宿主那套边角案例；不支持
 * Popover API 的浏览器静默退回 fixed 常显，通知不因此消失。计时与去重都在模块级 store 里，
 * 换挂载点只重挂 DOM，不影响存活期。
 */
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';
import { IconAlert, IconCheck, IconClose, IconInfo, IconWarn } from './icons';

export type ToastLevel = 'success' | 'error' | 'warning' | 'info' | 'loading';

export interface ToastAction { label: string; run: () => void }
export interface ToastOptions { description?: string; duration?: number; action?: ToastAction }

interface ToastItem {
  id: number;
  level: ToastLevel;
  title: string;
  description?: string;
  action?: ToastAction;
  repeat: number;
  /** 到期绝对时刻；0 = 常驻（loading） */
  expiresAt: number;
  /** 本轮总时长（进度条收宽动画用，须与 expiresAt 同一口径）；0 = 不显示进度条 */
  life: number;
  paused: boolean;
  /** 正在退场：DOM 多留 LEAVE_MS 播离场动画，期间不再计时 */
  leaving: boolean;
  leaveX: number;
  leaveY: number;
}

/** 各级默认存活时长（ms）；0 = 常驻 */
const DURATIONS: Record<ToastLevel, number> = { success: 4000, info: 4000, warning: 6000, error: 8000, loading: 0 };
const VISIBLE_MAX = 4;
const DEDUPE_WINDOW = 3000;
const TICK_MS = 100;
/** 离场动画时长（与 CSS .toast.is-leaving 过渡对齐） */
const LEAVE_MS = 200;
/** 划走阈值（px）：横向左右甩或向上甩都算挥手告别（对齐 sonner 的 SWIPE_THRESHOLD=45） */
const SWIPE_X = 45;
const SWIPE_Y = 45;

let items: ToastItem[] = [];
let seq = 0;
let ticker: number | undefined;
/** 暂停开始时刻；>0 表示整栈计时冻结，新入场与恢复都要把这个窗口补回去 */
let pausedSince = 0;
const listeners = new Set<() => void>();
const recent = new Map<string, number>();
const leaveTimers = new Map<number, number>();

function emit() { for (const fn of listeners) fn(); }

function stopTicker() {
  if (ticker === undefined) return;
  window.clearInterval(ticker);
  ticker = undefined;
}

/** 每个 mutator 之后调：有活要计时才开 ticker，暂停 / 全 loading / 全退场即停 */
function syncTicker() {
  if (items.some((t) => !t.leaving && t.expiresAt > 0 && !t.paused)) startTicker();
  else if (!items.some((t) => t.leaving)) stopTicker();
}

function startTicker() {
  if (ticker !== undefined) return;
  ticker = window.setInterval(() => {
    const now = Date.now();
    for (const t of items) {
      if (!t.leaving && t.expiresAt > 0 && t.expiresAt <= now) dismiss(t.id);
    }
    if (items.length) syncTicker();
    else stopTicker();
  }, TICK_MS);
}

/** 暂停窗口补时：冻结期间不该偷走 toast 的寿命，新入场 / 恢复 / 续期都按它顺延 */
function pausePad(now: number): number { return pausedSince > 0 ? now - pausedSince : 0; }

function drop(id: number) {
  leaveTimers.delete(id);
  const next = items.filter((t) => t.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
  syncTicker();
}

function dismiss(id: number, leaveX = 0, leaveY = -8) {
  const hit = items.find((t) => t.id === id);
  if (!hit || hit.leaving) return;
  // 换新数组与新对象——useSyncExternalStore 靠快照引用变化判断重渲染，原地改会不刷新。
  items = items.map((t) => (t.id === id ? { ...t, leaving: true, leaveX, leaveY } : t));
  emit();
  const timer = window.setTimeout(() => drop(id), LEAVE_MS);
  leaveTimers.set(id, timer);
}

function revive(id: number) {
  const timer = leaveTimers.get(id);
  if (timer !== undefined) { window.clearTimeout(timer); leaveTimers.delete(id); }
  const hit = items.find((t) => t.id === id);
  if (!hit || !hit.leaving) return;
  items = items.map((t) => (t.id === id ? { ...t, leaving: false } : t));
  emit();
}

function push(level: ToastLevel, title: string, options: ToastOptions = {}): number {
  const text = String(title || '').trim() || (level === 'error' ? '出现一个错误' : '操作完成');
  const key = `${level}|${text}|${options.description || ''}`;
  const now = Date.now();
  const life = options.duration ?? DURATIONS[level];
  const expiresAt = life > 0 ? now + pausePad(now) + life : 0;
  // 同屏已有同一条：只累加计数并续期，不开新 toast。
  const hit = items.find((t) => `${t.level}|${t.title}|${t.description || ''}` === key);
  if (hit) {
    revive(hit.id);
    items = items.map((t) => (t.id === hit.id ? { ...t, repeat: t.repeat + 1, expiresAt, life } : t));
    emit();
    syncTicker();
    return hit.id;
  }
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUPE_WINDOW) return -1; // 刚弹过同一条：静默合并
  recent.set(key, now);
  if (recent.size > 50) for (const [k, at] of recent) if (now - at >= DEDUPE_WINDOW) recent.delete(k);

  const id = ++seq;
  items = [...items, { id, level, title: text, description: options.description, action: options.action, repeat: 1, expiresAt, life, paused: pausedSince > 0, leaving: false, leaveX: 0, leaveY: -8 }];
  if (items.length > VISIBLE_MAX) for (const t of items.slice(0, items.length - VISIBLE_MAX)) dismiss(t.id); // 丢最旧，同屏不堆叠
  emit();
  syncTicker();
  return id;
}

function update(id: number, patch: { level?: ToastLevel; title?: string; description?: string; duration?: number }) {
  const now = Date.now();
  revive(id);
  const pad = pausePad(now);
  items = items.map((t) => {
    if (t.id !== id) return t;
    const level = patch.level ?? t.level;
    const life = patch.duration ?? DURATIONS[level];
    return {
      ...t,
      level,
      title: patch.title ? String(patch.title) : t.title,
      description: patch.description ?? t.description,
      expiresAt: life > 0 ? now + pad + life : 0,
      life,
    };
  });
  emit();
  syncTicker();
}

function setPaused(paused: boolean) {
  const now = Date.now();
  if (paused) {
    if (pausedSince > 0) return;
    pausedSince = now;
    items = items.map((t) => (t.paused ? t : { ...t, paused: true }));
    emit();
    syncTicker();
    return;
  }
  const pad = pausePad(now);
  pausedSince = 0;
  if (!pad) { items = items.map((t) => (t.paused ? { ...t, paused: false } : t)); emit(); syncTicker(); return; }
  // 恢复：把冻结窗口补回到期时刻，否则一松手就整栈蒸发（旧实现的老毛病）
  items = items.map((t) => (t.expiresAt > 0 ? { ...t, paused: false, expiresAt: t.expiresAt + pad } : { ...t, paused: false }));
  emit();
  syncTicker();
}

export const toast = {
  success: (title: string, o?: ToastOptions) => push('success', title, o),
  error: (title: string, o?: ToastOptions) => push('error', title, o),
  warning: (title: string, o?: ToastOptions) => push('warning', title, o),
  info: (title: string, o?: ToastOptions) => push('info', title, o),
  loading: (title: string, o?: ToastOptions) => push('loading', title, o),
  update,
  dismiss,
  clear: () => {
    for (const timer of leaveTimers.values()) window.clearTimeout(timer);
    leaveTimers.clear();
    pausedSince = 0;
    items = [];
    emit();
    stopTicker();
  },
};

function subscribe(onChange: () => void) { listeners.add(onChange); return () => { listeners.delete(onChange); }; }
function snapshot() { return items; }

/** top-layer 升降（原生 Popover API）；能力缺失时静默退回 fixed 常显，通知不因此消失 */
function openTopLayer(el: HTMLElement) {
  if (typeof el.showPopover !== 'function') return;
  try { if (!el.matches(':popover-open')) el.showPopover(); } catch { /* 老浏览器不认 :popover-open */ }
}
function closeTopLayer(el: HTMLElement) {
  if (typeof el.hidePopover !== 'function') return;
  try { el.hidePopover(); } catch { /* 本来就没开 */ }
}

/** 通知视口：挂在应用根部一次即可；top layer 由浏览器托管，模态开合无需重新挂载 */
export function ToastViewport() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  const hostRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: number; x: number; y: number } | null>(null);
  const from = useRef({ x: 0, y: 0 });
  const open = list.length > 0;
  const paused = list.some((t) => t.paused);

  // 布局期就升降 top layer：赶在首帧绘制前，进场动画不会因为一晚 display 而丢帧
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    if (open) openTopLayer(el); else closeTopLayer(el);
  }, [open]);

  const beginDrag = (e: ReactPointerEvent<HTMLDivElement>, id: number) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if ((e.target as HTMLElement | null)?.closest('button')) return; // 点按钮划不走
    from.current = { x: e.clientX, y: e.clientY };
    setDrag({ id, x: 0, y: 0 });
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 指针已释放 */ }
  };
  const moveDrag = (e: ReactPointerEvent<HTMLDivElement>, id: number) => {
    if (!drag || drag.id !== id) return;
    setDrag({ id, x: e.clientX - from.current.x, y: e.clientY - from.current.y });
  };
  const endDrag = (id: number) => {
    if (!drag || drag.id !== id) { setDrag(null); return; }
    const { x, y } = drag;
    setDrag(null);
    if (x > SWIPE_X || x < -SWIPE_X) dismiss(id, Math.sign(x) * 160, 0);
    else if (y < -SWIPE_Y) dismiss(id, 0, -160);
  };

  return createPortal(
    <div
      ref={hostRef}
      className={`toast-viewport${paused ? ' is-paused' : ''}`}
      popover="manual"
      role="region"
      aria-label="通知"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {list.map((t) => {
        const dragging = drag !== null && drag.id === t.id;
        const style = {
          '--toast-life': `${Math.max(t.life, 0)}ms`,
          '--leave-x': `${t.leaving ? t.leaveX : 0}px`,
          '--leave-y': `${t.leaving ? t.leaveY : 0}px`,
        } as CSSProperties;
        if (dragging) style.transform = `translate3d(${drag.x}px, ${drag.y}px, 0)`;
        return (
          <div
            key={t.id}
            className={`toast toast-${t.level}${t.leaving ? ' is-leaving' : ''}${dragging ? ' is-dragging' : ''}`}
            role={t.level === 'error' ? 'alert' : 'status'}
            style={style}
            onPointerDown={(e) => beginDrag(e, t.id)}
            onPointerMove={(e) => moveDrag(e, t.id)}
            onPointerUp={() => endDrag(t.id)}
            onPointerCancel={() => endDrag(t.id)}
            onKeyDown={(e: ReactKeyboardEvent<HTMLDivElement>) => { if (e.key === 'Escape') dismiss(t.id); }}
          >
            <span className="toast-icon" aria-hidden="true">
              {t.level === 'success' ? <IconCheck size={15} />
                : t.level === 'error' ? <IconAlert size={15} />
                  : t.level === 'warning' ? <IconWarn size={15} />
                    : t.level === 'info' ? <IconInfo size={15} />
                      : <span className="toast-spin" />}
            </span>
            <div className="toast-body">
              <p className="toast-title">
                {t.title}
                {t.repeat > 1 ? <span className="toast-repeat">×{t.repeat}</span> : null}
              </p>
              {t.description ? <p className="toast-desc">{t.description}</p> : null}
              {t.action ? (
                <div className="toast-acts">
                  <button type="button" className="toast-action" onClick={() => { t.action?.run(); dismiss(t.id); }}>{t.action.label}</button>
                </div>
              ) : null}
            </div>
            <button type="button" className="toast-close" aria-label="关闭通知" onClick={() => dismiss(t.id)}><IconClose size={13} /></button>
            {t.life > 0 ? <span key={t.repeat} className="toast-progress" aria-hidden="true" /> : null}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
