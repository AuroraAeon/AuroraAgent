/**
 * 终端系统通知（零依赖）：OSC 9 / OSC 777 / BEL 三通道，按 tui.notifications 配置择一发送。
 * when=unfocused 时尽力探测终端焦点（macOS osascript，200ms 超时；探测失败按未聚焦处理并
 * 通知——本地工具宁可多响一次，也不漏掉「跑完了 / 要授权」）。非 macOS 或探测不可用时
 * 同样按未聚焦处理。方法：
 *   auto   默认 OSC 9（iTerm2 / kitty / WezTerm / Ghostty 均认识，未知终端安全忽略）；
 *          识别到 OSC 777 支持者（WezTerm / foot）改用带标题与正文的 OSC 777
 *   osc9   \x1b]9;正文\x07        osc777 \x1b]777;notify;标题;正文\x07
 *   bel    响铃 \x07（最古老的通道）
 */
import { execFile } from 'node:child_process';

/** 通知事件 id（配置 closed-set；与 AgentEvent 的映射在终端渲染器侧） */
export const NOTIFICATION_EVENTS = ['turn-complete', 'turn-failed', 'permission-required', 'question-required'];

export const NOTIFICATION_WHEN = ['unfocused', 'always', 'never'];
export const NOTIFICATION_METHODS = ['auto', 'osc9', 'osc777', 'bel'];
export const DEFAULT_NOTIFICATIONS = {
  when: 'unfocused',
  method: 'auto',
  events: ['turn-complete', 'turn-failed', 'permission-required', 'question-required'],
};

const OSC777_TERMINALS = ['wezterm', 'foot'];

/** 焦点探测：前台 app 名是否含已知终端关键字；失败 / 非 macOS 一律按未聚焦（false） */
function probeFocused(timeoutMs = 200) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') return resolve(false);
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const child = execFile(
        'osascript',
        ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
        { timeout: timeoutMs },
        (err, stdout) => {
          if (err) return done(false); // 无权限 / 超时：按未聚焦，宁可多响一次
          const front = String(stdout || '').toLowerCase();
          done(['terminal', 'iterm', 'wezterm', 'ghostty', 'kitty', 'alacritty', 'hyper', 'warp', 'vscode', 'code', 'electron'].some((n) => front.includes(n)));
        },
      );
      child.on('error', () => done(false));
    } catch { done(false); }
  });
}

function pickMethod(method) {
  if (method === 'osc9' || method === 'osc777' || method === 'bel') return method;
  const env = `${process.env.TERM_PROGRAM || ''} ${process.env.TERMINAL_NAME || ''}`.toLowerCase();
  return OSC777_TERMINALS.some((n) => env.includes(n)) ? 'osc777' : 'osc9';
}

/** 按方法写一条通知（转义防止序列注入） */
export function writeNotification(method, { title = 'AuroraAgent', body = '' } = {}) {
  const t = String(title).replace(/[\x07\x1b\r\n]/g, ' ').slice(0, 80);
  const b = String(body).replace(/[\x07\x1b\r\n]/g, ' ').slice(0, 200);
  if (method === 'bel') return '\x07';
  if (method === 'osc777') return `\x1b]777;notify;${t};${b}\x07`;
  return `\x1b]9;${b}\x07`;
}

/**
 * 建通知器。notify 异步（焦点探测）但不阻塞渲染：调用方 fire-and-forget。
 * @param notifications  parseTuiConfig 产出的 notifications 段
 * @param probeIntervalMs 焦点探测结果缓存时长（避免一次 turn 反复 spawn osascript）
 */
export function createNotifier({ notifications, probeIntervalMs = 3000 } = {}) {
  const cfg = { ...DEFAULT_NOTIFICATIONS, ...(notifications || {}) };
  let lastProbe = 0;
  let focused = null;
  return {
    get config() { return cfg; },
    /** 事件是否配置为可通知 */
    wants(event) { return cfg.when !== 'never' && cfg.events.includes(event); },
    async notify(event, { title, body } = {}) {
      if (!this.wants(event)) return;
      if (cfg.when === 'unfocused') {
        if (Date.now() - lastProbe > probeIntervalMs || focused === null) {
          focused = await probeFocused();
          lastProbe = Date.now();
        }
        if (focused) return; // 终端正看着：不打扰
      }
      return writeNotification(pickMethod(cfg.method), { title, body });
    },
  };
}
