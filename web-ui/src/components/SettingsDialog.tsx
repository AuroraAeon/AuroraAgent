/** 设置弹层外壳：左侧分类导航轨 + 右侧内容区（分级对齐 dsh web SettingsRoot）。
 *  每个 section 首次激活才挂载，之后用 hidden 缓存——切换分类保留面板内部草稿态（如 TuiPanel）。
 *  弹层内子对话框（模型发现 / 删除确认）由各面板自行挂载，不经本壳转发。 */
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  IconAlert, IconChart, IconClock, IconClose, IconGear, IconGlobe, IconKey, IconList, IconPalette, IconShield, IconTerminal, IconWrench,
} from '../icons';
import { ProvidersPanel } from './ProvidersPanel';
import { SkillsPanel } from './SkillsPanel';
import { McpPanel } from './McpPanel';
import { TuiPanel } from './TuiPanel';
import { ProxyPanel } from './ProxyPanel';
import { FailoverPanel } from './FailoverPanel';
import { UsagePanel } from './UsagePanel';
import { ErrorLogPanel } from './ErrorLogPanel';
import { GeneralPanel } from './GeneralPanel';
import { AppearancePanel } from './AppearancePanel';
import { JobsPanel } from './JobsPanel';

type SectionId = 'general' | 'appearance' | 'providers' | 'skills' | 'mcp' | 'jobs' | 'terminal' | 'network' | 'failover' | 'usage' | 'errlog';

type SectionIcon = (p: { size?: number }) => ReactNode;

const SECTIONS: { id: SectionId; label: string; icon: SectionIcon }[] = [
  { id: 'general', label: '通用', icon: IconGear },
  { id: 'appearance', label: '外观', icon: IconPalette },
  { id: 'providers', label: '提供方', icon: IconKey },
  { id: 'failover', label: '故障转移', icon: IconShield },
  { id: 'network', label: '网络', icon: IconGlobe },
  { id: 'skills', label: '技能', icon: IconWrench },
  { id: 'mcp', label: 'MCP 工具', icon: IconList },
  { id: 'jobs', label: '定时任务', icon: IconClock },
  { id: 'terminal', label: '终端', icon: IconTerminal },
  { id: 'usage', label: '用量', icon: IconChart },
  { id: 'errlog', label: '错误日志', icon: IconAlert },
];

type Props = {
  open: boolean;
  onClose: () => void;
  onProvidersChanged: () => void;
};

export function SettingsDialog({ open, onClose, onProvidersChanged }: Props) {
  const dlgRef = useRef<HTMLDialogElement>(null);
  const [active, setActive] = useState<SectionId>('general');
  const [mounted, setMounted] = useState<SectionId[]>(['general']);

  useEffect(() => {
    const d = dlgRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const activate = (id: SectionId) => {
    setActive(id);
    setMounted((m) => (m.includes(id) ? m : [...m, id]));
  };

  const current = SECTIONS.find((s) => s.id === active) || SECTIONS[0];

  const renderSection = (id: SectionId): ReactNode => {
    switch (id) {
      case 'general': return <GeneralPanel />;
      case 'appearance': return <AppearancePanel />;
      case 'providers': return <ProvidersPanel onProvidersChanged={onProvidersChanged} />;
      case 'skills': return <SkillsPanel />;
      case 'mcp': return <McpPanel />;
      case 'jobs': return <JobsPanel />;
      case 'terminal': return <TuiPanel />;
      case 'network': return <ProxyPanel />;
      case 'failover': return <FailoverPanel />;
      case 'usage': return <UsagePanel />;
      case 'errlog': return <ErrorLogPanel />;
    }
  };

  return (
    <dialog ref={dlgRef} className="dlg dlg-settings" closedby="any" onClose={onClose} aria-label="设置">
      <div className="dlg-panel">
        <nav className="set-rail" aria-label="设置分类">
          <h2 className="set-rail-title">设置</h2>
          <div className="set-nav-list">
            {SECTIONS.map((s) => {
              const Icon = s.icon;
              const on = s.id === active;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`set-nav-cell${on ? ' on' : ''}`}
                  aria-current={on ? 'page' : undefined}
                  onClick={() => activate(s.id)}
                >
                  <span className="set-nav-icon"><Icon size={15} /></span>
                  <span className="set-nav-label">{s.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
        <div className="set-content">
          <header className="set-head">
            <h3 className="set-head-title">{current.label}</h3>
            <button type="button" className="iconbtn" aria-label="关闭设置" onClick={() => dlgRef.current?.close()}>
              <IconClose size={15} />
            </button>
          </header>
          <div className="set-body">
            {mounted.map((id) => (
              <div className="set-page" key={id} hidden={id !== active}>
                {renderSection(id)}
              </div>
            ))}
          </div>
        </div>
      </div>
    </dialog>
  );
}
