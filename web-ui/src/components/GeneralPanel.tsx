/** 设置「通用」section：外观主题 + 生成参数（温度 / 最大输出 / API Key）+ 服务状态与版本更新。
 * 分级对齐 dsh web 设置页：组标题（12px 重色）→ 行（标题 + 描述 + 右侧控件，行间 0.5px 分隔）。 */
import { useCallback, useEffect, useState } from 'react';
import { IconAlert, IconRefresh } from '../icons';
import { checkUpdate, getGeneration, getKeyState, getSettings, saveApiKey, saveGeneration, setAutostart } from '../api';
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
  // 生成参数（全局）：温度 / 单次最大输出 / API Key，与网页斜杠命令 /temp /max /key 同源
  const [gen, setGen] = useState<{ temperature: number; maxTokens: number } | null>(null);
  const [hasKey, setHasKey] = useState<boolean | null>(null);
  const [tempDraft, setTempDraft] = useState('');
  const [maxDraft, setMaxDraft] = useState('');
  const [keyDraft, setKeyDraft] = useState('');
  const [genBusy, setGenBusy] = useState('');
  const [genErr, setGenErr] = useState('');

  const reload = useCallback(() => { getSettings().then(setSettings).catch(() => {}); }, []);
  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    let dead = false;
    Promise.all([getGeneration().catch(() => null), getKeyState().catch(() => null)])
      .then(([g, k]) => {
        if (dead) return;
        if (g) { setGen({ temperature: g.temperature, maxTokens: g.maxTokens }); setTempDraft(String(g.temperature)); setMaxDraft(String(g.maxTokens)); }
        if (k) setHasKey(k.hasKey);
      });
    return () => { dead = true; };
  }, []);

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

  /** 生成参数保存：校验只在服务端单点（与斜杠命令同一端点），错误就地展示并Toast */
  const saveGen = async (field: 'temperature' | 'maxTokens', raw: string) => {
    const label = field === 'temperature' ? '温度' : '单次最大输出';
    const value = field === 'temperature' ? Number(raw) : Number(raw);
    if (raw.trim() === '' || !Number.isFinite(value)) { setGenErr(`${label}需要填数字`); return; }
    setGenBusy(field);
    setGenErr('');
    try {
      const r = await saveGeneration({ [field]: value });
      setGen({ temperature: r.temperature, maxTokens: r.maxTokens });
      setTempDraft(String(r.temperature));
      setMaxDraft(String(r.maxTokens));
      toast.success(`${label}已保存`, { description: '下一轮模型请求即时生效' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGenErr(msg);
      toast.error(`${label}保存失败`, { description: msg });
    } finally {
      setGenBusy('');
    }
  };

  const saveKey = async () => {
    if (!keyDraft.trim()) { setGenErr('API Key 不能为空'); return; }
    setGenBusy('key');
    setGenErr('');
    try {
      await saveApiKey(keyDraft.trim());
      setHasKey(true);
      setKeyDraft('');
      toast.success('API Key 已保存', { description: '已写入本机配置文件，环境变量优先时以环境变量为准' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGenErr(msg);
      toast.error('API Key 保存失败', { description: msg });
    } finally {
      setGenBusy('');
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

      <Group title="生成参数">
        <p className="pv-intro">全局生效，改后下一轮模型请求即用新值；网页斜杠命令 /temp /max /key 与这里同源。</p>
        <Row title="温度" desc="0 ~ 1，越低越保守；影响下一次请求的采样随机性">
          <div className="np-row">
            <input
              type="number"
              className="np-input np-input-num"
              aria-label="温度"
              min={0}
              max={1}
              step={0.1}
              value={tempDraft}
              onChange={(e) => { setTempDraft(e.target.value); setGenErr(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') saveGen('temperature', tempDraft).catch(() => {}); }}
            />
            <button type="button" className="btn btn-accent" disabled={genBusy !== '' || tempDraft === String(gen?.temperature ?? '')} onClick={() => saveGen('temperature', tempDraft).catch(() => {})}>
              保存
            </button>
          </div>
        </Row>
        <Row title="单次最大输出" desc="单次请求的输出上限（正整数）；过大可能被上游按模型上限截断">
          <div className="np-row">
            <input
              type="number"
              className="np-input np-input-num"
              aria-label="单次最大输出"
              min={1}
              step={1}
              value={maxDraft}
              onChange={(e) => { setMaxDraft(e.target.value); setGenErr(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') saveGen('maxTokens', maxDraft).catch(() => {}); }}
            />
            <button type="button" className="btn btn-accent" disabled={genBusy !== '' || maxDraft === String(gen?.maxTokens ?? '')} onClick={() => saveGen('maxTokens', maxDraft).catch(() => {})}>
              保存
            </button>
          </div>
        </Row>
        <Row title="API Key" desc="保存在本机配置文件中；环境变量 AURORAAGENT_API_KEY 优先，设置后盘上值不生效">
          <div className="np-row">
            <input
              type="password"
              className="np-input"
              aria-label="API Key"
              placeholder={hasKey ? '已保存，输入新值可替换' : 'ak-你的Key'}
              value={keyDraft}
              onChange={(e) => { setKeyDraft(e.target.value); setGenErr(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') saveKey().catch(() => {}); }}
            />
            <button type="button" className="btn btn-accent" disabled={genBusy !== ''} onClick={() => saveKey().catch(() => {})}>
              保存
            </button>
          </div>
        </Row>
        {genErr ? <p className="pv-err" role="alert">{genErr}</p> : null}
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
