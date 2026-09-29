/** 单条消息渲染：用户 / 助手（思考 + 正文 + 工具 + 用量脚注）/ 系统（压缩提示）。 */
import { memo, useEffect, useRef, useState } from 'react';
import { Markdown } from '../markdown';
import { IconAlert, IconBulb, IconChevronRight, IconTag } from '../icons';
import { isReasoningSummaryOverflowing, resolveReasoningStreamingSummary } from '../reasoning-summary.mjs';
import type { MsgView } from '../types';

import { ToolCard } from './ToolCard';
import { fmtCostYen } from '../projection';



/** 思考过程（复刻 ZCode Reasoning / ReasoningTrigger）：与工具摘要行同一套紧缩密度语言——
 *  无框内联行，brain 16px + 「正在思考 / 思考」标签（medium、subtle 色），流式且收起时右侧
 *  挂最后一个非空行的单行滚动摘要（视口恒宽、永远露出最新 token、溢出才渐隐遮罩，
 *  ZCode streamingSummary 语义），摘要前一个 · 分隔；16px chevron 静止透明、hover 才显、
 *  展开态转向 90°。默认收起；流式结束自动收起（用户手动展开过则不打扰——ZCode autoCollapse 语义）。
 *  展开内容是纯文本 + 左侧导线 + 限高滚动：不走 Markdown，流式 chunk 反复解析长思考会掉帧
 *  （ZCode 同取舍：thought 内容按纯文本展示并保留换行）。
 *  耗时文案未移植：投影层不记录思考起止时间，不编造数据（ZCode 无 duration 时的兜底是
 *  「持续了几秒」，对本项目同样属于猜测，故只留「思考」标签）。 */
function ThinkingBlock({ text, defaultOpen = false, streaming = false }: { text: string; defaultOpen?: boolean; streaming?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const interacted = useRef(false);
  const sumRef = useRef<HTMLSpanElement>(null);
  const [sumOverflow, setSumOverflow] = useState(false);
  useEffect(() => {
    if (!streaming && !interacted.current) setOpen(false);
  }, [streaming]);
  // 摘要只在流式且收起时出现：展开后正文已在位，再挂一行摘要是重复信息（ZCode 同规则）
  const summary = streaming && !open ? resolveReasoningStreamingSummary(text) : '';
  useEffect(() => {
    const el = sumRef.current;
    if (!el || !summary) return;
    // 内容增长 / 视口变化后重测溢出，并把单行视口推到末尾——旧内容向左移，最新 token 恒可见
    // （ZCode syncSummaryViewport + scrollReasoningSummaryToEnd）
    const sync = () => {
      setSumOverflow(isReasoningSummaryOverflowing(el.clientWidth, el.scrollWidth));
      el.scrollLeft = el.scrollWidth;
    };
    sync();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    return () => ro.disconnect();
  }, [summary]);
  const toggle = () => { interacted.current = true; setOpen((v) => !v); };
  return (
    <div className={`think${open ? ' open' : ''}`}>
      <button type="button" className="think-head" aria-expanded={open} onClick={toggle}>
        <IconBulb size={16} />
        <span className={`think-label${streaming ? ' stream' : ''}`}>{streaming ? '正在思考' : '思考'}</span>
        {summary ? <span className="think-dot" aria-hidden="true">·</span> : null}
        {summary ? <span className={`think-summary${sumOverflow ? ' over' : ''}`} ref={sumRef} aria-hidden="true">{summary}</span> : null}
        <IconChevronRight size={16} className="think-chev" />
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
// 行根元素带 hist 类：CSS 对其 content-visibility:auto，视口外的历史行跳过渲染
// （对齐 ZCode 时间线做法；contain-intrinsic-size:auto 记住上次高度，滚动条不跳）。
export const Message = memo(function Message({ msg, onDecide }: Props) {
  if (msg.kind === 'user') {
    return (
      <div className="row row-user hist is-user" data-turn-key={msg.key}>
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
    <div className="row row-ai hist is-assistant">
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
