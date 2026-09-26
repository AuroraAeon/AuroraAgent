/** 会话转录 → 可见历史投影（纯函数，测试与组件共用）。
 *  一条 assistant 视图 = 一个模型轮的产出：文本 + 思考 + 工具卡片 + 用量脚注；
 *  出现新工具调用即开启新视图，保证多轮 turn 的历史按轮次分组。 */
import type { MsgView, SessionRecord, ToolView } from './types';

function newAssistant(key: string, at?: string): Extract<MsgView, { kind: 'assistant' }> {
  return { kind: 'assistant', key, text: '', thinking: '', tools: [], usage: null, at };
}

export function projectRecords(records: SessionRecord[]): MsgView[] {
  const out: MsgView[] = [];
  let cur: Extract<MsgView, { kind: 'assistant' }> | null = null;
  const flush = () => { if (cur) { out.push(cur); cur = null; } };

  records.forEach((r, idx) => {
    const at = r.at;
    switch (r.t) {
      case 'user':
        flush();
        out.push({ kind: 'user', key: `u${idx}`, text: String(r.text || ''), at });
        break;
      case 'summary':
        flush();
        out.push({ kind: 'system', key: `s${idx}`, text: String(r.text || '') });
        break;
      case 'assistant': {
        if (cur && cur.tools.length > 0) flush();
        if (!cur) cur = newAssistant(`a${idx}`, at);
        cur.text += (cur.text ? '\n' : '') + String(r.text || '');
        break;
      }
      case 'thinking': {
        if (cur && cur.tools.length > 0) flush();
        if (!cur) cur = newAssistant(`a${idx}`, at);
        cur.thinking += String(r.text || '');
        break;
      }
      case 'tool_call': {
        if (!cur) cur = newAssistant(`a${idx}`, at);
        const view: ToolView = { id: String(r.id || `t${idx}`), name: String(r.name || ''), params: r.args, phase: 'running', output: '' };
        cur.tools.push(view);
        break;
      }
      case 'tool_result': {
        if (!cur) cur = newAssistant(`a${idx}`, at);
        const hit = cur.tools.find((t) => t.id === String(r.id || ''));
        if (hit) {
          hit.output = String(r.output || '');
          hit.phase = r.ok ? 'done' : 'failed';
        } else {
          cur.tools.push({ id: String(r.id || `t${idx}`), name: String(r.name || ''), params: null, phase: r.ok ? 'done' : 'failed', output: String(r.output || '') });
        }
        break;
      }
      case 'usage': {
        if (!cur) cur = newAssistant(`a${idx}`, at);
        const acc = cur.usage || { inputTokens: 0, outputTokens: 0, cost: 0 };
        acc.inputTokens += Number(r.inputTokens || 0);
        acc.outputTokens += Number(r.outputTokens || 0);
        acc.cost = Number((acc.cost + Number(r.cost || 0)).toFixed(6));
        cur.usage = acc;
        break;
      }
    }
  });
  flush();
  return out;
}

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
