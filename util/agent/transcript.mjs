/**
 * 转录投影层：会话记录 → 终端与 Web 共用的中性投影 + 工具词表（单一真值源）。
 *   - 工具标签 / 图标键 / 资源摘要：终端单行状态与 Web 工具卡共用，杜绝两端漂移
 *   - projectTurns：把 .jsonl 记录按「用户消息 / 模型轮」分组成中性结构，
 *     Web 的 projection.ts 与终端历史渲染都从这份分组规则取数
 * 纯函数、零依赖；Web 侧经相对路径 import 同一份（Vite 打包进 Bundle，不触 node_modules）。
 */

/** 工具名 → 中文标签（内置 + 技能 + 子代理；MCP 工具走通配推导） */
export const TOOL_LABELS = {
  read_file: '读取文件', list_dir: '浏览目录', write_file: '写入文件',
  edit_file: '编辑文件', shell: '执行命令', web_fetch: '抓取网页',
  grep: '搜索内容', glob: '查找文件', todo: '待办清单', skill: '加载技能',
  task: '派发子代理',
};

/** MCP 工具名 → 可读标签：mcp__<服务器>__<工具> → 「<服务器>.<工具>（MCP）」 */
export function toolLabel(name) {
  const n = String(name || '');
  if (TOOL_LABELS[n]) return TOOL_LABELS[n];
  const m = /^mcp__([^_]+)__(.+)$/.exec(n);
  if (m) return `${m[1]}.${m[2]}（MCP）`;
  return n;
}

/** 工具名 → 图标键（Web 映射到内联 SVG，终端忽略） */
export function toolIconKey(name) {
  const n = String(name || '');
  if (n.startsWith('mcp__')) return 'plug';
  const keys = {
    read_file: 'file', list_dir: 'folder', write_file: 'write', edit_file: 'edit',
    shell: 'shell', web_fetch: 'globe', grep: 'search', glob: 'search',
    todo: 'list', skill: 'wrench', task: 'task',
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
  return String(a.path || a.dir || '');
}

/** 费用格式化：小额 6 位、常规 4 位（终端脚注与 Web 用量行同源） */
export function fmtCost(cost) {
  const c = Number(cost) || 0;
  return c < 0.01 ? c.toFixed(6) : c.toFixed(4);
}

/**
 * 记录 → 中性轮次投影。分组规则（与 Web 历史渲染契约一致）：
 *   user / summary 开启新段；assistant / thinking 归属当前轮；
 *   tool_call 之后再来 assistant / thinking 即开启新轮（一个模型轮一组）。
 * @returns {{ turns: Array<{ kind:'user'|'system'|'round', text, thinking, tools, usage, at }> }}
 *   round.tools: [{ id, name, args, ok, output, extra }]
 */
export function projectTurns(records) {
  const turns = [];
  let cur = null;
  const flush = () => { cur = null; };
  const ensureRound = (at) => {
    if (!cur || cur.kind !== 'round') { cur = { kind: 'round', text: '', thinking: '', tools: [], usage: null, at }; turns.push(cur); }
    return cur;
  };
  // 新文本 / 思考：若当前轮已有工具调用则开新轮（一个模型轮一组）；工具记录永远归属当前轮（并行调用不拆散）
  const round = (at) => {
    if (cur && cur.kind === 'round' && cur.tools.length > 0) cur = null;
    return ensureRound(at);
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
        round(at).text += (cur.text ? '\n' : '') + String(r.text || '');
        break;
      case 'thinking':
        round(at).thinking += String(r.text || '');
        break;
      case 'tool_call':
        ensureRound(at).tools.push({ id: String(r.id || `t${idx}`), name: String(r.name || ''), args: r.args ?? null, ok: null, output: '', extra: null });
        break;
      case 'tool_result': {
        const rr = ensureRound(at);
        const hit = rr.tools.find((t) => t.id === String(r.id || ''));
        const row = hit || { id: String(r.id || `t${idx}`), name: String(r.name || ''), args: null, ok: null, output: '', extra: null };
        if (!hit) rr.tools.push(row);
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
  return { turns };
}
