/** 工具卡片：状态 / 参数 / 结果 / 内联权限卡。历史与流式 turn 共用。 */
import { useState, type ReactNode } from 'react';
import {
  Dots, IconCheck, IconClose, IconFile, IconFilePlus, IconFolder, IconGlobe,
  IconPencil, IconShield, IconTerminal, IconWrench,
} from '../icons';
import type { ToolView } from '../types';

const TOOL_META: Record<string, { label: string; Icon: typeof IconFile }> = {
  read_file: { label: '读取文件', Icon: IconFile },
  list_dir: { label: '浏览目录', Icon: IconFolder },
  write_file: { label: '写入文件', Icon: IconFilePlus },
  edit_file: { label: '编辑文件', Icon: IconPencil },
  shell: { label: '执行命令', Icon: IconTerminal },
  web_fetch: { label: '抓取网页', Icon: IconGlobe },
};

const OUTPUT_LIMIT = 1200;

function resourceOf(tool: ToolView): string {
  const p = (tool.params || {}) as Record<string, unknown>;
  if (tool.name === 'shell') return String(p.command || '');
  return String(p.path || p.url || p.dir || '');
}

function statusOf(tool: ToolView): { cls: string; node: ReactNode } {
  switch (tool.phase) {
    case 'running': return { cls: 'run', node: <><Dots label="执行中" /> 执行中</> };
    case 'ask': return { cls: 'ask', node: <><IconShield size={13} /> 等待授权</> };
    case 'rejected': return { cls: 'bad', node: <><IconClose size={13} /> 已拒绝</> };
    case 'failed': return { cls: 'bad', node: <><IconClose size={13} /> 失败</> };
    default: return { cls: 'ok', node: <><IconCheck size={13} /> 完成</> };
  }
}

type Props = {
  tool: ToolView;
  onDecide?: (requestId: string, decision: 'allow' | 'deny' | 'always') => void;
};

export function ToolCard({ tool, onDecide }: Props) {
  const [expanded, setExpanded] = useState(false);
  const meta = TOOL_META[tool.name] || { label: tool.name, Icon: IconWrench };
  const status = statusOf(tool);
  const resource = resourceOf(tool);
  const output = tool.output || '';
  const clipped = output.length > OUTPUT_LIMIT && !expanded;
  const shown = clipped ? `${output.slice(0, OUTPUT_LIMIT)}\n…（输出过长已折叠，共 ${output.length} 字符）` : output;
  const paramsJson = (() => { try { return JSON.stringify(tool.params, null, 2); } catch { return String(tool.params ?? ''); } })();

  return (
    <div className={`toolcard tc-${tool.phase}`}>
      <details open={tool.phase === 'ask' || undefined}>
        <summary>
          <span className="tc-icon"><meta.Icon size={14} /></span>
          <span className="tc-name">{meta.label}</span>
          {resource ? <code className="tc-res" title={resource}>{resource}</code> : null}
          <span className={`tc-status ${status.cls}`}>{status.node}</span>
        </summary>
        <div className="tc-body">
          {tool.phase === 'ask' && tool.requestId && onDecide ? (
            <div className="perm">
              <div className="perm-head">
                <IconShield size={14} />
                <span>该操作需要你的授权</span>
              </div>
              <div className="perm-actions">
                <button type="button" className="btn btn-accent" onClick={() => onDecide(tool.requestId!, 'allow')}>允许</button>
                <button type="button" className="btn" onClick={() => onDecide(tool.requestId!, 'always')}>总是允许</button>
                <button type="button" className="btn btn-danger" onClick={() => onDecide(tool.requestId!, 'deny')}>拒绝</button>
              </div>
            </div>
          ) : null}
          <div className="tc-sec">
            <div className="tc-sec-t">参数</div>
            <pre className="tc-pre">{paramsJson || '（无）'}</pre>
          </div>
          {shown ? (
            <div className="tc-sec">
              <div className="tc-sec-t">输出</div>
              <pre className={`tc-pre tc-out ${tool.phase === 'failed' ? 'err' : ''}`}>{shown}</pre>
              {output.length > OUTPUT_LIMIT ? (
                <button type="button" className="btn btn-link" onClick={() => setExpanded((v) => !v)}>
                  {expanded ? '收起输出' : '展开全部输出'}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}
