/** 目标横幅：会话级 goal 的状态芯片 + 用量/预算 + 用户面动作（与终端 /goal、REST 面同源）。
 * 零 emoji、全设计令牌；恢复入口按状态裁剪（complete / budget_limited 不给恢复，与后端 canTransition 一致）。 */
import { IconStop, IconTag } from '../icons';
import { GOAL_STATUS_LABELS, GOAL_WAIT_LABELS, goalActionsFor } from '../types';
import type { GoalState } from '../types';

const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
const fmtTime = (s: number) => {
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60 > 0 ? `${s % 60}s` : ''}` : `${s}s`;
};

type Props = {
  goal: GoalState;
  onAction: (action: 'pause' | 'resume' | 'stop') => void;
};

export function GoalBanner({ goal, onAction }: Props) {
  const actions = goalActionsFor(goal.status);
  return (
    <div className="goalbanner">
      <div className="goalbanner-head">
        <IconTag size={14} />
        <span className={`goalbanner-chip gb-${goal.status}`} title={goal.statusReason || undefined}>{GOAL_STATUS_LABELS[goal.status]}</span>
        <span className="goalbanner-objective" title={goal.objective}>{goal.objective}</span>
        <span className="goalbanner-usage">
          {fmtTokens(goal.tokensUsed)}{goal.tokenBudget != null ? ` / ${fmtTokens(goal.tokenBudget)}` : ''} · {fmtTime(goal.timeUsedSeconds)}
        </span>
      </div>
      {goal.executionWait ? <div className="goalbanner-wait">{GOAL_WAIT_LABELS[goal.executionWait.reason] || '等待中'}…</div> : null}
      {goal.status === 'budget_limited' ? <div className="goalbanner-hint">预算已耗尽：在终端输入 /goal budget 更大值 或 /goal budget clear 调整后续跑</div> : null}
      {goal.status === 'complete' ? <div className="goalbanner-hint">目标已完成：让模型提出新目标即开始下一轮追踪</div> : null}
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
