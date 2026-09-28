/** 单条消息渲染：用户 / 助手（思考 + 正文 + 工具 + 用量脚注）/ 系统（压缩提示）。 */
import { memo, useState } from 'react';
import { Markdown } from '../markdown';
import { IconAlert, IconBulb, IconChevronDown, IconChevronRight, IconPerson, IconSpark, IconTag } from '../icons';
import type { MsgView } from '../types';

import { ToolCard } from './ToolCard';
import { fmtCostYen } from '../projection';



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

// 历史消息 memo：流式期间 App 每个 token 都会重渲染，未 memo 时整段历史的 Markdown
// 会被反复重新解析（长会话掉帧的主因）。msg / onDecide 引用稳定时才跳过。
export const Message = memo(function Message({ msg, onDecide }: Props) {
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
  if (msg.kind === 'notice') {
    return (
      <div className="row-notice">
        <IconTag size={13} />
        <span>{msg.text}</span>
      </div>
    );
  }
  return (
    <div className="row row-ai">
      <div className="avatar avatar-ai" title="AuroraAgent"><IconSpark size={15} /></div>
      <div className="col-ai">
        {msg.thinking ? <ThinkingBlock text={msg.thinking} /> : null}
        {/* parts 时间线：文本段与工具卡片按发生顺序交错，回答不被工具调用切断 */}
        {msg.parts.map((p, pi) => (p.kind === 'text'
          ? <Markdown key={`t${pi}`} text={p.text} />
          : <ToolCard key={p.id} tool={p} onDecide={onDecide} />))}
        {msg.usage ? (
          <div className="usage-foot">
            输入 {msg.usage.inputTokens} · 输出 {msg.usage.outputTokens} · 费用 {fmtCostYen(msg.usage.cost)}
          </div>
        ) : null}
      </div>
    </div>
  );
});

export { ThinkingBlock };
