/**
 * 上下文组装与压缩（对齐 OpenBitFun 的 Context / ContextCompression 职责，按本地场景精简）：
 *   assembleMessages  会话记录 → 上游消息序列（系统提示 + 历史投影，thinking/usage 不回填）
 *   planCompaction    超长时把早期记录摘出去总结，保留最近若干轮原文
 *   压缩本身需要一次模型调用，由 loop.mjs 执行；本模块只提供规划与提示词。
 */
import { estimateTokens } from '../sse.mjs';
import { toolMessageContent } from './tools.mjs';
import { skillCatalogBlock } from './skills.mjs';
import { rulesBlock, collectCandidatePaths, RULE_TOKEN_BUDGET } from './rules.mjs';

const DEFAULT_WINDOW = 128000;

/** 悬空 tool_call 的合成结果（对齐 OpenBitFun v1.0.2 #3148：fork 与中断恢复边界必须补齐完整工具交换）。
 *  turn 在工具执行前被中止 / 异常时，转录里留下没有配对 tool_result 的 tool_call；不补这条，
 *  消息序列以「带 tool_calls 的 assistant 消息」收尾，OpenAI 兼容上游直接 400，Anthropic 也会拒收，
 *  派生与会话恢复后的第一轮必炸。 */
const INTERRUPTED_TOOL_RESULT = '[工具执行被中断，未产生结果]';

/**
 * 规则条件激活的候选路径：会话记录里工具真正碰过的文件（硬证据）。
 * 用户当前这句话的路径由调用方经 assembleMessages 的 rules 入参提前算好（loop.mjs），
 * 这里只补「历史证据」——两者合并才是一次完整的请求上下文。
 */
function ruleCandidatePaths(records = []) {
  return collectCandidatePaths({ records });
}

/** 提供方声明的上下文窗口；未声明或非法时回退 128k */
export function contextWindowOf(provider) {
  const n = Number(provider?.capacity?.contextWindow);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_WINDOW;
}

/** 估算整段消息序列的 token 占用（内容序列化后约 4 字符 1 token，外加每条固定开销） */
export function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => {
    const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    const tools = m.tool_calls ? JSON.stringify(m.tool_calls) : '';
    return sum + estimateTokens(body) + estimateTokens(tools) + 4;
  }, 0);
}

/** 是否触发压缩：估算值超过 窗口 × 阈值 */
export function needsCompaction(messages, { windowTokens = DEFAULT_WINDOW, ratio = 0.7 }) {
  return estimateMessagesTokens(messages) > Math.floor(windowTokens * ratio);
}

/**
 * 会话记录 → 上游消息序列。
 * tool_call / tool_result 成对投影为 assistant.tool_calls + role:tool；
 * summary 记录投影为系统消息（早期摘要）；thinking / usage 不回填（省 token 且不污染上下文）。
 */
export function assembleMessages({ harness, workspace, records = [], skills = [], extraSystem = '', rules = [], ruleToggles = null, ruleBudget = RULE_TOKEN_BUDGET, rulePaths = null } = {}) {
  const catalog = skillCatalogBlock(skills); // L1 目录：带 token 预算，超预算的技能只留 /<名称> 显式入口
  // 规则（用户指令层）拼在 extraSystem 之前：它是项目约定，优先级高于本轮临时指令；
  // 超预算的规则降级为 name + description，绝不整块丢弃（rulesBlock）
  const rulesSeg = rulesBlock(rules, { paths: rulePaths || ruleCandidatePaths(records), toggles: ruleToggles, budget: ruleBudget });
  // 稳定段（harness 提示 / 工作目录 / 规则 / 技能清单）与易变尾（当前时间 / 本轮追加指令）
  // 拆成两条系统消息：wire.mjs 只在稳定段收尾打提示缓存断点，时间戳因此不会每轮把缓存打废
  const stable = [
    harness.systemPrompt,
    '',
    `工作目录：${workspace}`,
    '文件工具只能访问工作目录内的路径；修改用户文件前先说清将要改什么。',
  ].join('\n')
    + (rulesSeg.block ? `\n\n${rulesSeg.block}` : '')
    + (catalog ? `\n\n${catalog}` : '');
  const volatile = [
    `当前时间：${new Date().toISOString()}`,
    ...(extraSystem ? [extraSystem] : []),
  ].join('\n');
  const messages = [{ role: 'system', content: stable }];
  if (volatile) messages.push({ role: 'system', content: volatile });
  const pending = [];
  // 预扫：有真实 tool_result 的调用 id，其余即悬空调用（中断残留），flush 时补合成结果。
  // 之所以预扫而非「见到结果就摘掉 pending」：真实结果记录排在 flush 之后，边扫边判会把正常配对误判成悬空。
  const answered = new Set();
  for (const r of records) if (r.t === 'tool_result') answered.add(r.id);
  const flushPending = () => {
    if (!pending.length) return;
    const calls = pending.splice(0);
    messages.push({ role: 'assistant', content: '', tool_calls: calls });
    for (const call of calls) {
      if (answered.has(call.id)) continue;
      messages.push({ role: 'tool', tool_call_id: call.id, content: INTERRUPTED_TOOL_RESULT });
    }
  };
  for (const r of records) {
    switch (r.t) {
      case 'summary':
        flushPending();
        messages.push({ role: 'system', content: `【早期对话摘要】\n${r.text}` });
        break;
      case 'user':
        flushPending();
        messages.push({ role: 'user', content: r.text });
        break;
      case 'assistant':
        flushPending();
        messages.push({ role: 'assistant', content: r.text });
        break;
      case 'tool_call':
        pending.push({ id: r.id, type: 'function', function: { name: r.name, arguments: JSON.stringify(r.args || {}) } });
        break;
      case 'tool_result': {
        const call = pending.find((p) => p.id === r.id);
        if (!call) break; // 无配对调用（异常数据）时丢弃，保证协议合法
        flushPending();
        // 带 extra.image 的工具结果（computer_use 截图）投影成多模态 tool content，模型复盘时看得见画面
        messages.push({ role: 'tool', tool_call_id: r.id, content: toolMessageContent(r.output, r.extra) });
        break;
      }
      default:
        break; // thinking / usage 等不进上下文
    }
  }
  flushPending();
  return messages;
}

/** 单条记录的 token 估算（压缩预算投影用：内容 + 工具参数一并计入） */
function recordTokens(r) {
  const body = r.t === 'tool_call'
    ? `${r.name || ''} ${JSON.stringify(r.args || {})}`
    : `${r.name || ''} ${String(r.output ?? r.text ?? '')}`;
  return estimateTokens(body) + 4;
}

/**
 * 安全切点预扫：下标 i 可作切点，当且仅当 records[0..i-1] 里没有任何「调用已发出、
 * 结果还没出现」的 tool_call。切点落在悬空调用中间会把一对 tool_call / tool_result
 * 劈成两半——头部的调用等不到结果，尾部的结果找不到调用，投影出来的消息序列两边都违法，
 * 上游直接 400。悬空合成只兜得住「转录结尾」那一种，压缩中途不能依赖它。
 * @returns {boolean[]} 长度 records.length + 1 的安全标记
 */
export function safeCutPoints(records = []) {
  const pending = new Set();
  const safe = new Array(records.length + 1).fill(false);
  safe[0] = true;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.t === 'tool_call') pending.add(r.id);
    else if (r.t === 'tool_result') pending.delete(r.id);
    safe[i + 1] = pending.size === 0;
  }
  return safe;
}

/**
 * 定切点：保留最近若干用户轮原文，且满足两条硬约束——
 *   1. 切点必须落在无悬空 tool_call 的边界（safeCutPoints）；
 *   2. 保留下来的尾部按目标 token 预算投影（tailBudget = 窗口 × ratio × 0.6）：
 *      压缩完还得给摘要与新内容留地方，尾部超预算就再多摘几轮。
 * 用户轮不足 keepTurns + 1、或没有任何安全边界时返回 -1。
 * @param {number} keepTurns 至少保留的用户轮数（预算允许时是下限）
 */
export function findCutIndex(records = [], keepTurns = 4, { windowTokens = DEFAULT_WINDOW, ratio = 0.7 } = {}) {
  const safe = safeCutPoints(records);
  const userIdx = [];
  records.forEach((r, i) => { if (r.t === 'user' && safe[i]) userIdx.push(i); });
  if (userIdx.length <= keepTurns) return -1;
  const tailBudget = Math.max(2000, Math.floor(windowTokens * ratio * 0.6));
  // 从「保留最多」的候选往老走：尾部 token 从 newest 累加到 oldest，最后一个不超预算的即所求
  const suffix = new Array(records.length + 1).fill(0);
  for (let i = records.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + recordTokens(records[i]);
  let cut = -1;
  for (let k = 0; k < userIdx.length; k++) {
    if (userIdx.length - k < keepTurns) break; // 至少留 keepTurns 个用户轮（尾部含第 k..末轮）
    if (suffix[userIdx[k]] <= tailBudget) cut = userIdx[k];
  }
  if (cut < 6) return -1; // 头部太薄，压缩省不下多少
  return cut;
}

/**
 * 压缩规划：保留最近 keepTurns 个用户轮原文，更早的记录进 head 交给模型总结。
 * 记录太少或没有安全切点时返回 null（不值得压缩）。
 */
export function planCompaction(records = [], keepTurns = 4, opts = {}) {
  const cut = findCutIndex(records, keepTurns, opts);
  if (cut < 0) return null;
  return { head: records.slice(0, cut), tail: records.slice(cut), cut };
}

/**
 * 被摘掉的工具工作聚成一份清单：压缩只留对话摘要时，「读过哪些文件、改过哪些文件、
 * 跑过哪些命令」这类事实最容易丢，而后续轮次恰恰要靠它们判断该不该再读一遍。
 * 与模型摘要合并进压缩输入——模型负责叙事，这份清单负责事实。
 */
export function droppedWorkSummary(head = []) {
  const read = new Set(), changed = new Set(), cmds = [], patterns = [], urls = [], tasks = [], skills = [];
  for (const r of head) {
    if (r.t !== 'tool_call') continue;
    const a = r.args || {};
    const p = a.path ? String(a.path) : '';
    switch (r.name) {
      case 'read_file': if (p) read.add(p); break;
      case 'list_dir': if (p) read.add(`${p}/（列目录）`); break;
      case 'write_file': case 'edit_file': if (p) changed.add(p); break;
      case 'shell': if (a.command) cmds.push(String(a.command).slice(0, 120)); break;
      case 'grep': if (a.pattern) patterns.push(String(a.pattern).slice(0, 80)); break;
      case 'glob': if (a.pattern) patterns.push(`glob ${String(a.pattern).slice(0, 80)}`); break;
      case 'web_fetch': if (a.url) urls.push(String(a.url).slice(0, 160)); break;
      case 'task': tasks.push(String(a.task || '').slice(0, 80)); break;
      case 'skill': skills.push(String(a.name || '').slice(0, 40)); break;
      default: break;
    }
  }
  const lines = [];
  const push = (label, arr) => { if (arr.length) lines.push(`- ${label}：${arr.slice(0, 40).join('、')}`); };
  push('读过的文件', [...read]);
  push('改过的文件', [...changed]);
  push('跑过的命令', cmds);
  push('检索模式', patterns);
  push('抓取的链接', urls);
  push('派发的子任务', tasks);
  push('加载过的技能', skills);
  return lines.join('\n');
}

/** 总结用的消息序列（无工具、纯文本）。
 *  技能内容是必须持续遵循的规范，压缩时完整保留、不按通用上限截断：
 *  skill 工具结果与带 skill 标记的用户记录（/<技能名> 斜杠注入）都不许被摘丢。 */
export function compactionMessages(head = []) {
  const transcript = head.map((r) => {
    if (r.t === 'tool_call') return `[调用工具 ${r.name}] ${JSON.stringify(r.args || {})}`;
    if (r.t === 'tool_result') {
      if (r.name === 'skill') return `[技能规范 ${r.name}] ${String(r.output || '')}`;
      return `[工具结果] ${String(r.output || '').slice(0, 500)}`;
    }
    if (r.t === 'user' && r.skill) return `[用户 /${r.skill} 技能调用] ${String(r.text || '')}`;
    return `[${r.t}] ${String(r.text || '').slice(0, 1000)}`;
  }).join('\n');
  const work = droppedWorkSummary(head);
  return [
    { role: 'system', content: [
      '你是对话压缩器。把下面的早期对话记录压缩成一份摘要，保留：关键事实与决定、涉及的文件路径、工具执行的结论、未解决的问题。',
      '摘要必须显式列出「涉及的文件路径」清单（读过的、改过的、创建的分开写），后续轮次要靠它判断该不该重新读一遍——漏掉路径就等于白干。',
      '带 [技能规范 ...] 或 [用户 /<技能名> 技能调用] 的内容是本次会话必须持续遵循的技能规范，摘要里要原样延续其要点，不得丢弃或改写。',
      '用户消息附带的「工具工作清单」是从记录里直接提取的事实，与你的摘要合并呈现，不要与之矛盾。',
      '用中文，300 字以内，不要客套。',
    ].join('\n') },
    { role: 'user', content: `${work ? `工具工作清单：\n${work}\n\n` : ''}对话记录：\n${transcript}` },
  ];
}
