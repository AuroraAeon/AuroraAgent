/** 设置「通用」section：外观主题 + 服务状态与版本更新。
 * 分级对齐 dsh web 设置页：组标题（12px 重色）→ 行（标题 + 描述 + 右侧控件，行间 0.5px 分隔）。 */
import { useCallback, useEffect, useState } from 'react';
import { IconAlert, IconRefresh } from '../icons';
import { checkUpdate, getSettings, setAutostart } from '../api';
import type { SettingsInfo, UpdateInfo } from '../types';
import { toast } from '../toast';
import { THEME_OPTIONS, useThemePreference } from '../theme';

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="set-group">
      <h4 className="set-group-t">{title}</h4>
      {children}
    </div>
  );
}

function Row({ title, desc, children }: { title: string; desc?: string; children?: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <span className="set-row-t">{title}</span>
        {desc ? <span className="set-row-d">{desc}</span> : null}
      </div>
      {children}
    </div>
  );
}

export function GeneralPanel() {
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [themePref, chooseTheme] = useThemePreference();

  const reload = useCallback(() => { getSettings().then(setSettings).catch(() => {}); }, []);
  useEffect(() => { reload(); }, [reload]);

  const toggleAutostart = async (v: boolean) => {
    setAutostartBusy(true);
    try {
      await setAutostart(v);
      reload();
      toast.success(v ? '已开启开机自启' : '已关闭开机自启', { description: v ? '服务重启期间约 1 秒不可用' : undefined });
    } catch (e) {
      toast.error('切换开机自启失败', { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setAutostartBusy(false);
    }
  };

  const runCheck = () => {
    setUpdateBusy(true);
    checkUpdate(true)
      .then((r) => {
        setUpdate(r);
        if (!r.ok) toast.error('检查更新失败', { description: r.error || '请稍后重试' });
        else if (r.updateAvailable) toast.success(`发现新版本 v${r.latest}`, { description: '点击下方链接查看发布说明' });
        else toast.success('已是最新版本');
      })
      .catch((e) => toast.error('检查更新失败', { description: e instanceof Error ? e.message : String(e) }))
      .finally(() => setUpdateBusy(false));
  };

  return (
    <>
      <Group title="外观">
        <p className="pv-intro">界面配色跟随系统或固定为浅色 / 深色，选择只影响本机浏览器。</p>
        <div className="mode-seg" role="group" aria-label="界面主题">
          {THEME_OPTIONS.map((o) => (
            <button
              key={o.id}
              type="button"
              className={`mode-btn ${themePref === o.id ? 'on' : ''}`}
              aria-pressed={themePref === o.id}
              onClick={() => chooseTheme(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </Group>

      <Group title="服务">
        <Row title="开机自动启动" desc="由 LaunchAgent 常驻服务，登录后自动运行（安装 / 卸载约 1 秒不可用窗口）">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={Boolean(settings?.autostart)}
              disabled={autostartBusy || !settings}
              onChange={(e) => toggleAutostart(e.target.checked)}
            />
            <span>{settings?.autostart ? '已开启' : '已关闭'}</span>
          </label>
        </Row>
        <Row title="运行状态" desc={settings?.managed ? '当前进程由 LaunchAgent 托管' : '当前进程为手动运行'}>
          <span className="set-row-value">{settings ? (settings.managed ? (settings.serviceRunning ? '托管中' : '托管中（未运行）') : '手动运行') : '加载中…'}</span>
        </Row>
        <Row title="端口" desc="网页工作台监听地址">
          <span className="set-row-value">{settings?.port ?? '-'}</span>
        </Row>
        <Row title="数据目录" desc="配置、会话、用量账本与目标都放在这里；已在 .gitignore，永不提交">
          <code className="set-row-code">{settings?.dataDir || '-'}</code>
        </Row>
        <Row title="版本" desc="只告知不自动安装；发现新版本可打开发布页下载">
          <span className="set-row-actions">
            <span className="set-row-value">v{settings?.version || '-'}</span>
            <button type="button" className="btn" disabled={updateBusy} onClick={runCheck}>
              <IconRefresh size={13} /> {updateBusy ? '检查中…' : '检查更新'}
            </button>
          </span>
        </Row>
        {update?.ok && update.updateAvailable && update.url ? (
          <p className="pv-intro pv-update">
            <IconAlert size={12} /> 发现新版本 <strong>v{update.latest}</strong>
            {update.publishedAt ? `（${new Date(update.publishedAt).toLocaleDateString('zh-CN')} 发布）` : ''}：
            <a href={update.url} target="_blank" rel="noreferrer">查看发布页与安装包</a>
          </p>
        ) : null}
      </Group>
    </>
  );
}
