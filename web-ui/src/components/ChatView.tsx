/** 对话区：历史消息 + 进行中的 turn（流式）+ 空态引导。 */
import { useEffect, useRef } from 'react';
import { Message, ThinkingBlock } from './Message';
import { Markdown } from '../markdown';
import { ToolCard } from './ToolCard';
import { IconSpark } from '../icons';
import type { LiveTurn, MsgView } from '../types';

const SUGGESTIONS = [
  '看看工作目录里有什么文件',
  '写一个脚本统计当前目录的代码行数',
  '读取 README 并总结这个项目',
  '帮我列出最近的 git 提交记录',
];

function LiveRow({ live, onDecide }: { live: LiveTurn; onDecide?: (requestId: string, decision: 'allow' | 'deny' | 'always') => void }) {
  const empty = !live.text && !live.thinking && live.tools.length === 0;
  return (
    <div className="row row-ai">
      <div className="avatar avatar-ai" title="AuroraAgent"><IconSpark size={15} /></div>
      <div className="col-ai">
        {live.thinking ? <ThinkingBlock text={live.thinking} defaultOpen streaming /> : null}
        {live.text ? <Markdown text={live.text} /> : null}
        {live.tools.map((t) => <ToolCard key={t.id} tool={t} onDecide={onDecide} />)}
        {live.compression ? <div className="row-system">{live.compression}</div> : null}
        {live.usage ? (
          <div className="usage-foot">
            tokens 输入 {live.usage.inputTokens} · 输出 {live.usage.outputTokens} · 费用 {live.usage.cost < 0.01 ? `¥${live.usage.cost.toFixed(6)}` : `¥${live.usage.cost.toFixed(4)}`}
          </div>
        ) : null}
        {empty ? <div className="live-idle">正在思考<span className="dots" aria-hidden="true"><i /><i /><i /></span></div> : null}
      </div>
    </div>
  );
}

type Props = {
  messages: MsgView[];
  live: LiveTurn | null;
  hasSession: boolean;
  onDecide?: (requestId: string, decision: 'allow' | 'deny' | 'always') => void;
  onPick: (text: string) => void;
};

export function ChatView({ messages, live, hasSession, onDecide, onPick }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, live]);

  if (!hasSession) {
    return (
      <div className="chat-empty">
        <div className="empty-mark"><IconSpark size={26} /></div>
        <h1>AuroraAgent</h1>
        <p>本地 Agent 运行时：对话、读写文件、执行命令，全部在你机器上完成。</p>
        <p className="empty-sub">从左侧新建一个会话开始。</p>
      </div>
    );
  }
  if (!messages.length && !live) {
    return (
      <div className="chat-scroll">
        <div className="chat-empty">
          <div className="empty-mark"><IconSpark size={26} /></div>
          <h1>这个会话还是空的</h1>
          <p>给 AuroraAgent 一个目标，它会按需调用工具逐步完成。</p>
          <div className="empty-chips">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="chip chip-sug" onClick={() => onPick(s)}>{s}</button>
            ))}
          </div>
        </div>
        <div ref={endRef} />
      </div>
    );
  }
  return (
    <div className="chat-scroll" id="chatScroll">
      <div className="chat-inner">
        {messages.map((m) => <Message key={m.key} msg={m} onDecide={onDecide} />)}
        {live ? <LiveRow live={live} onDecide={onDecide} /> : null}
        <div ref={endRef} />
      </div>
    </div>
  );
}
