/**
 * 前端错误上报（零依赖）：window error + unhandledrejection 统一收口，落服务端错误日志。
 *
 * 形态对齐 workbuddy-switch 的 error-report.ts：
 * - 同一 kind + source + message 在 30 秒内只上报 / 提示一次，崩溃循环不刷屏；
 * - 不吞错：浏览器对未捕获错误的默认控制台输出保持原样，这里额外打一行带来源的摘要；
 * - 上报失败静默忽略——记日志本身绝不影响主流程。
 */
import { toast } from './toast';

const DEDUPE_WINDOW_MS = 30_000;
const DEDUPE_MAX_ENTRIES = 50;
const TOAST_SUMMARY_MAX = 120;

const lastReportedAt = new Map<string, number>();
let installed = false;

function shouldReport(key: string, now: number): boolean {
  const last = lastReportedAt.get(key);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return false;
  lastReportedAt.set(key, now);
  if (lastReportedAt.size > DEDUPE_MAX_ENTRIES) {
    for (const [k, at] of lastReportedAt) if (now - at >= DEDUPE_WINDOW_MS) lastReportedAt.delete(k);
  }
  return true;
}

/** 尽力把任意抛出值转成一行可读摘要（Promise 拒绝的 reason 可能是任意值） */
function describe(value: unknown): string {
  if (value instanceof Error) return value.message || value.name || '未知错误';
  if (typeof value === 'string') return value.trim() || '未知错误';
  if (value === null || value === undefined) return '未知错误';
  try { return JSON.stringify(value) || String(value); } catch { return String(value); }
}

function stackOf(value: unknown): string {
  return value instanceof Error ? (value.stack ?? '') : '';
}

/** 上报一条前端错误：写服务端错误日志 + 一条不打断操作的 toast */
export function reportError(
  kind: 'frontend_crash' | 'frontend_unhandled' | 'backend',
  message: string,
  options: { detail?: string; source?: string; notify?: boolean; scope?: string } = {},
): void {
  const text = message.trim() || '未知错误';
  const source = options.source?.trim() || 'unknown';
  const scope = options.scope?.trim() || '';
  const detail = options.detail ?? '';
  if (!shouldReport(`${kind}|${source}|${text}`, Date.now())) return;

  console.error(`[AuroraAgent] ${kind} (${source}${scope ? `/${scope}` : ''}): ${text}`, detail);
  // 落服务端错误日志（<数据目录>/logs/errors.log）：失败静默，不重试、不阻塞
  void fetch('/api/logs/errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, message: text, detail: [detail, `来源: ${source}`, scope ? `作用域: ${scope}` : ''].filter(Boolean).join('\n') }),
  }).catch(() => {});
  if (options.notify === false) return;
  toast.error('出现一个错误，已记录', {
    description: text.length > TOAST_SUMMARY_MAX ? `${text.slice(0, TOAST_SUMMARY_MAX)}…` : text,
  });
}

/** 安装全局错误捕获：未捕获异常与未处理的 Promise 拒绝（入口只装一次） */
export function installGlobalErrorHandlers(): void {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (event) => {
    if (!event.message) return; // 资源加载失败不带 message，交给浏览器默认行为
    const where = event.filename ? `${event.filename}:${event.lineno}:${event.colno}` : '';
    reportError('frontend_unhandled', event.message, {
      detail: [stackOf(event.error), where ? `来源: ${where}` : ''].filter(Boolean).join('\n'),
      source: where || 'window.error',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    reportError('frontend_unhandled', describe(event.reason), {
      detail: stackOf(event.reason) || describe(event.reason),
      source: 'unhandledrejection',
    });
  });
}
