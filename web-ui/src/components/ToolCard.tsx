/** 工具卡片：状态 / 参数 / 结果 / diff 视图 / 待办渲染 / 内联权限卡。历史与流式 turn 共用。 */
import { useState, type ReactNode } from 'react';
import {
  Dots, IconCheck, IconClose, IconFile, IconFilePlus, IconFolder, IconGlobe,
  IconList, IconPencil, IconPerson, IconScreen, IconSearch, IconShield, IconTerminal, IconWrench,
} from '../icons';
import { toolIconKey, toolLabel, toolResourceOf } from '../../../util/agent/transcript.mjs';
import { TodoList } from './Todo';
import { ZoomableImage } from '../zoom-image';
import type { DiffLine, ToolExtra, ToolView } from '../types';

// 工具标签与图标键的单一真值源在 util/agent/transcript.mjs（终端同源，含 task / MCP 推导）
const ICON_BY_KEY: Record<string, typeof IconFile> = {
  file: IconFile, folder: IconFolder, write: IconFilePlus, edit: IconPencil,
  shell: IconTerminal, globe: IconGlobe, search: IconSearch, list: IconList,
  wrench: IconWrench, task: IconPerson, plug: IconGlobe, screen: IconScreen,
};

const OUTPUT_LIMIT = 1200;

/** computer_use 截图：缩略图 + 点击放大（对齐 OpenBitFun #3184 的图片查看，灯箱与 Markdown 图片同源） */
function ShotView({ shot }: { shot: { url?: string; path: string; width: number; height: number } }) {
  if (!shot.url) return null;
  return <ZoomableImage src={shot.url} alt={`屏幕截图 ${shot.width}x${shot.height}`} className="zoom-img tc-shot" />;
}

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
  /** 进行中的 turn（流式卡片）：历史卡片恒 false。用于「新失败默认展开、历史默认折叠」的分野 */
  live?: boolean;
  /** 本 turn 内已开始透出工具调用的子代理任务文本（live.subTasks） */
  subActive?: string[];
};

/** 子代理执行列表行：四态只来自看得见的信号——
 *  children 到齐 = completed / failed；子代理的 tool_event 已透出 = running；其余 = pending。
 *  没有依据就停在 pending，不拿进度条编一个百分比骗人。 */
type SubRow = { task: string; state: 'pending' | 'running' | 'completed' | 'failed'; meta: string; sessionId: string };

function subRows(tool: ToolView, subActive: string[]): SubRow[] | null {
  if (tool.name !== 'task') return null;
  const children = Array.isArray(tool.extra?.children) ? tool.extra!.children! : null;
  if (children) {
    return children.map((c) => ({
      task: c.task,
      state: c.ok ? 'completed' : 'failed',
      meta: c.ok ? `${c.rounds} 轮 · ${c.tools} 工具` : '失败',
      sessionId: c.sessionId || '',
    }));
  }
  // 还没回结果：按模型请求的任务条数铺 pending 行（跑起来的提到 running）
  if (tool.phase !== 'running') return null;
  const p = (tool.params || {}) as { task?: string; tasks?: string[] };
  const asked = (Array.isArray(p.tasks) ? p.tasks : [p.task]).map((t) => String(t || '').trim()).filter(Boolean);
  if (!asked.length) return null;
  return asked.map((t) => ({
    task: t,
    state: subActive.includes(t) ? 'running' : 'pending',
    meta: subActive.includes(t) ? '执行中' : '等待结果',
    sessionId: '',
  }));
}

/** 钩子执行列表：历史默认折叠（不占版面），当前 turn 里有失败默认展开（失败要看理由） */
function HookRuns({ runs, live }: { runs: NonNullable<ToolExtra['hooks']>; live: boolean }) {
  const failed = runs.filter((r) => !r.ok).length;
  return (
    <details className="tc-hooks" open={live && failed > 0 ? true : undefined}>
      <summary>
        <span className="tc-hooks-t">钩子（{runs.length}）</span>
        {failed ? <span className="tc-hooks-bad">{failed} 失败</span> : null}
      </summary>
      <ul className="hooklist">
        {runs.map((r, i) => (
          <li key={`${r.event}-${i}`} className={r.ok ? 'ok' : 'bad'}>
            <span className="hooklist-ev">{r.event}</span>
            <code className="hooklist-path" title={r.path}>{String(r.path).split('/').pop() || r.path}</code>
            <span className="hooklist-ms">{r.ms}ms</span>
            {r.error ? <span className="hooklist-err">{r.error}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function ToolCard({ tool, onDecide, live = false, subActive = [] }: Props) {
  const [expanded, setExpanded] = useState(false);
  const meta = { label: toolLabel(tool.name), Icon: ICON_BY_KEY[toolIconKey(tool.name)] || IconWrench };
  const status = statusOf(tool);
  const resource = resourceOf(tool);
  const output = tool.output || '';
  const diff = Array.isArray(tool.extra?.diff) ? tool.extra.diff : null;
  const todos = Array.isArray(tool.extra?.todos) ? tool.extra.todos : null;
  const shot = tool.extra?.image || null;
  // todo 工具的结构化清单已取代纯文本输出，避免同一信息展示两遍
  const hideOutput = tool.name === 'todo' && todos !== null;
  const shown = hideOutput ? '' : output.length > OUTPUT_LIMIT && !expanded
    ? `${output.slice(0, OUTPUT_LIMIT)}\n…（输出过长已折叠，共 ${output.length} 字符）`
    : output;
  const paramsJson = (() => { try { return JSON.stringify(tool.params, null, 2); } catch { return String(tool.params ?? ''); } })();

  const subs = subRows(tool, subActive);
  const hookRuns = Array.isArray(tool.extra?.hooks) ? tool.extra!.hooks! : null;
  const subOk = subs ? subs.filter((s) => s.state === 'completed').length : 0;
  const subBad = subs ? subs.filter((s) => s.state === 'failed').length : 0;
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
          {shot ? (
            <div className="tc-sec">
              <div className="tc-sec-t">截图</div>
              <ShotView shot={shot} />
            </div>
          ) : null}
          {subs?.length ? (
            <div className="tc-sec">
              <details className="subkids-wrap" open={tool.phase === 'running' ? true : undefined}>
                <summary className="tc-sec-t">
                  子代理（{subs.length}）{subBad ? ` · ${subBad} 失败` : tool.phase === 'running' ? ' · 进行中' : ` · ${subOk} 成功`}
                </summary>
                <ul className="subkids">
                  {subs.map((s, i) => (
                    <li key={s.sessionId || `${i}`} className={`sk-${s.state}`}>
                      <span className={`sk-dot sk-${s.state}`} aria-hidden="true" />
                      <span className="subkids-task">{s.task}</span>
                      <span className="subkids-meta">{s.meta}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          ) : null}
          {hookRuns?.length ? (
            <div className="tc-sec">
              <div className="tc-sec-t">钩子</div>
              <HookRuns runs={hookRuns} live={live} />
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
