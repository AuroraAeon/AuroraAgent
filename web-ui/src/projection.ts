/** 会话转录 → 可见历史投影（纯函数，测试与组件共用）。
 *  一条 assistant 视图 = 一个模型轮的产出：文本 + 思考 + 工具卡片 + 用量脚注；
 *  出现新工具调用即开启新视图，保证多轮 turn 的历史按轮次分组。 */
import { fmtCost, projectTurns } from '../../util/agent/transcript.mjs';
import type { MsgView, SessionRecord, ToolView } from './types';

export function projectRecords(records: SessionRecord[]): MsgView[] {
  // 分组规则（用户消息 / 模型轮切分）的单一真值源在 util/agent/transcript.mjs，终端同源
  const { turns } = projectTurns(records as unknown[]);
  return turns.map((t, idx) => {
    if (t.kind === 'user') return { kind: 'user', key: `u${idx}`, text: t.text, at: t.at };
    if (t.kind === 'system') return { kind: 'system', key: `s${idx}`, text: t.text };
    return {
      kind: 'assistant', key: `a${idx}`, text: t.text, thinking: t.thinking, at: t.at,
      tools: t.tools.map((tl) => ({
        id: tl.id, name: tl.name, params: tl.args,
        phase: tl.ok === null ? 'running' : tl.ok ? 'done' : 'failed',
        output: tl.output, ...(tl.extra ? { extra: tl.extra as ToolView['extra'] } : {}),
      })),
      usage: t.usage,
    };
  });
}

/** 费用行：零值 ¥0，其余走共享 fmtCost（终端同源） */
export const fmtCostYen = (cost: number): string => (!cost ? '¥0' : `¥${fmtCost(cost)}`);

/** 相对时间：刚刚 / n 分钟前 / n 小时前 / 昨天 / M-DD */
export function fmtRel(iso?: string): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 172_800_000) return '昨天';
  const d = new Date(then);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}
