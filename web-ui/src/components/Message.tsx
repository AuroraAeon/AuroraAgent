/** 单条消息渲染：用户 / 助手（思考 + 正文 + 工具 + 用量脚注）/ 系统（压缩提示）。 */
import { useState } from 'react';
import { Markdown } from '../markdown';
import { IconAlert, IconBulb, IconChevronDown, IconChevronRight, IconPerson, IconSpark } from '../icons';
import type { MsgView } from '../types';
import { ToolCard } from './ToolCard';

function fmtCost(cost: number): string {
  if (!cost) return '¥0';
  return `¥${cost < 0.01 ? cost.toFixed(6) : cost.toFixed(4)}`;
}

function ThinkingBlock({ text, defaultOpen = false, streaming = false }: { text: string; defaultOpen?: boolean; streaming?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`think ${open ? 'open' : ''}`}>
      <button type="button" className="think-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        <IconBulb size={13} />
        <span>思考过程</span>
        {streaming ? <span className="think-live">进行中</span> : <span className="think-len">{text.length} 字</span>}
      </button>
      {open ? <div className="think-body">{text}</div> : null}
    </div>
  );
}

type Props = {
  msg: MsgView;
  onDecide?: (requestId: string, decision: 'allow' | 'deny' | 'always') => void;
};

export function Message({ msg, onDecide }: Props) {
  if (msg.kind === 'user') {
    return (
      <div className="row row-user">
        <div className="avatar avatar-user" title="你"><IconPerson size={15} /></div>
        <div className="bubble-user">{msg.text}</div>
      </div>
    );
  }
  if (msg.kind === 'system') {
    return (
      <div className="row-system">
        <IconAlert size={13} />
        <span>已折叠早期对话为摘要：{msg.text}</span>
      </div>
    );
  }
  return (
    <div className="row row-ai">
      <div className="avatar avatar-ai" title="AuroraAgent"><IconSpark size={15} /></div>
      <div className="col-ai">
        {msg.thinking ? <ThinkingBlock text={msg.thinking} /> : null}
        {msg.text ? <Markdown text={msg.text} /> : null}
        {msg.tools.map((t) => <ToolCard key={t.id} tool={t} onDecide={onDecide} />)}
        {msg.usage ? (
          <div className="usage-foot">
            tokens 输入 {msg.usage.inputTokens} · 输出 {msg.usage.outputTokens} · 费用 {fmtCost(msg.usage.cost)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export { ThinkingBlock };
