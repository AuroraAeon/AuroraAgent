/** 目标横幅：会话级 goal 的状态芯片 + 用量/预算/轮次 + 验证结论 + 用户面动作（与终端 /goal、REST 面同源）。
 * 零 emoji、全设计令牌；恢复入口按状态裁剪（complete / budget_limited 不给恢复，与后端 canTransition 一致）。
 * live elapsed：仅 active 且无 executionWait 时按 1s tick 本地插值，服务端新快照到达即重置偏移。
 * complete 与 MiniMax banner 一致：横幅隐藏，完成回执由 notice 消息承载（见 App.tsx formatGoalReceipt）。
 * 等待标签对齐 MiniMax goalPresentation：active 且有 executionWait 时用等待原因替换状态标签（配色保留状态色）。
 * not_met 缺口对齐 MiniMax latestVerificationSummary：展示前 2 条 missing，超出记 +N。 */
import { useEffect, useState } from 'react';
import { IconStop, IconTag } from '../icons';
import { GOAL_STATUS_LABELS, GOAL_WAIT_LABELS, goalActionsFor } from '../types';
import type { GoalState } from '../types';
import { goalActionHint } from '../../../util/agent/goal/command.mjs';
import { formatGoalCount, formatGoalDuration } from '../../../util/agent/goal/budget.mjs';

const VERDICT_LABELS: Record<string, string> = {
  met: '已达到', not_met: '未达到', impossible: '判定不可行', unavailable: '验证不可用', inconclusive: '无结论',
};

type Props = {
  goal: GoalState;
  onAction: (action: 'pause' | 'resume' | 'stop') => void;
};

export function GoalBanner({ goal, onAction }: Props) {
  const live = goal.status === 'active' && !goal.executionWait;
  const [liveSecs, setLiveSecs] = useState(0);
  // 服务端每次用量快照到达即重置本地插值（新基线含已累计的轮内活跃秒数）
  useEffect(() => { setLiveSecs(0); }, [goal.timeUsedSeconds]);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setLiveSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
  // complete：横幅隐藏（回执由 notice 消息承载）——hooks 之后才可提前返回
  if (goal.status === 'complete') return null;
  const actions = goalActionsFor(goal.status);
  const waiting = goal.status === 'active' && goal.executionWait;
  const chipLabel = waiting
    ? GOAL_WAIT_LABELS[goal.executionWait!.reason] || '等待中'
    : GOAL_STATUS_LABELS[goal.status];
  const elapsed = formatGoalDuration(goal.timeUsedSeconds + (live ? liveSecs : 0));
  const v = goal.lastVerification;
  const missing = v && v.verdict === 'not_met' && Array.isArray(v.missing) ? v.missing.filter(Boolean) : [];
  const missingVisible = missing.slice(0, 2);
  const missingOmitted = Math.max(0, missing.length - missingVisible.length);
  return (
    <div className="goalbanner">
      <div className="goalbanner-head">
        <IconTag size={14} />
        <span className={`goalbanner-chip gb-${goal.status}`} title={goal.statusReason || undefined}>{chipLabel}</span>
        <span className="goalbanner-objective" title={goal.objective}>{goal.objective}</span>
        <span className="goalbanner-usage">
          {formatGoalCount(goal.tokensUsed)}{goal.tokenBudget != null ? ` / ${formatGoalCount(goal.tokenBudget)}` : ''} · {goal.turnsUsed} 轮 · {elapsed}
        </span>
      </div>
      {goal.executionWait ? <div className="goalbanner-wait">{GOAL_WAIT_LABELS[goal.executionWait.reason] || '等待中'}…</div> : null}
      {v ? (
        <div className="goalbanner-verify">
          最近验证：{VERDICT_LABELS[v.verdict] || v.verdict}
          {v.verdict === 'not_met' && v.notMetStreak ? `（连续 ${v.notMetStreak} 次）` : ''}
          {v.evidence ? ` · ${v.evidence}` : ''}
          {missingVisible.length ? ` · missing：${missingVisible.join('；')}${missingOmitted > 0 ? ` +${missingOmitted}` : ''}` : ''}
        </div>
      ) : null}
      {goal.status === 'budget_limited' ? <div className="goalbanner-hint">预算已耗尽：在输入框输入 /goal budget=更大值 或 /goal budget=clear 调整后续跑</div> : null}
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
