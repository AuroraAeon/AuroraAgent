/** 终端偏好面板：OSC 标题项序 + 系统通知三档（服务端配置，终端下次启动生效）+ 浏览器通知开关（本地 opt-in，默认关）。 */
import { useCallback, useEffect, useState } from 'react';
import { IconAlert, IconCheck } from '../icons';
import { getTuiSettings, saveTuiSettings } from '../api';
import type { TuiSettings as TuiSettingsShape } from '../types';

const NOTIFY_KEY = 'aurora.browserNotify';

/** 浏览器通知开关的本地状态读取（App.tsx 的 turn 完成事件用同一判定） */
export function browserNotifyEnabled(): boolean {
  try { return localStorage.getItem(NOTIFY_KEY) === '1'; } catch { return false; }
}

const WHEN_LABELS: Record<string, string> = { unfocused: '仅未聚焦', always: '总是通知', never: '关闭' };
const METHOD_LABELS: Record<string, string> = { auto: '自动', osc9: 'OSC9', osc777: 'OSC777', bel: '响铃' };
const EVENT_LABELS: Record<string, string> = {
  'turn-complete': '任务完成', 'turn-failed': '任务失败',
  'permission-required': '等待授权', 'question-required': '等待提问',
};
const TITLE_LABELS: Record<string, string> = { state: '状态', session: '会话名', app: '应用名' };

export function TuiPanel() {
  const [cfg, setCfg] = useState<TuiSettingsShape | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [browserNotify, setBrowserNotify] = useState(browserNotifyEnabled);

  const reload = useCallback(async () => { setCfg(await getTuiSettings()); }, []);
  useEffect(() => { reload().catch(() => {}); }, [reload]);

  const title = cfg?.tui.terminalTitle || [];
  const notif = cfg?.tui.notifications;
  const events = notif?.events || [];

  const toggleTitle = (item: string) => {
    if (!cfg) return;
    // 项序取 options 的规范序，反复开关不会打乱「状态 | 会话名 | 应用名」
    const next = new Set(title);
    if (next.has(item)) next.delete(item); else next.add(item);
    setCfg({ ...cfg, tui: { ...cfg.tui, terminalTitle: cfg.options.terminalTitleItems.filter((x) => next.has(x)) } });
    setSaved(false);
  };

  const patchNotif = (patch: { when?: string; method?: string; events?: string[] }) => {
    if (!cfg || !notif) return;
    setCfg({ ...cfg, tui: { ...cfg.tui, notifications: { ...notif, ...patch } } });
    setSaved(false);
  };

  const toggleEvent = (ev: string) => {
    const next = new Set(events);
    if (next.has(ev)) next.delete(ev); else next.add(ev);
    patchNotif({ events: (cfg?.options.notificationEvents || []).filter((x) => next.has(x)) });
  };

  const save = async () => {
    if (!cfg) return;
    setBusy(true);
    setError('');
    try {
      const r = await saveTuiSettings({ terminalTitle: cfg.tui.terminalTitle, notifications: cfg.tui.notifications });
      setCfg((c) => (c ? { ...c, tui: r.tui } : c));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const toggleBrowserNotify = async (v: boolean) => {
    if (v && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') return; // 用户拒绝则不开启，保持关
    }
    setBrowserNotify(v);
    try { localStorage.setItem(NOTIFY_KEY, v ? '1' : '0'); } catch { /* 隐私模式忽略 */ }
  };

  return (
    <>
      <p className="pv-intro">以下偏好写入服务端配置，终端（npm run chat）下一次启动时生效；浏览器通知只对当前浏览器生效。</p>
      {error ? <p className="pv-err" role="alert"><IconAlert size={12} /> {error}</p> : null}

      <div className="tui-group">
        <span className="tui-label">终端标题</span>
        <div className="tui-chips">
          {(cfg?.options.terminalTitleItems || []).map((item) => (
            <button
              key={item}
              type="button"
              className={`tui-chip ${title.includes(item) ? 'on' : ''}`}
              aria-pressed={title.includes(item)}
              onClick={() => toggleTitle(item)}
            >
              {TITLE_LABELS[item] || item}
            </button>
          ))}
        </div>
        <span className="tui-hint">按「{title.length ? title.map((x) => TITLE_LABELS[x] || x).join(' | ') : '（已关闭）'} | AuroraAgent」显示；全部关闭即禁用标题改写</span>
      </div>

      <div className="tui-group">
        <span className="tui-label">系统通知时机</span>
        <div className="tui-chips">
          {(cfg?.options.notificationWhen || []).map((w) => (
            <button
              key={w}
              type="button"
              className={`tui-chip ${notif?.when === w ? 'on' : ''}`}
              aria-pressed={notif?.when === w}
              onClick={() => patchNotif({ when: w })}
            >
              {WHEN_LABELS[w] || w}
            </button>
          ))}
        </div>
        <div className="tui-chips">
          {(cfg?.options.notificationMethods || []).map((m) => (
            <button
              key={m}
              type="button"
              className={`tui-chip ${notif?.method === m ? 'on' : ''}`}
              aria-pressed={notif?.method === m}
              onClick={() => patchNotif({ method: m })}
            >
              {METHOD_LABELS[m] || m}
            </button>
          ))}
        </div>
      </div>

      <div className="tui-group">
        <span className="tui-label">通知事件</span>
        {(cfg?.options.notificationEvents || []).map((ev) => (
          <label className="switch-row" key={ev}>
            <input type="checkbox" checked={events.includes(ev)} onChange={() => toggleEvent(ev)} />
            <span>{EVENT_LABELS[ev] || ev}</span>
          </label>
        ))}
      </div>

      <div className="tui-group">
        <span className="tui-label">浏览器通知</span>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={browserNotify}
            onChange={(e) => { toggleBrowserNotify(e.target.checked).catch(() => {}); }}
          />
          <span>任务完成 / 失败时弹出系统通知（默认关，需浏览器授权）</span>
        </label>
      </div>

      <footer className="tui-foot">
        <button type="button" className="btn btn-accent" disabled={busy || !cfg} onClick={save}>
          {saved ? <><IconCheck size={13} /> 已保存</> : '保存终端偏好'}
        </button>
      </footer>
    </>
  );
}
