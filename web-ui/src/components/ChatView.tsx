/** 对话区：历史消息 + 进行中的 turn（流式）+ 空态引导。 */
import { useEffect, useRef, useState } from 'react';
import { Message, ThinkingBlock } from './Message';
import { Markdown } from '../markdown';
import { ToolCard } from './ToolCard';
import { TodoPanel } from './Todo';
import { PlanCard } from './PlanCard';
import { fmtCostYen } from '../projection';
import { TurnNavigator } from './TurnNavigator';
import { ContextMeter } from './ContextMeter';
import { IconAt, IconChevronDown, IconSpark } from '../icons';
import { emitQuote, quoteBlock } from '../quote-bus.mjs';
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
    <div className="row row-ai is-assistant">
      <div className="col-ai">
        {live.thinking ? <ThinkingBlock text={live.thinking} streaming /> : null}
        {live.plan ? <PlanCard plan={live.plan} onDecide={onDecidePlan} /> : null}
        {/* parts 时间线与历史投影同形态：流式期间即按「文字 → 工具 → 文字」落位，结束后不重排版 */}
        {live.parts.map((p, pi) => (p.kind === 'text'
          ? <Markdown key={`t${pi}`} text={p.text} />
          : <ToolCard key={p.id} tool={p} onDecide={onDecide} live subActive={live.subTasks || []} />))}
        {/* 压缩分隔行：四个终态都留一行（含失败与取消）——悄悄回到原上下文会让人以为压缩成功过 */}
        {live.compression ? (
          <div className={`row-system comp-${live.compression.state}`}>
            <span className={`comp-dot ${live.compression.state}`} aria-hidden="true" />
            {live.compression.text}
          </div>
        ) : null}
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
  /** 回滚到某一轮之前（该轮有检查点才给入口） */
  onRollback?: (turnIndex: number) => void;
};

export function ChatView({ messages, live, hasSession, onDecide, onPick, todos, onDecidePlan, onRollback }: Props) {
  const endRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true); // 用户是否贴底：贴底才跟随滚动，上翻读历史时不抢滚动位置
  const [atBottom, setAtBottom] = useState(true);
  // 用户轮计数器（渲染期自增，与后端 turnIndex 对齐）：map 是同步的，重渲染会重新数一遍
  let userSeq = 0;
  // 选中引用：在转录里划词后浮出引用钮，点击把这段原文以 Markdown 引用块塞进输入框。
  // 选区监听挂在 document 上（mouseup 才是「选完了」的时刻），但只认落在本滚动区内的选区——
  // 在侧栏或设置里划词不该蹦出引用钮。按钮用 mousedown preventDefault 保住选区，
  // 否则点击瞬间 selection 被清空，再读 window.getSelection() 已是空的。
  const wrapRef = useRef<HTMLDivElement>(null);
  const [quote, setQuote] = useState<{ x: number; y: number; text: string } | null>(null);

  useEffect(() => {
    const onUp = () => {
      const sel = window.getSelection();
      const root = scrollRef.current;
      const wrap = wrapRef.current;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !root || !wrap || !sel.anchorNode || !root.contains(sel.anchorNode)) {
        setQuote(null);
        return;
      }
      const text = sel.toString().replace(/\u00a0/g, ' ').trim();
      // 太短的选区（误触一下鼠标）不值得弹钮；过长的选区（整篇全选）塞进输入框会把话挤没
      if (text.length < 2 || text.length > 4000) { setQuote(null); return; }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      const box = wrap.getBoundingClientRect();
      if (!rect.width && !rect.height) { setQuote(null); return; }
      setQuote({ x: rect.left - box.left + rect.width / 2, y: rect.top - box.top, text });
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, []);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    setAtBottom(stickRef.current);
    setQuote(null); // 滚动了选区位置就作废，别留一个钉在旧坐标上的钮
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
    <div className="chat-wrap" ref={wrapRef}>
      <div className="chat-scroll" id="chatScroll" ref={scrollRef} onScroll={onScroll}>
        <div className="chat-inner">
          {/* 上下文窗口占用：只有真拿到估算值才显示（估算为 0 说明后端没给，别显示个 0% 吓人） */}
          {live?.usage?.contextTokens ? (
            <ContextMeter tokens={live.usage.contextTokens} window={live.usage.contextWindow || 0} cached={live.usage.cachedTokens} />
          ) : null}
          <TodoPanel todos={todos} />
          {/* 用户轮序号从 1 数：与后端 turnIndex（session.turns + 1）同口径，检查点按它取 */}
          {messages.map((m) => {
            if (m.kind !== 'user') return <Message key={m.key} msg={m} onDecide={onDecide} />;
            userSeq += 1;
            return <Message key={m.key} msg={m} onDecide={onDecide} turnIndex={userSeq} onRollback={onRollback} />;
          })}
          {live ? <LiveRow live={live} onDecide={onDecide} onDecidePlan={onDecidePlan} /> : null}
          <div ref={endRef} />
          {live && !atBottom ? (
            <button type="button" className="chat-jump" onClick={jumpToBottom}>
              <IconChevronDown size={13} /> 回到最新
            </button>
          ) : null}
        </div>
      </div>
      <TurnNavigator views={messages} live={live} scrollRef={scrollRef} />
      {quote ? (
        <button
          type="button"
          className="quotebtn"
          title="引用这段内容"
          style={{ left: `${Math.max(30, Math.min(quote.x, (wrapRef.current?.clientWidth || 0) - 30))}px`, top: `${Math.max(4, quote.y)}px` }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { emitQuote(quoteBlock(quote.text)); setQuote(null); }}
        >
          <IconAt size={13} />
          <span>引用</span>
        </button>
      ) : null}
    </div>
  );
}
