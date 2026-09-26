/** 计划卡：计划模式回合内展示模型产出计划，待用户批准 / 驳回；批准后才进入执行。 */
import { useState } from 'react';
import { Markdown } from '../markdown';
import { IconCheck, IconClose, IconList, IconShield } from '../icons';
import type { PlanView } from '../types';

type Props = {
  plan: PlanView;
  onDecide?: (decision: 'approve' | 'reject') => void;
};

export function PlanCard({ plan, onDecide }: Props) {
  const [open, setOpen] = useState(true);
  const pending = plan.decided === 'pending';
  return (
    <div className={`plancard pc-${plan.decided}`}>
      <button type="button" className="plancard-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconList size={14} />
        <span>{pending ? '计划待批准' : plan.decided === 'approved' ? '计划已批准，执行中' : '计划已驳回'}</span>
        <span className="plancard-state">
          {plan.decided === 'approved' ? <IconCheck size={13} /> : null}
          {plan.decided === 'rejected' ? <IconClose size={13} /> : null}
          {pending ? <IconShield size={13} /> : null}
        </span>
      </button>
      {open ? (
        <div className="plancard-body">
          <Markdown text={plan.text || '（计划为空）'} />
          {pending && onDecide ? (
            <div className="perm-actions">
              <button type="button" className="btn btn-accent" onClick={() => onDecide('approve')}>批准执行</button>
              <button type="button" className="btn btn-danger" onClick={() => onDecide('reject')}>驳回</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
