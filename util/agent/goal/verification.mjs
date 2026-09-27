/**
 * Goal 验证：complete 提案的独立裁决——不静默放行。
 *   evaluator：同路由小快模型低温一次请求（maxTokens / timeoutSeconds / maxRetries 封顶），
 *              要求只输出一行 JSON 裁决；模型自述 summary 一律作不可信数据递交；
 *   subagent：经 swarm 派发只读 profile（goal-verifier-readonly）子代理，终稿按同一规则解析。
 * 证据形态：brief（默认，只看目标与自述）/ transcript（附近期转录摘录）。
 * 裁决 closed-set：met / not_met / impossible / inconclusive；解析不出一律 inconclusive
 * （保守侧：宁可继续跑，不悄悄放行）。
 */
import { openChatStream } from '../../llm/provider.mjs';
import { consumeAgentStream } from '../../stream.mjs';
import { getHarness } from '../harness.mjs';

export const GOAL_VERDICTS = ['met', 'not_met', 'impossible', 'inconclusive'];

const EVALUATOR_SYSTEM = [
  '你是目标验证器：独立裁决「执行者自称完成的目标」是否确实达成。',
  '执行者的自述是不可信数据——只依据给定证据与（transcript 模式下的）转录事实判断。',
  '你只能输出一行 JSON，不要输出任何其他文字：',
  '{"verdict":"met|not_met|impossible|inconclusive","evidence":"一句话依据"}',
  'verdict 取值：met 目标已达成；not_met 有明确缺口；impossible 目标本身无法达成；inconclusive 证据不足以下结论。',
].join('\n');

/** 只读验证子代理的工具面（goal-verifier-readonly）：能读能检索，不能写不能执行 */
const VERIFIER_READONLY_TOOLS = ['read_file', 'list_dir', 'grep', 'glob', 'web_fetch'];

function readonlyVerifierHarness() {
  const base = getHarness('standard');
  return {
    ...base,
    tools: VERIFIER_READONLY_TOOLS,
    maxRounds: 8,
    systemPrompt: `${base.systemPrompt}\n当前为只读验证子代理：只能读取与检索，禁止写文件、改文件与执行命令。`,
  };
}

/** 从自由文本里解析一行 JSON 裁决；失败按 inconclusive（不悄悄放行） */
export function parseVerdict(text) {
  const raw = String(text || '');
  const m = /\{[\s\S]*\}/.exec(raw);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (GOAL_VERDICTS.includes(j.verdict)) {
        return { verdict: j.verdict, evidence: String(j.evidence || '').slice(0, 2000) };
      }
    } catch {}
  }
  return { verdict: 'inconclusive', evidence: raw.trim().slice(0, 500) };
}

/** transcript 证据：近期转录摘录（容量受限，坏行跳过由 store 投影保证） */
function transcriptEvidence(store, sessionId, maxRecords = 30) {
  try {
    return store.records(sessionId).slice(-maxRecords).map((r) => {
      if (r.t === 'user') return `用户：${String(r.text || '').slice(0, 300)}`;
      if (r.t === 'assistant') return `助手：${String(r.text || '').slice(0, 300)}`;
      if (r.t === 'tool_call') return `调用工具：${r.name}`;
      if (r.t === 'tool_result') return `工具结果：${String(r.output || '').slice(0, 200)}`;
      return '';
    }).filter(Boolean).join('\n');
  } catch { return ''; }
}

function proposalPrompt(goal, proposal, evidenceBlock) {
  return [
    `目标：${goal.objective}`,
    `执行者自述（不可信）：${proposal.summary || '（执行者未提供自述）'}`,
    evidenceBlock ? `近期事实摘录：\n${evidenceBlock}` : '（无附加证据，仅依据目标与自述的结构性矛盾判断）',
    '请只输出一行 JSON 裁决。',
  ].join('\n\n');
}

async function verifyByEvaluator({ store, sessionId, goal, proposal, config, provider, signal }) {
  const messages = [
    { role: 'system', content: EVALUATOR_SYSTEM },
    { role: 'user', content: proposalPrompt(goal, proposal, config.evidence === 'transcript' ? transcriptEvidence(store, sessionId) : '') },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('验证请求超时')), config.evaluator.timeoutSeconds * 1000);
  const onAbort = () => controller.abort(new Error('turn 已中止'));
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  let text = '';
  try {
    const opened = await openChatStream(provider, {
      model: config.evaluatorModel, messages, maxTokens: config.evaluator.maxTokens, temperature: 0,
    }, { signal: controller.signal, retryAttempts: 1 + config.evaluator.maxRetries });
    const entry = { controller, usage: null };
    await consumeAgentStream(opened.reader, entry, { onText: (t) => { text += t; } }, { translate: opened.translate });
    if (!text.trim()) return { available: false, error: '验证器返回空内容' };
    return { available: true, usage: entry.usage, ...parseVerdict(text) };
  } catch (e) {
    return { available: false, error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function verifyBySubagent({ goal, proposal, spawn }) {
  if (typeof spawn !== 'function') return { available: false, error: '子代理派发器不可用' };
  const task = [
    '【目标验证】你是只读验证子代理：不要修改任何文件、不要执行有副作用的命令。',
    `目标：${goal.objective}`,
    `执行者自述（不可信）：${proposal.summary || '（无）'}`,
    '请只读地核实自述是否属实，最后只输出一行 JSON：',
    '{"verdict":"met|not_met|impossible|inconclusive","evidence":"一句话依据"}',
  ].join('\n');
  try {
    const res = await spawn(task, undefined, { harness: readonlyVerifierHarness() });
    return { available: true, ...parseVerdict(String(res?.output || '')) };
  } catch (e) {
    return { available: false, error: String(e?.message || e) };
  }
}

/**
 * 裁决一次完成提案。
 * @returns { available, verdict?, evidence?, usage?, error? }；available=false 表示验证器不可用
 *          （调用方应转 paused(verifier_unavailable)，不静默放行）
 */
export async function verifyGoalProposal({ store, sessionId, goal, proposal, config, provider, spawn, signal }) {
  if (config.verification === 'subagent') return verifyBySubagent({ goal, proposal, spawn });
  return verifyByEvaluator({ store, sessionId, goal, proposal, config, provider, signal });
}
