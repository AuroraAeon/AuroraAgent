/** 工具卡片：状态 / 参数 / 结果 / diff 视图 / 待办渲染 / 内联权限卡。历史与流式 turn 共用。 */
import { useState, type ReactNode } from 'react';
import {
  Dots, IconCheck, IconClose, IconFile, IconFilePlus, IconFolder, IconGlobe,
  IconList, IconPencil, IconPerson, IconSearch, IconShield, IconTerminal, IconWrench,
} from '../icons';
import { toolIconKey, toolLabel, toolResourceOf } from '../../../util/agent/transcript.mjs';
import { TodoList } from './Todo';
import type { DiffLine, ToolView } from '../types';

// 工具标签与图标键的单一真值源在 util/agent/transcript.mjs（终端同源，含 task / MCP 推导）
const ICON_BY_KEY: Record<string, typeof IconFile> = {
  file: IconFile, folder: IconFolder, write: IconFilePlus, edit: IconPencil,
  shell: IconTerminal, globe: IconGlobe, search: IconSearch, list: IconList,
  wrench: IconWrench, task: IconPerson, plug: IconGlobe,
};

const OUTPUT_LIMIT = 1200;

function resourceOf(tool: ToolView): string {
  return toolResourceOf(tool.name, tool.params);
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

/** edit_file 的行级 diff：语义令牌上色，meta 行（折叠提示）斜体 */
function DiffView({ diff }: { diff: DiffLine[] }) {
  return (
    <div className="tc-sec">
      <div className="tc-sec-t">变更</div>
      <div className="diff">
        {diff.map((d, i) => (
          <div key={`${d.type}-${d.lineNo}-${i}`} className={`dl dl-${d.type}`}>
            <span className="dl-no">{d.type === 'meta' ? '' : d.lineNo}</span>
            <span className="dl-mark">{d.type === 'add' ? '+' : d.type === 'del' ? '-' : ' '}</span>
            <span className="dl-text">{d.text || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

type Props = {
  tool: ToolView;
  onDecide?: (requestId: string, decision: 'allow' | 'deny' | 'always') => void;
};

export function ToolCard({ tool, onDecide }: Props) {
  const [expanded, setExpanded] = useState(false);
  const meta = { label: toolLabel(tool.name), Icon: ICON_BY_KEY[toolIconKey(tool.name)] || IconWrench };
  const status = statusOf(tool);
  const resource = resourceOf(tool);
  const output = tool.output || '';
  const diff = Array.isArray(tool.extra?.diff) ? tool.extra.diff : null;
  const todos = Array.isArray(tool.extra?.todos) ? tool.extra.todos : null;
  // todo 工具的结构化清单已取代纯文本输出，避免同一信息展示两遍
  const hideOutput = tool.name === 'todo' && todos !== null;
  const shown = hideOutput ? '' : output.length > OUTPUT_LIMIT && !expanded
    ? `${output.slice(0, OUTPUT_LIMIT)}\n…（输出过长已折叠，共 ${output.length} 字符）`
    : output;
  const paramsJson = (() => { try { return JSON.stringify(tool.params, null, 2); } catch { return String(tool.params ?? ''); } })();

  const children = tool.name === 'task' && Array.isArray(tool.extra?.children) ? tool.extra.children : null;
  return (
    <div className={`toolcard tc-${tool.phase}${tool.subAgent ? ' tc-sub' : ''}`}>
      <details open={tool.phase === 'ask' || undefined}>
        <summary>
          <span className="tc-icon"><meta.Icon size={14} /></span>
          {tool.subAgent ? <span className="tc-sub-mark" title={`子代理：${tool.subTask || ''}`}>└</span> : null}
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
          {todos ? (
            <div className="tc-sec">
              <div className="tc-sec-t">待办</div>
              <TodoList todos={todos} />
            </div>
          ) : null}
          {diff && diff.length ? <DiffView diff={diff} /> : null}
          {children ? (
            <div className="tc-sec">
              <div className="tc-sec-t">子代理（{children.length}）</div>
              <ul className="subkids">
                {children.map((c, i) => (
                  <li key={c.sessionId || i} className={c.ok ? 'ok' : 'bad'}>
                    <span className="subkids-task">{c.task}</span>
                    <span className="subkids-meta">{c.ok ? `${c.rounds} 轮 · ${c.tools} 工具` : '失败'}</span>
                  </li>
                ))}
              </ul>
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
