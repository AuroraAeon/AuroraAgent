/** 对话区：历史消息 + 进行中的 turn（流式）+ 空态引导。 */
import { useEffect, useRef, useState } from 'react';
import { Message, ThinkingBlock } from './Message';
import { Markdown } from '../markdown';
import { ToolCard } from './ToolCard';
import { TodoPanel } from './Todo';
import { PlanCard } from './PlanCard';
import { fmtCostYen } from '../projection';
import { IconChevronDown, IconSpark } from '../icons';
import type { LiveTurn, MsgView, TodoItem } from '../types';

const SUGGESTIONS = [
  '看看工作目录里有什么文件',
  '写一个脚本统计当前目录的代码行数',
  '读取 README 并总结这个项目',
  '帮我列出最近的 git 提交记录',
];

/** 活动计时：turn 进行期间每秒走秒（>60s 转 m:ss） */
function useElapsed(startedAt: number): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function LiveRow({ live, onDecide, onDecidePlan }: { live: LiveTurn; onDecide?: (requestId: string, decision: 'allow' | 'deny' | 'always') => void; onDecidePlan?: (decision: 'approve' | 'reject') => void }) {
  const empty = !live.parts.length && !live.thinking && !live.plan;
  const elapsed = useElapsed(live.startedAt);
  return (
    <div className="row row-ai">
      <div className="avatar avatar-ai" title="AuroraAgent"><IconSpark size={15} /></div>
      <div className="col-ai">
        {live.thinking ? <ThinkingBlock text={live.thinking} defaultOpen streaming /> : null}
        {live.plan ? <PlanCard plan={live.plan} onDecide={onDecidePlan} /> : null}
        {/* parts 时间线与历史投影同形态：流式期间即按「文字 → 工具 → 文字」落位，结束后不重排版 */}
        {live.parts.map((p, pi) => (p.kind === 'text'
          ? <Markdown key={`t${pi}`} text={p.text} />
          : <ToolCard key={p.id} tool={p} onDecide={onDecide} />))}
        {live.compression ? <div className="row-system">{live.compression}</div> : null}
        {live.usage ? (
          <div className="usage-foot">
            输入 {live.usage.inputTokens} · 输出 {live.usage.outputTokens} · 费用 {fmtCostYen(live.usage.cost)}
          </div>
        ) : null}
        {empty ? <div className="live-idle">正在思考<span className="dots" aria-hidden="true"><i /><i /><i /></span></div> : null}
        {!empty ? (
          <div className="live-status" aria-hidden="true">
            <span className="dots"><i /><i /><i /></span>
            第 {live.round || 1} 轮 · {live.parts.filter((p) => p.kind === 'tool').length} 个工具 · {elapsed}
          </div>
        ) : null}
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
  todos: TodoItem[];
  onDecidePlan?: (decision: 'approve' | 'reject') => void;
};

export function ChatView({ messages, live, hasSession, onDecide, onPick, todos, onDecidePlan }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true); // 用户是否贴底：贴底才跟随滚动，上翻读历史时不抢滚动位置
  const [atBottom, setAtBottom] = useState(true);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    setAtBottom(stickRef.current);
  };

  useEffect(() => {
    if (stickRef.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, live]);

  const jumpToBottom = () => {
    stickRef.current = true;
    setAtBottom(true);
    endRef.current?.scrollIntoView({ block: 'end' });
  };

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
      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
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
    <div className="chat-scroll" id="chatScroll" ref={scrollRef} onScroll={onScroll}>
      <div className="chat-inner">
        <TodoPanel todos={todos} />
        {messages.map((m) => <Message key={m.key} msg={m} onDecide={onDecide} />)}
        {live ? <LiveRow live={live} onDecide={onDecide} onDecidePlan={onDecidePlan} /> : null}
        <div ref={endRef} />
        {live && !atBottom ? (
          <button type="button" className="chat-jump" onClick={jumpToBottom}>
            <IconChevronDown size={13} /> 回到最新
          </button>
        ) : null}
      </div>
    </div>
  );
}
