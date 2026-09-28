/**
 * 轻量通知（零依赖，形态对齐 workbuddy-switch 的 sonner：右下角视口、四级语义、自动消失、可带动作）。
 *
 * 与既有「顶部错误横幅」互补：横幅留给需要用户回读的长文本错误，toast 用于一次性操作反馈
 * （保存成功 / 切换失败 / 已复制）。模块级单例 store + useSyncExternalStore，任意组件
 * `import { toast } from '../toast'` 即可调用，无需在树里挂 Provider。
 *
 * 细节：同标题 + 描述 3 秒内只弹一条（合并计数，避免重复点击刷屏）；最多同屏 4 条，超出丢最旧；
 * 鼠标悬停暂停全部计时；error 8s、warning 6s、其余 4s、loading 常驻直到被 update/dismiss；
 * 视口 aria-live，错误用 role=alert；prefers-reduced-motion 时不做位移动画。
 *
 * 工程：视口经 createPortal 挂「最上层打开的模态 dialog，否则 body」——模态 <dialog> 在
 * top-layer，挂在 body 的 fixed 视口会被整个对话框盖住（设置页 / 删除确认里的 toast 曾因此
 * 不可见，与 Select 的 portal 宿主同一条教训）；计时与去重都在模块级 store 里，换挂载点只
 * 重挂 DOM，不影响存活期。
 */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
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
  expiresAt: number;
  paused: boolean;
}

/** 各级默认存活时长（ms）；0 = 常驻 */
const DURATIONS: Record<ToastLevel, number> = { success: 4000, info: 4000, warning: 6000, error: 8000, loading: 0 };
const VISIBLE_MAX = 4;
const DEDUPE_WINDOW = 3000;
const TICK_MS = 200;

let items: ToastItem[] = [];
let seq = 0;
let ticker: number | undefined;
const listeners = new Set<() => void>();
const recent = new Map<string, number>();

function emit() { for (const fn of listeners) fn(); }

function startTicker() {
  if (ticker !== undefined) return;
  ticker = window.setInterval(() => {
    const now = Date.now();
    const alive = items.filter((t) => t.level === 'loading' || t.paused || t.expiresAt > now);
    if (alive.length !== items.length) { items = alive; emit(); }
    if (!items.length) { window.clearInterval(ticker); ticker = undefined; }
  }, TICK_MS);
}

function dismiss(id: number) {
  const next = items.filter((t) => t.id !== id);
  if (next.length !== items.length) { items = next; emit(); }
}

function push(level: ToastLevel, title: string, options: ToastOptions = {}): number {
  const text = String(title || '').trim() || (level === 'error' ? '出现一个错误' : '操作完成');
  const key = `${level}|${text}|${options.description || ''}`;
  const now = Date.now();
  // 同屏已有同一条：只累加计数并续期，不开新 toast。
  // 必须整体换新数组与新对象——useSyncExternalStore 靠快照引用变化判断重渲染，原地改会不刷新。
  const hit = items.find((t) => `${t.level}|${t.title}|${t.description || ''}` === key);
  if (hit) {
    items = items.map((t) => (t.id === hit.id ? { ...t, repeat: t.repeat + 1, expiresAt: now + (options.duration ?? DURATIONS[level]) } : t));
    emit();
    return hit.id;
  }
  const last = recent.get(key);
  if (last !== undefined && now - last < DEDUPE_WINDOW) return -1; // 刚弹过同一条：静默合并
  recent.set(key, now);
  if (recent.size > 50) for (const [k, at] of recent) if (now - at >= DEDUPE_WINDOW) recent.delete(k);

  const id = ++seq;
  items = [...items, { id, level, title: text, description: options.description, action: options.action, repeat: 1, expiresAt: now + (options.duration ?? DURATIONS[level]), paused: false }];
  if (items.length > VISIBLE_MAX) items = items.slice(items.length - VISIBLE_MAX); // 丢最旧，同屏不堆叠
  emit();
  startTicker();
  return id;
}

function update(id: number, patch: { level?: ToastLevel; title?: string; description?: string; duration?: number }) {
  items = items.map((t) => (t.id === id ? {
    ...t,
    level: patch.level ?? t.level,
    title: patch.title ? String(patch.title) : t.title,
    description: patch.description ?? t.description,
    expiresAt: Date.now() + (patch.duration ?? DURATIONS[patch.level ?? t.level]),
  } : t));
  emit();
}

function setPaused(paused: boolean) {
  const next = items.map((t) => (t.paused === paused ? t : { ...t, paused }));
  if (next.some((t, i) => t !== items[i])) { items = next; emit(); }
}

export const toast = {
  success: (title: string, o?: ToastOptions) => push('success', title, o),
  error: (title: string, o?: ToastOptions) => push('error', title, o),
  warning: (title: string, o?: ToastOptions) => push('warning', title, o),
  info: (title: string, o?: ToastOptions) => push('info', title, o),
  loading: (title: string, o?: ToastOptions) => push('loading', title, o),
  update,
  dismiss,
  clear: () => { items = []; emit(); },
};

function subscribe(onChange: () => void) { listeners.add(onChange); return () => { listeners.delete(onChange); }; }
function snapshot() { return items; }

/** portal 宿主：模态 dialog 内必须挂进 dialog 本身（top-layer 盖住 body 子节点），嵌套 dialog 取最上层 */
function resolveHost(): HTMLElement {
  const open = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).filter((d) => d.isConnected);
  return open.length ? open[open.length - 1] : document.body;
}

/** 通知视口：挂在应用根部一次即可；有模态 dialog 开合时自动跟着换挂载点 */
export function ToastViewport() {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const sync = () => setHost(resolveHost());
    sync();
    // showModal() / close() 只改 open 内容属性，属性监听即可覆盖任意组件里开合的 dialog
    const mo = new MutationObserver(sync);
    mo.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['open'] });
    return () => mo.disconnect();
  }, []);

  // 兜底：dialog 被直接卸载（没走 close()）时宿主会失联，退回 body 也不能让 toast 消失
  const target = host && host.isConnected ? host : document.body;
  if (!list.length) return null;
  return createPortal(
    <div
      className="toast-viewport"
      role="region"
      aria-label="通知"
      aria-live="polite"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`} role={t.level === 'error' ? 'alert' : 'status'}>
          <span className="toast-icon" aria-hidden="true">
            {t.level === 'success' ? <IconCheck size={14} />
              : t.level === 'error' ? <IconAlert size={14} />
              : t.level === 'warning' ? <IconWarn size={14} />
              : t.level === 'info' ? <IconInfo size={14} />
              : <span className="toast-spin" />}
          </span>
          <div className="toast-body">
            <p className="toast-title">
              {t.title}
              {t.repeat > 1 ? <span className="toast-repeat">×{t.repeat}</span> : null}
            </p>
            {t.description ? <p className="toast-desc">{t.description}</p> : null}
          </div>
          {t.action ? (
            <button type="button" className="toast-action" onClick={() => { t.action?.run(); dismiss(t.id); }}>{t.action.label}</button>
          ) : null}
          <button type="button" className="toast-close" aria-label="关闭通知" onClick={() => dismiss(t.id)}><IconClose size={13} /></button>
        </div>
      ))}
    </div>,
    target,
  );
}
