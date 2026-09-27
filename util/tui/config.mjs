/**
 * 终端 TUI 配置段解析：auroraagent.config.json 的 tui 段（util/config.mjs 只做委派）。
 * 纪律与 goal/config.mjs 同构：单叶损坏独立回退 + 告警——一个错值不让整个终端失效。
 * 两个子段：
 *   terminalTitle  OSC 终端标题的项序（['state','session','app'] 的子集，保序去重后生效；[] = 显式关闭）
 *   notifications  完成 / 失败 / 授权 / 提问四类事件的系统通知（when × method × events 各自独立容错）
 */
import { NOTIFICATION_EVENTS } from './notify.mjs';

export const TERMINAL_TITLE_ITEMS = ['state', 'session', 'app'];
export const DEFAULT_TERMINAL_TITLE = ['state', 'session', 'app'];
export const NOTIFICATION_WHEN = ['unfocused', 'always', 'never'];
export const NOTIFICATION_METHODS = ['auto', 'osc9', 'osc777', 'bel'];
export const DEFAULT_NOTIFICATIONS = {
  when: 'unfocused',
  method: 'auto',
  events: ['turn-complete', 'turn-failed', 'permission-required', 'question-required'],
};

/**
 * 解析 tui 段。
 * @param raw   cfg.tui 原值（损坏或缺失均可）
 * @param warn  (msg, extra) 启动告警通道
 */
export function parseTuiConfig(raw, { warn = () => {} } = {}) {
  const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  // leaf：解析值与原值不同即告警（回退与丢弃都发声）；undefined 原值不告警
  const leaf = (name, rawValue, parsed) => {
    if (rawValue !== undefined && JSON.stringify(rawValue) !== JSON.stringify(parsed)) {
      warn('tui 配置项损坏或超界，已回退/钳制', { leaf: name, value: rawValue, fallback: parsed });
    }
    return parsed;
  };

  let title = DEFAULT_TERMINAL_TITLE;
  if (t.terminalTitle !== undefined) {
    title = Array.isArray(t.terminalTitle)
      ? [...new Set(t.terminalTitle.filter((x) => TERMINAL_TITLE_ITEMS.includes(x)))]
      : DEFAULT_TERMINAL_TITLE;
    title = leaf('terminalTitle', t.terminalTitle, title);
  }

  const n = t.notifications && typeof t.notifications === 'object' && !Array.isArray(t.notifications) ? t.notifications : {};
  const when = leaf('notifications.when', n.when, NOTIFICATION_WHEN.includes(n.when) ? n.when : DEFAULT_NOTIFICATIONS.when);
  const method = leaf('notifications.method', n.method, NOTIFICATION_METHODS.includes(n.method) ? n.method : DEFAULT_NOTIFICATIONS.method);
  let events = DEFAULT_NOTIFICATIONS.events;
  if (n.events !== undefined) {
    events = Array.isArray(n.events) ? [...new Set(n.events.filter((x) => NOTIFICATION_EVENTS.includes(x)))] : DEFAULT_NOTIFICATIONS.events;
    events = leaf('notifications.events', n.events, events);
  }
  return { terminalTitle: title, notifications: { when, method, events } };
}
