/** 会话转录 → 可见历史投影（纯函数，测试与组件共用）。
 *  一条 assistant 视图 = 一个用户轮的产出：parts 时间线（文本段与工具卡片交错）+
 *  思考 + 用量脚注；回答不被每次工具调用切断，与流式 turn 的 parts 同形态。 */
import { fmtCost, projectTurns } from '../../util/agent/transcript.mjs';
import type { MsgPart, MsgView, SessionRecord } from './types';

export function projectRecords(records: SessionRecord[]): MsgView[] {
  // 分组规则（用户消息 / 用户轮切分、时间线交错）的单一真值源在 util/agent/transcript.mjs
  const { turns } = projectTurns(records as unknown[]);
  return turns.map((t, idx) => {
    if (t.kind === 'user') return { kind: 'user', key: `u${idx}`, text: t.text, at: t.at };
    if (t.kind === 'system') return { kind: 'system', key: `s${idx}`, text: t.text };
    return {
      kind: 'assistant', key: `a${idx}`, at: t.at, thinking: t.thinking,
      parts: t.parts.map((p): MsgPart => (p.kind === 'text'
        ? { kind: 'text', text: p.text }
        : {
          kind: 'tool', id: p.id, name: p.name, params: p.args,
          phase: p.ok === null ? 'running' : p.ok ? 'done' : 'failed',
          output: p.output, ...(p.extra ? { extra: p.extra as Extract<MsgPart, { kind: 'tool' }>['extra'] } : {}),
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
