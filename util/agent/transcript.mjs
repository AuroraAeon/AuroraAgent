/**
 * 转录投影层：会话记录 → 终端与 Web 共用的中性投影 + 工具词表（单一真值源）。
 *   - 工具标签 / 图标键 / 资源摘要：终端单行状态与 Web 工具卡共用，杜绝两端漂移
 *   - projectTurns：把 .jsonl 记录按「用户消息 / 用户轮」分组成中性结构（用户轮内文本与工具
 *     按时间线交错存 parts，回答不被工具调用切断），Web 的 projection.ts 从这份分组规则取数
 * 纯函数、零依赖；Web 侧经相对路径 import 同一份（Vite 打包进 Bundle，不触 node_modules）。
 */

/** 工具名 → 中文标签（内置 + 技能 + 子代理；MCP 工具走通配推导） */
export const TOOL_LABELS = {
  read_file: '读取文件', list_dir: '浏览目录', write_file: '写入文件',
  edit_file: '编辑文件', shell: '执行命令', web_fetch: '抓取网页',
  grep: '搜索内容', glob: '查找文件', todo: '待办清单', skill: '加载技能',
  task: '派发子代理', cron: '定时任务', computer_use: '屏幕操作', code: '脚本运行',
};

/** MCP 工具名 → 可读标签：mcp__<服务器>__<工具> → 「<服务器>.<工具>（MCP）」 */
export function toolLabel(name) {
  const n = String(name || '');
  if (TOOL_LABELS[n]) return TOOL_LABELS[n];
  const m = /^mcp__([^_]+)__(.+)$/.exec(n);
  if (m) return `${m[1]}.${m[2]}（MCP）`;
  const s = /^task__(.+)$/.exec(n); // 声明式子代理 task__<名称>
  if (s) return `${s[1]}（子代理）`;
  return n;
}

/** 工具名 → 图标键（Web 映射到内联 SVG，终端忽略） */
export function toolIconKey(name) {
  const n = String(name || '');
  if (n.startsWith('mcp__')) return 'plug';
  if (n.startsWith('task__')) return 'task';
  const keys = {
    read_file: 'file', list_dir: 'folder', write_file: 'write', edit_file: 'edit',
    shell: 'shell', web_fetch: 'globe', grep: 'search', glob: 'search',
    todo: 'list', skill: 'wrench', task: 'task', cron: 'clock', computer_use: 'screen', code: 'code',
  };
  return keys[n] || 'wrench';
}

/** 工具资源摘要：文件类取路径，shell 取命令，检索取模式，抓取取 URL（两端一致） */
export function toolResourceOf(name, args) {
  const a = args || {};
  const n = String(name || '');
  if (n === 'shell') return String(a.command || '');
  if (n === 'grep') return String(a.pattern || '');
  if (n === 'web_fetch') return String(a.url || '');
  if (n === 'task') return String(a.tasks?.length ? `${a.tasks.length} 个子任务` : '');
  if (n.startsWith('task__')) return String(a.task || '').slice(0, 60);
  if (n === 'computer_use') return String(a.app || '前台界面');
  if (n === 'cron') {
    const when = a.schedule?.kind === 'cron' ? `cron ${a.schedule?.expr || ''}` : a.schedule?.kind === 'interval' ? `每 ${Math.round(Number(a.schedule?.everyMs || 0) / 1000)} 秒` : '';
    return String(a.job_id || a.name || when || '');
  }
  return String(a.path || a.dir || '');
}

/** 费用格式化：小额 6 位、常规 4 位（终端脚注与 Web 用量行同源） */
export function fmtCost(cost) {
  const c = Number(cost) || 0;
  return c < 0.01 ? c.toFixed(6) : c.toFixed(4);
}

/**
 * 记录 → 中性轮次投影。分组规则（与 Web 历史渲染契约一致）：
 *   user / summary 开启新段；同一用户轮内（直到下一条 user / summary）的全部记录归属同一个 round，
 *   文本与工具调用按时间线交错存于 round.parts——回答不被每次工具调用切断成多条消息；
 *   工具记录永远归属当前轮（并行调用不拆散）。
 * @returns {{ turns: Array<{ kind:'user'|'system'|'round', ... }> }}
 *   round.parts: [{ kind:'text', text } | { kind:'tool', id, name, args, ok, output, extra }]
 *   round.text / round.tools / round.thinking / round.usage：parts 汇总出的兼容视图（旧消费者与终端）
 */
export function projectTurns(records) {
  const turns = [];
  let cur = null;
  const flush = () => { cur = null; };
  const ensureRound = (at) => {
    if (!cur || cur.kind !== 'round') { cur = { kind: 'round', thinking: '', parts: [], usage: null, at }; turns.push(cur); }
    return cur;
  };
  // 同一轮内的文本追到最后文本片段（转录里 assistant 按模型轮整段写入，片段间以换行相接）；
  // 工具之后的新文本开新片段，保住「文字 → 工具 → 文字」的时间线，但不拆轮
  const appendText = (at, text) => {
    const rr = ensureRound(at);
    const t = String(text || '');
    const last = rr.parts[rr.parts.length - 1];
    if (last && last.kind === 'text') last.text += (last.text ? '\n' : '') + t;
    else if (t) rr.parts.push({ kind: 'text', text: t });
  };
  (records || []).forEach((r, idx) => {
    const at = r.at;
    switch (r.t) {
      case 'user':
        flush();
        turns.push({ kind: 'user', text: String(r.text || ''), at });
        break;
      case 'summary':
        flush();
        turns.push({ kind: 'system', text: String(r.text || ''), at });
        break;
      case 'assistant':
        appendText(at, r.text);
        break;
      case 'thinking':
        ensureRound(at).thinking += String(r.text || '');
        break;
      case 'tool_call':
        ensureRound(at).parts.push({ kind: 'tool', id: String(r.id || `t${idx}`), name: String(r.name || ''), args: r.args ?? null, ok: null, output: '', extra: null });
        break;
      case 'tool_result': {
        const rr = ensureRound(at);
        const rid = String(r.id || '');
        // 同 id 多调用（个别上游代理复用 tool_call id）：优先补第一个尚未完结（ok 为 null）的调用，
        // 否则后一个调用的结果会顶掉前一个，让前一个永远停在「执行中」
        const hit = rr.parts.find((p) => p.kind === 'tool' && p.id === rid && p.ok === null)
          || rr.parts.find((p) => p.kind === 'tool' && p.id === rid);
        const row = hit || { kind: 'tool', id: rid || `t${idx}`, name: String(r.name || ''), args: null, ok: null, output: '', extra: null };
        if (!hit) rr.parts.push(row);
        row.ok = r.ok !== false;
        row.output = String(r.output || '');
        if (r.extra) row.extra = r.extra;
        break;
      }
      case 'usage': {
        const rr = ensureRound(at);
        const acc = rr.usage || { inputTokens: 0, outputTokens: 0, cost: 0 };
        acc.inputTokens += Number(r.inputTokens || 0);
        acc.outputTokens += Number(r.outputTokens || 0);
        acc.cost = Number((acc.cost + Number(r.cost || 0)).toFixed(6));
        rr.usage = acc;
        break;
      }
    }
  });
  flush();
  // 兼容视图：text = 各文本片段按序汇总；tools = 工具片段数组（顺序即调用序）
  for (const t of turns) {
    if (t.kind !== 'round') continue;
    t.text = t.parts.filter((p) => p.kind === 'text').map((p) => p.text).join('\n');
    t.tools = t.parts.filter((p) => p.kind === 'tool');
  }
  return { turns };
}
