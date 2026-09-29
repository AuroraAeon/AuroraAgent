/**
 * 上下文组装与压缩（对齐 OpenBitFun 的 Context / ContextCompression 职责，按本地场景精简）：
 *   assembleMessages  会话记录 → 上游消息序列（系统提示 + 历史投影，thinking/usage 不回填）
 *   planCompaction    超长时把早期记录摘出去总结，保留最近若干轮原文
 *   压缩本身需要一次模型调用，由 loop.mjs 执行；本模块只提供规划与提示词。
 */
import { estimateTokens } from '../sse.mjs';
import { skillCatalogBlock } from './skills.mjs';

const DEFAULT_WINDOW = 128000;

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
export function assembleMessages({ harness, workspace, records = [], skills = [], extraSystem = '' }) {
  const catalog = skillCatalogBlock(skills); // L1 目录：带 token 预算，超预算的技能只留 /<名称> 显式入口
  const system = [
    harness.systemPrompt,
    '',
    `工作目录：${workspace}`,
    `当前时间：${new Date().toISOString()}`,
    '文件工具只能访问工作目录内的路径；修改用户文件前先说清将要改什么。',
  ].join('\n') + (catalog ? `\n\n${catalog}` : '') + (extraSystem ? `\n\n${extraSystem}` : '');
  const messages = [{ role: 'system', content: system }];
  const pending = [];
  const flushPending = () => {
    if (!pending.length) return;
    messages.push({ role: 'assistant', content: '', tool_calls: pending.splice(0) });
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
        messages.push({ role: 'tool', tool_call_id: r.id, content: String(r.output ?? '') });
        break;
      }
      default:
        break; // thinking / usage 等不进上下文
    }
  }
  flushPending();
  return messages;
}

/**
 * 压缩规划：保留最近 keepTurns 个用户轮原文，更早的记录进 head 交给模型总结。
 * 记录太少时返回 null（不值得压缩）。
 */
export function planCompaction(records = [], keepTurns = 4) {
  const userIdx = [];
  records.forEach((r, i) => { if (r.t === 'user') userIdx.push(i); });
  if (userIdx.length <= keepTurns) return null;
  const cut = userIdx[userIdx.length - keepTurns];
  if (cut < 6) return null; // 头部太薄，压缩省不下多少
  return { head: records.slice(0, cut), tail: records.slice(cut) };
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
  return [
    { role: 'system', content: '你是对话压缩器。把下面的早期对话记录压缩成一份摘要，保留：关键事实与决定、涉及的文件路径、工具执行的结论、未解决的问题。带 [技能规范 ...] 或 [用户 /<技能名> 技能调用] 的内容是本次会话必须持续遵循的技能规范，摘要里要原样延续其要点，不得丢弃或改写。用中文，300 字以内，不要客套。' },
    { role: 'user', content: transcript },
  ];
}
