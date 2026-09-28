/** 目标条：会话级 goal 的单行状态条，停靠在输入框上方（对齐 dsh web 的 GoalBar：一图标一状态一目标一用量一动作）。
 * 零 emoji、全设计令牌；complete 不渲染（完成回执由 notice 消息承载，见 App.tsx formatGoalReceipt）。
 * live elapsed：仅 active 且无 executionWait 时按 1s tick 本地插值，服务端新快照到达即重置偏移。
 * 等待标签对齐 MiniMax goalPresentation：active 且有 executionWait 时用等待原因替换状态标签。
 * 验证结论压成一颗 caption 芯片（verdict × 连击），缺失项与提示收进 title，行内保持一行。 */
import { useEffect, useState } from 'react';
import { IconPause, IconPlay, IconStop, IconTag } from '../icons';
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

export function GoalBar({ goal, onAction }: Props) {
  const live = goal.status === 'active' && !goal.executionWait;
  const [liveSecs, setLiveSecs] = useState(0);
  // 服务端每次用量快照到达即重置本地插值（新基线含已累计的轮内活跃秒数）
  useEffect(() => { setLiveSecs(0); }, [goal.timeUsedSeconds]);
  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => setLiveSecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [live]);
  // complete：不渲染（hooks 之后才可提前返回）
  if (goal.status === 'complete') return null;
  const actions = goalActionsFor(goal.status);
  const waiting = goal.status === 'active' && goal.executionWait;
  const chipLabel = waiting
    ? GOAL_WAIT_LABELS[goal.executionWait!.reason] || '等待中'
    : GOAL_STATUS_LABELS[goal.status];
  const elapsed = formatGoalDuration(goal.timeUsedSeconds + (live ? liveSecs : 0));
  const usage = `${formatGoalCount(goal.tokensUsed)}${goal.tokenBudget != null ? ` / ${formatGoalCount(goal.tokenBudget)}` : ''} · ${goal.turnsUsed} 轮 · ${elapsed}`;
  const v = goal.lastVerification;
  const hint = goalActionHint(goal.status);
  const title = [goal.statusReason, hint].filter(Boolean).join(' · ') || undefined;
  return (
    <div className="goalbar" data-goal-bar>
      <div className="goalbar-bar">
        <span className="goalbar-glyph" aria-hidden="true"><IconTag size={14} /></span>
        <span className={`goalbar-chip gb-${goal.status}`} title={title}>{chipLabel}</span>
        <span className="goalbar-objective" title={goal.objective}>{goal.objective}</span>
        {v ? (
          <span
            className="goalbar-verify"
            title={[VERDICT_LABELS[v.verdict] || v.verdict, v.evidence, ...(v.verdict === 'not_met' && Array.isArray(v.missing) ? v.missing.filter(Boolean) : [])].filter(Boolean).join(' · ')}
          >
            验证：{VERDICT_LABELS[v.verdict] || v.verdict}{v.verdict === 'not_met' && v.notMetStreak ? ` ×${v.notMetStreak}` : ''}
          </span>
        ) : null}
        <span className="goalbar-usage">{usage}</span>
        <span className="goalbar-actions">
          {actions.includes('pause') ? (
            <button type="button" className="goalbar-btn" title="暂停目标" aria-label="暂停目标" onClick={() => onAction('pause')}>
              <IconPause size={13} />
            </button>
          ) : null}
          {actions.includes('resume') ? (
            <button type="button" className="goalbar-btn" title="恢复目标" aria-label="恢复目标" onClick={() => onAction('resume')}>
              <IconPlay size={13} />
            </button>
          ) : null}
          {actions.includes('stop') ? (
            <button type="button" className="goalbar-btn goalbar-btn-danger" title="停止目标" aria-label="停止目标" onClick={() => onAction('stop')}>
              <IconStop size={13} />
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}
