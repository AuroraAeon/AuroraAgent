/**
 * 终端 TUI 偏好的 HTTP 面：GET / POST /api/settings/tui。
 * 读 = 当前生效配置（parseTuiConfig 单叶容错后的形态 + 可选取值，供设置页渲染）；
 * 写 = 合并请求体后整段落盘（saveConfig 原子写）。与 util/providers.mjs 的
 * handleProviderApi 同形态——web.mjs 只保留一行委派，本模块 ≤100 行。
 * 注意：终端在启动时读取一次（terminal.mjs），偏好对已运行的终端下一次启动生效。
 */
import { parseTuiConfig, TERMINAL_TITLE_ITEMS, DEFAULT_TERMINAL_TITLE, NOTIFICATION_WHEN, NOTIFICATION_METHODS, DEFAULT_NOTIFICATIONS } from './config.mjs';
import { NOTIFICATION_EVENTS } from './notify.mjs';

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > limit) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve(null); } });
  });
}

/** 校验并归一化请求体的 tui 段；坏值抛 Error（消息带可用取值，由调用方映射 400） */
export function parseTuiBody(body) {
  const tui = {};
  if (body.terminalTitle !== undefined) {
    const t = body.terminalTitle;
    if (!Array.isArray(t) || t.some((x) => !TERMINAL_TITLE_ITEMS.includes(x))) {
      throw new Error(`terminalTitle 应为数组，元素可用 ${TERMINAL_TITLE_ITEMS.join(' / ')}，空数组表示关闭标题`);
    }
    tui.terminalTitle = [...new Set(t)];
  }
  if (body.notifications !== undefined) {
    const n = body.notifications;
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw new Error('notifications 应为对象');
    const out = {};
    if (n.when !== undefined) {
      if (!NOTIFICATION_WHEN.includes(n.when)) throw new Error(`notifications.when 可用 ${NOTIFICATION_WHEN.join(' / ')}`);
      out.when = n.when;
    }
    if (n.method !== undefined) {
      if (!NOTIFICATION_METHODS.includes(n.method)) throw new Error(`notifications.method 可用 ${NOTIFICATION_METHODS.join(' / ')}`);
      out.method = n.method;
    }
    if (n.events !== undefined) {
      if (!Array.isArray(n.events) || n.events.some((x) => !NOTIFICATION_EVENTS.includes(x))) {
        throw new Error(`notifications.events 应为数组，元素可用 ${NOTIFICATION_EVENTS.join(' / ')}`);
      }
      out.events = [...new Set(n.events)];
    }
    tui.notifications = out;
  }
  if (!Object.keys(tui).length) throw new Error('没有可更新的字段（terminalTitle / notifications）');
  return tui;
}

/** @returns {Promise<boolean>} true = 已处理（含 405），false = 路径不归本模块 */
export async function handleTuiSettingsApi(req, res, url, ctx) {
  const { loadConfig, saveConfig, log = () => {} } = ctx;
  if (url !== '/api/settings/tui') return false;

  if (req.method === 'GET') {
    json(res, 200, {
      ok: true,
      tui: loadConfig().tui,
      options: {
        terminalTitleItems: TERMINAL_TITLE_ITEMS,
        defaultTerminalTitle: DEFAULT_TERMINAL_TITLE,
        notificationWhen: NOTIFICATION_WHEN,
        notificationMethods: NOTIFICATION_METHODS,
        notificationEvents: NOTIFICATION_EVENTS,
        defaultNotifications: DEFAULT_NOTIFICATIONS,
      },
    });
    return true;
  }

  if (req.method === 'POST') {
    const body = await readBody(req, 16 * 1024);
    if (!body) { json(res, 400, { ok: false, error: '请求体不是合法 JSON' }); return true; }
    let tui;
    try { tui = parseTuiBody(body); } catch (e) { json(res, 400, { ok: false, error: e.message }); return true; }
    const cfg = loadConfig();
    cfg.tui = parseTuiConfig({
      ...cfg.tui,
      ...tui,
      notifications: { ...cfg.tui.notifications, ...(tui.notifications || {}) },
    });
    saveConfig(cfg);
    log('info', '终端 TUI 偏好已更新', { keys: Object.keys(tui) });
    json(res, 200, { ok: true, tui: cfg.tui });
    return true;
  }

  json(res, 405, { ok: false, error: '仅支持 GET / POST' });
  return true;
}
