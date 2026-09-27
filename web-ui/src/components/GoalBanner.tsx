/** 目标横幅：会话级 goal 的状态芯片 + 用量/预算/轮次 + 验证结论 + 用户面动作（与终端 /goal、REST 面同源）。
 * 零 emoji、全设计令牌；恢复入口按状态裁剪（complete / budget_limited 不给恢复，与后端 canTransition 一致）。
 * live elapsed：仅 active 且无 executionWait 时按 1s tick 本地插值，服务端新快照到达即重置偏移。 */
import { useEffect, useRef, useState } from 'react';
import { IconStop, IconTag } from '../icons';
import { GOAL_STATUS_LABELS, GOAL_WAIT_LABELS, goalActionsFor } from '../types';
import type { GoalState } from '../types';
import { goalActionHint, formatGoalReceipt } from '../../../util/agent/goal/command.mjs';

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60 > 0 ? `${s % 60}s` : ''}` : `${s}s`;
};
const VERDICT_LABELS: Record<string, string> = {
  met: '已达到', not_met: '未达到', impossible: '判定不可行', unavailable: '验证不可用', inconclusive: '无结论',
};

type Props = {
  goal: GoalState;
  onAction: (action: 'pause' | 'resume' | 'stop') => void;
};

export function GoalBanner({ goal, onAction }: Props) {
  const actions = goalActionsFor(goal.status);
  const live = goal.status === 'active' && !goal.executionWait;
  const [liveSecs, setLiveSecs] = useState(0);
  const lastTime = useRef(goal.timeUsedSeconds);
  // 服务端每次用量快照到达即重置本地插值（新基线含已累计的轮内活跃秒数）
  useEffect(() => {
    if (goal.timeUsedSeconds !== lastTime.current) lastTime.current = goal.timeUsedSeconds;
    setLiveSecs(0);
  }, [goal.timeUsedSeconds]);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setLiveSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
  const elapsed = fmtTime(goal.timeUsedSeconds + (live ? liveSecs : 0));
  const v = goal.lastVerification;
  return (
    <div className="goalbanner">
      <div className="goalbanner-head">
        <IconTag size={14} />
        <span className={`goalbanner-chip gb-${goal.status}`} title={goal.statusReason || undefined}>{GOAL_STATUS_LABELS[goal.status]}</span>
        <span className="goalbanner-objective" title={goal.objective}>{goal.objective}</span>
        <span className="goalbanner-usage">
          {fmtTokens(goal.tokensUsed)}{goal.tokenBudget != null ? ` / ${fmtTokens(goal.tokenBudget)}` : ''} · {goal.turnsUsed} 轮 · {elapsed}
        </span>
      </div>
      {goal.executionWait ? <div className="goalbanner-wait">{GOAL_WAIT_LABELS[goal.executionWait.reason] || '等待中'}…</div> : null}
      {v ? (
        <div className="goalbanner-verify">
          最近验证：{VERDICT_LABELS[v.verdict] || v.verdict}
          {v.verdict === 'not_met' && v.notMetStreak ? `（连续 ${v.notMetStreak} 次）` : ''}
          {v.evidence ? ` · ${v.evidence}` : ''}
        </div>
      ) : null}
      {goal.status === 'budget_limited' ? <div className="goalbanner-hint">预算已耗尽：在输入框输入 /goal budget=更大值 或 /goal budget=clear 调整后续跑</div> : null}
      {goal.status === 'complete' ? <div className="goalbanner-hint">{formatGoalReceipt(goal)}；/goal &lt;新目标内容&gt; 开始下一轮追踪</div> : null}
      <div className="goalbanner-hint">{goalActionHint(goal.status)}</div>
      {actions.length ? (
        <div className="goalbanner-actions">
          {actions.includes('pause') ? <button type="button" className="btn" onClick={() => onAction('pause')}>暂停</button> : null}
          {actions.includes('resume') ? <button type="button" className="btn btn-accent" onClick={() => onAction('resume')}>恢复</button> : null}
          {actions.includes('stop') ? <button type="button" className="btn btn-danger" onClick={() => onAction('stop')}><IconStop size={12} />停止</button> : null}
        </div>
      ) : null}
    </div>
  );
}
