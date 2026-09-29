/**
 * Agent Loop：turn 运行器（对齐 OpenBitFun DialogTurn 生命周期，按本地单用户场景落地）。
 * 一个 turn = 若干「模型轮」：流式读取 → 有工具调用就经权限门控执行并回填结果 → 继续，
 * 直到模型不再要求工具或触顶。全过程经 emit 推送 AgentEvent，转录落 session store，
 * 每轮按提供方单价记入用量账本。中断（AbortController）保留已生成内容。
 *
 * 计划模式（planMode）：turn 先用只读 / 检索 / 待办工具产出计划，用户批准后才以完整
 * 工具集执行；权限三档（permissionMode）叠加在规则集之上，见 policy.mjs。
 */
import { randomUUID } from 'node:crypto';
import { openChatStream } from '../llm/provider.mjs';
import { consumeAgentStream, primeUpstreamStream } from '../stream.mjs';
import { resolveTool, toolResource } from './tools.mjs';
import { findSkill } from './skills.mjs';
import { PermissionPolicy, defaultRules } from './policy.mjs';
import { createSpawner } from './swarm.mjs';
import { deriveTitle } from './title.mjs';
import { generateTitleText } from './title-model.mjs';
import { DEFAULT_SESSION_NAME } from './session.mjs';
import { DEFAULT_TITLE_MODE } from '../config.mjs';
import { PLAN_MAX_ROUNDS, PLAN_MODE_PROMPT, planExecutionNote, planToolNames } from './plan.mjs';
import { assembleMessages, needsCompaction, planCompaction, compactionMessages, contextWindowOf } from './context.mjs';
import { FAILOVER_DEFAULTS, semanticFailure } from '../llm/failover.mjs';
import { createGoalRuntime } from './goal/runtime.mjs';
import { GOAL_WRAPUP_NOTE } from './goal/continuation.mjs';

/** 单轮用量结算：提供方单价优先，缺侧回退内置价（与 settleUsage 同规则） */
function settlePrice(provider, builtinPrice) {
  const own = provider.price || {};
  const base = builtinPrice || { input: 0, output: 0 };
  return {
    input: Number.isFinite(own.input) ? own.input : base.input,
    output: Number.isFinite(own.output) ? own.output : base.output,
  };
}

/**
 * 跑一个 turn。
 * @param ctx {
 *   store, usage, session, input, provider, model, harness, builtinPrice,
 *   gen: { maxTokens, temperature, thinkingOn }, skills = [], inputSkill = '',
 *   emit(type, payload), controller: AbortController,
 *   requestPermission({ toolId, toolName, params, resource }) => 'allow'|'deny'|'always',
 *   requestPlanDecision({ plan }) => 'approve'|'reject'（计划模式必传；缺省即不走计划阶段）,
 *   permissionMode = 'ask_when_needed', planMode = false,
 *   log(level, msg, extra)
 * }
 * @returns {{ turnId, text, rounds, tools, cancelled?, failed?, planRejected? }}
 */
export async function runAgentTurn(ctx) {
  const {
    store, usage, session, input, provider, model, harness, builtinPrice,
    gen = {}, skills = [], extraTools = [], inputSkill = '', emit, controller, requestPermission, requestPlanDecision,
    permissionMode = 'ask_when_needed', planMode = false, titleMode = DEFAULT_TITLE_MODE, depth = 0,
    agentProxy = '', goalStore = null, goalCfg = null, log = () => {},
    // 多提供方故障转移：candidates 由 HTTP 面按模型目录注入（直连 Loop 的旧调用方不传即不转移）
    providerFailover = true, providerFailoverMaxAttempts = FAILOVER_DEFAULTS.maxAttempts, failoverCandidates = null,
    // 熔断器 + 生效超时 + 队列：都由 HTTP 面按配置算好后注入（failover-state.mjs / failover.mjs），
    // Loop 只负责在 onSwitch 里写热切换偏好，不自己读配置
    failoverState = null, failoverTimeouts = null, failoverQueue = null,
  } = ctx;
  const sessionId = session.id;
  const turnId = randomUUID();
  const started = Date.now();
  // turn 内粘性：连接期故障转移成功后，后续轮次继续用新提供方（activeProvider），
  // 单价与记账随之归属到真实产出 token 的那一家，避免同一 turn 里两家来回抖动
  let activeProvider = provider;
  const priceOf = () => settlePrice(activeProvider, builtinPrice);
  // 提供方相关的请求参数：内置提供方走全局 gen；自定义提供方只发送显式声明过的字段，
  // 避免上游把未支持字段当 400 拒绝（故障转移换到另一家时按目标提供方口径重新拼）
  const requestGen = (p) => ({
    sendThinking: p.builtin || Boolean(p.thinking),
    thinkingOn: gen.thinkingOn !== false,
    maxTokens: p.builtin ? gen.maxTokens : p.maxTokens,
    temperature: p.builtin ? gen.temperature : p.temperature,
  });
  // 故障转移接线（判定与配置见 llm/failover.mjs）：只在流尚未打开时换路，
  // 已产出字节后的失败按既有行为传播（客户端已收到部分内容，不能透明换路）
  const failoverEnabled = providerFailover !== false && typeof failoverCandidates === 'function';
  // 预读（primeUpstreamStream）：把「200 的错误 envelope」与「首包超时」变成连接期错误，
  // 从而在还没向客户端写出任何字节前换路。仅在故障转移开启时启用——关闭就得保持老行为。
  const primeUpstream = async (reader, translate, signal) => primeUpstreamStream(reader, {
    firstByteMs: failoverTimeouts?.firstByteMs || 0,
    detectFailure: failoverEnabled ? semanticFailure : null,
    signal,
  });
  const failoverIo = () => ({
    ...(failoverEnabled && failoverState ? { circuit: failoverState.circuits } : {}),
    ...(failoverEnabled && failoverTimeouts ? { timeouts: failoverTimeouts, nonStreamMs: failoverTimeouts.nonStreamMs } : {}),
    ...(failoverEnabled ? { prime: primeUpstream } : {}),
    failover: {
      enabled: failoverEnabled,
      maxAttempts: providerFailoverMaxAttempts,
      queue: failoverQueue ? failoverQueue() : [],
      candidates: (cur) => failoverCandidates(cur),
      onSwitch: ({ from, to, reason, attempt }) => {
        activeProvider = to;
        // 热切换偏好：下次同一模型直接优先找这家（TTL 内有效，见 failover-state.mjs）
        failoverState?.setPref(model, to.id);
        log('warn', '上游暂不可用，已切换提供方重试', { from: from.id, to: to.id, reason, attempt, sessionId });
        emit('provider_switched', { sessionId, turnId, from: from.id, fromName: from.name, to: to.id, toName: to.name, reason, attempt, round });
      },
    },
  });

  // 斜杠技能注入的用户记录带 skill 标记：压缩期据此完整保留技能规范，不当普通对话摘掉
  store.append(sessionId, { t: 'user', text: input, ...(inputSkill ? { skill: inputSkill } : {}) });
  store.patch(sessionId, { turns: (session.turns || 0) + 1 });

  let totIn = 0, totOut = 0, totCost = 0;
  const recordRoundUsage = (u, stopped = false) => {
    const price = priceOf();
    const inTok = u?.prompt_tokens || 0;
    const outTok = u?.completion_tokens || 0;
    const cost = (inTok * price.input + outTok * price.output) / 1_000_000;
    totIn += inTok; totOut += outTok; totCost = Number((totCost + cost).toFixed(6));
    store.append(sessionId, { t: 'usage', inputTokens: inTok, outputTokens: outTok, cost });
    store.patch(sessionId, { inputTokens: totIn, outputTokens: totOut, cost: totCost });
    usage.record({ kind: 'agent', requestId: turnId, sessionId, model, provider: activeProvider.id, ms: Date.now() - started, inputTokens: inTok, outputTokens: outTok, reasoningTokens: u?.completion_tokens_details?.reasoning_tokens || 0, cost: Number(cost.toFixed(6)), stopped });
    emit('token_usage_updated', { sessionId, turnId, model, inputTokens: inTok, outputTokens: outTok, cost: Number(cost.toFixed(6)) });
  };

  /** 附加请求记账（titleMode=model 的标题轮 / goal 验证轮）：同一套单价，进账本与会话汇总，但不进转录与轮次脚注（渲染口径与本地模式一致） */
  const recordExtraUsage = (u, ms, purpose) => {
    if (!u) return;
    const price = priceOf();
    const inTok = u.prompt_tokens || 0;
    const outTok = u.completion_tokens || 0;
    const cost = (inTok * price.input + outTok * price.output) / 1_000_000;
    totIn += inTok; totOut += outTok; totCost = Number((totCost + cost).toFixed(6));
    store.patch(sessionId, { inputTokens: totIn, outputTokens: totOut, cost: totCost });
    usage.record({ kind: 'agent', requestId: `${purpose}_${turnId}`, sessionId, model, provider: activeProvider.id, ms, inputTokens: inTok, outputTokens: outTok, reasoningTokens: 0, cost: Number(cost.toFixed(6)), purpose });
  };
  const recordTitleUsage = (u, ms) => recordExtraUsage(u, ms, 'title');

  /**
   * 自动总结标题：会话仍是默认名时才起名（用户改名或显式命名不覆盖）。
   * local：本地推导，零成本，turn 一开始就定好；model：多一次小额上游请求，失败回退本地推导，
   * 等终稿出来再花这笔钱（中止 / 失败的 turn 不花）。
   */
  const autoTitle = async (answer = '') => {
    if (session.name && session.name !== DEFAULT_SESSION_NAME) return;
    let title = '';
    if (titleMode === 'model') {
      const t0 = Date.now();
      try {
        const r = await generateTitleText({ provider: activeProvider, model, input, answer, controller });
        recordTitleUsage(r.usage, Date.now() - t0);
        title = deriveTitle(r.text);
      } catch (e) {
        log('warn', '模型总结标题失败，回退本地推导', { sessionId, error: String(e) });
      }
    }
    if (!title) title = deriveTitle(input);
    if (!title) return;
    store.patch(sessionId, { name: title });
    session.name = title; // 同步内存引用，本轮内读取保持一致
    emit('session_renamed', { sessionId, name: title, mode: titleMode });
  };
  if (titleMode !== 'model') await autoTitle();

  let records = store.records(sessionId);
  emit('turn_started', { sessionId, turnId, turnIndex: (session.turns || 0) + 1, userInput: input, model, provider: provider.id, harness: harness.id });

  // 会话级权限规则（「总是允许」沉淀处）叠加在默认规则之上；permissionMode 决定 ask 类默认效应
  const sessionRules = Array.isArray(session.rules) ? session.rules.slice() : [];
  // 待办清单随会话持久化（meta.todos）；工具经 ctx.todoStore 读写，两端渲染同源
  let todos = Array.isArray(session.todos) ? session.todos.slice() : [];
  const todoStore = {
    get: () => todos,
    set: (next) => { todos = next; store.patch(sessionId, { todos: next }); },
  };
  const policy = new PermissionPolicy([...defaultRules(), ...sessionRules], { permissionMode });
  // 子代理派发器：task 工具经 ctx.spawn 派生子 turn；深度随嵌套递增（swarm.mjs 封顶）
  const spawn = createSpawner({
    runTurn: runAgentTurn, store, usage, provider, model, harness, skills, builtinPrice,
    emit, controller, requestPermission, permissionMode, titleMode, rules: sessionRules, gen, extraTools,
    workspace: session.workspace, depth, log,
    // 子代理继承同一套故障转移配置与候选源：父层换过的路，子代理也能自己换
    providerFailover, providerFailoverMaxAttempts, failoverCandidates,
  });
  // Goal 运行时：仅顶层会话启用（子代理不接管目标）；工具经 allTools 进请求与解析，
  // 钩子（beginTurn / afterRound / finish）驱动用量入账、熔断、预算与提案结算。
  // 无 goalStore（旧调用方 / 测试）时全部钩子为空操作，行为与本节之前完全一致。
  const goalRt = goalStore && depth === 0
    ? createGoalRuntime({
      goalStore, sessionId, config: goalCfg || undefined, harnessTools: harness.tools, emit, log,
      store, provider, signal: controller.signal,
      onExtraUsage: (u, ms, purpose) => recordExtraUsage(u, ms, purpose),
    })
    : null;
  const allTools = goalRt ? [...extraTools, ...goalRt.tools] : extraTools;
  if (goalRt) goalRt.bindSpawn(spawn); // 验证档 subagent 派发只读验证子代理

  /** 超长时把早期记录折叠成一条 summary（压缩本身花一轮模型调用，失败不阻塞主流程） */
  const maybeCompact = async () => {
    const messages = assembleMessages({ harness, workspace: session.workspace, records, skills });
    if (!needsCompaction(messages, { windowTokens: contextWindowOf(activeProvider), ratio: harness.compactRatio })) return;
    const plan = planCompaction(records);
    if (!plan) return;
    emit('context_compression_started', { sessionId, turnId, headRecords: plan.head.length });
    try {
      const opened = await openChatStream(activeProvider, { model, messages: compactionMessages(plan.head), maxTokens: 1024 }, { signal: controller.signal, ...failoverIo() });
      let summary = '';
      await consumeAgentStream(opened.reader, { controller, usage: null }, { onText: (t) => { summary += t; } }, { translate: opened.translate, idleMs: failoverTimeouts?.idleMs || 0 });
      if (!summary.trim()) throw new Error('压缩结果为空');
      store.replaceRecords(sessionId, [{ t: 'summary', text: summary.trim() }, ...plan.tail]);
      records = store.records(sessionId);
      emit('context_compression_completed', { sessionId, turnId, keptRecords: plan.tail.length });
    } catch (e) {
      log('warn', '上下文压缩失败，沿用原上下文', { error: String(e) });
      emit('context_compression_failed', { sessionId, turnId, error: String(e) });
    }
  };

  /** 权限询问：abort 即视为拒绝，绝不让 turn 挂死在无人响应的确认上 */
  const askPermission = (payload) => new Promise((resolve) => {
    const onAbort = () => { goalRt?.wait(null); resolve('deny'); };
    if (controller.signal.aborted) return resolve('deny');
    controller.signal.addEventListener('abort', onAbort, { once: true });
    goalRt?.wait('permission');
    Promise.resolve(requestPermission(payload))
      .then((d) => { controller.signal.removeEventListener('abort', onAbort); goalRt?.wait(null); resolve(d === 'allow' || d === 'always' ? d : 'deny'); })
      .catch(() => { controller.signal.removeEventListener('abort', onAbort); goalRt?.wait(null); resolve('deny'); });
  });

  /** 计划决策询问：abort 即视为驳回 */
  const askPlan = (plan) => new Promise((resolve) => {
    const onAbort = () => { goalRt?.wait(null); resolve('reject'); };
    if (controller.signal.aborted) return resolve('reject');
    controller.signal.addEventListener('abort', onAbort, { once: true });
    goalRt?.wait('plan');
    Promise.resolve(requestPlanDecision({ plan }))
      .then((d) => { controller.signal.removeEventListener('abort', onAbort); goalRt?.wait(null); resolve(d === 'approve' ? 'approve' : 'reject'); })
      .catch(() => { controller.signal.removeEventListener('abort', onAbort); goalRt?.wait(null); resolve('reject'); });
  });

  // 技能激活去重（本 turn 内）+ allowed-tools 授权：grantAlways 直接改 policy.rules（当轮即生效），
  // 同步进 sessionRules 只是让派发的子代理继承同一授权；两处都不 store.patch，故不落会话 meta
  const skillsLoaded = new Set();
  const grantSkillTools = (skillName) => {
    const skill = findSkill(skills, skillName);
    if (!skill?.allowedTools?.length) return;
    for (const tool of skill.allowedTools) {
      const exists = sessionRules.some((r) => r.action === tool && r.resource === '*' && r.effect === 'allow');
      if (!exists) sessionRules.push(policy.grantAlways(tool, '*'));
    }
  };
  if (inputSkill) { skillsLoaded.add(inputSkill); grantSkillTools(inputSkill); }

  let messages = assembleMessages({ harness, workspace: session.workspace, records, skills });
  let round = 0;
  let finalText = '';
  let totalTools = 0;
  let finished = false;
  let currentEntry = null;

  /** 跑一个模型轮：请求上游 → 流式读取 → 落转录 → 记账。返回 { toolCalls, roundText } 或 { failed } */
  const runRound = async ({ toolNames, extraSystem = '' }) => {
    await maybeCompact();
    messages = assembleMessages({ harness, workspace: session.workspace, records, skills, extraSystem });
    emit('model_round_started', { sessionId, turnId, round });
    let opened;
    try {
      // LLM 抽象层统一入口：构造请求 + 连接期重试 + 中文错误话术 + 协议帧翻译选择；
      // extraTools（MCP 等外部工具）的 schema 经此进入请求，模型才看得见这些工具
      opened = await openChatStream(activeProvider, {
        model, messages, toolNames, extraTools: allTools, ...requestGen(activeProvider),
      }, { signal: controller.signal, onRetry: (n, e) => log('warn', '上游连接失败，准备重试', { attempt: n, error: String(e) }), ...failoverIo() });
    } catch (e) {
      // 中止走统一取消路径（保留已生成内容）；其余（上游非 2xx / 网络失败）以 turn_failed 收尾
      if (controller.signal.aborted || e?.name === 'AbortError') throw e;
      log('warn', '上游错误', { kind: e.kind, status: e.status, provider: activeProvider.id, sessionId });
      emit('turn_failed', { sessionId, turnId, error: e.message, round });
      return { failed: true };
    }
    currentEntry = { controller, usage: null };
    let roundText = '';
    let roundThink = '';
    let consumed;
    try {
      consumed = await consumeAgentStream(opened.reader, currentEntry, {
        onText: (t) => { roundText += t; emit('text_chunk', { sessionId, turnId, text: t }); },
        onThinking: (t) => { roundThink += t; emit('thinking_chunk', { sessionId, turnId, text: t }); },
        onToolCallDelta: (i, cur) => emit('tool_event', { sessionId, turnId, phase: 'params_partial', toolId: cur.id || `call_${i}`, toolName: cur.name, params: cur.args }),
      }, { translate: opened.translate, idleMs: failoverTimeouts?.idleMs || 0 });
    } catch (e) {
      // 流已开始后的失败（空闲超时 / 连接中断）：已产出部分内容，不能透明换路，按 turn 失败收尾
      if (controller.signal.aborted || e?.name === 'AbortError') throw e;
      log('warn', '上游流式中断', { kind: e.kind, error: String(e), provider: activeProvider.id, sessionId });
      emit('turn_failed', { sessionId, turnId, error: e.message, round });
      return { failed: true };
    }
    const { toolCalls } = consumed;
    if (roundThink) store.append(sessionId, { t: 'thinking', text: roundThink });
    if (roundText) {
      store.append(sessionId, { t: 'assistant', text: roundText });
      records.push({ t: 'assistant', text: roundText });
    }
    recordRoundUsage(currentEntry.usage);
    return { toolCalls, roundText };
  };

  /** 执行一组工具调用：权限门控（三档 + 会话规则）→ 执行 → 回填模型消息与转录 → 事件 */
  const runToolCalls = async (calls) => {
    for (const call of calls) {
      totalTools++;
      const toolId = call.id;
      const t0 = Date.now();
      store.append(sessionId, { t: 'tool_call', id: toolId, name: call.name, args: safeArgs(call.arguments) });
      emit('tool_event', { sessionId, turnId, phase: 'started', toolId, toolName: call.name, params: safeArgs(call.arguments) });
      const tool = resolveTool(call.name, allTools);
      let ok = true;
      let output = '';
      let extra;
      if (!tool) {
        ok = false;
        output = `未知工具：${call.name}。当前模式可用工具：${harness.tools.join('、') || '（无）'}`;
      } else {
        const resource = toolResource(call.name, safeArgs(call.arguments));
        const effect = policy.effective(call.name, resource);
        if (effect === 'deny') {
          ok = false;
          output = '权限策略拒绝执行该操作。';
          emit('tool_event', { sessionId, turnId, phase: 'rejected', toolId, toolName: call.name, params: safeArgs(call.arguments) });
        } else if (effect === 'ask') {
          // requestId 由运行器生成并随事件透出，客户端凭它回传决策（POST /api/agent/permission）
          const requestId = randomUUID();
          emit('tool_event', { sessionId, turnId, phase: 'confirmation_needed', toolId, toolName: call.name, params: safeArgs(call.arguments), resource, requestId });
          const decision = await askPermission({ requestId, sessionId, turnId, toolId, toolName: call.name, params: safeArgs(call.arguments), resource, action: call.name });
          if (decision === 'deny') {
            ok = false;
            output = '用户拒绝了这次操作，未做任何改动。';
            emit('tool_event', { sessionId, turnId, phase: 'rejected', toolId, toolName: call.name });
          } else {
            if (decision === 'always') {
              sessionRules.push(policy.grantAlways(call.name, resource));
              store.patch(sessionId, { rules: sessionRules });
            }
            emit('tool_event', { sessionId, turnId, phase: 'confirmed', toolId, toolName: call.name });
          }
        }
        if (ok) {
          try {
            const res = await tool.run(safeArgs(call.arguments), { workspace: session.workspace, skills, todoStore, spawn, proxy: agentProxy, skillsLoaded });
            // 工具可返回字符串或 { output, extra }：extra 是结构化负载（diff / todos），
            // 进转录与 tool_event 供两端渲染，但不进模型消息（模型只看 output 文本）
            if (res && typeof res === 'object') { output = String(res.output ?? ''); extra = res.extra; }
            else { output = String(res ?? ''); }
            if (call.name === 'skill') grantSkillTools(safeArgs(call.arguments).name);
          } catch (e) { ok = false; output = `工具执行失败：${e.message}`; }
        }
      }
      const durationMs = Date.now() - t0;
      const resultRec = { t: 'tool_result', id: toolId, name: call.name, ok, output, ...(extra ? { extra } : {}) };
      store.append(sessionId, resultRec);
      records.push({ t: 'tool_call', id: toolId, name: call.name, args: safeArgs(call.arguments) });
      records.push(resultRec);
      messages.push({ role: 'tool', tool_call_id: toolId, content: String(output) });
      emit('tool_event', { sessionId, turnId, phase: ok ? 'completed' : 'failed', toolId, toolName: call.name, output: String(output).slice(0, 2000), durationMs, ...(extra ? { extra } : {}) });
    }
  };

  /** 预算触顶后的唯一收尾轮：不带工具 + 收尾提醒，只总结进展与停止原因 */
  const runGoalWrapUp = async () => {
    await runRound({ toolNames: [], extraSystem: GOAL_WRAPUP_NOTE });
  };

  const withIds = (toolCalls, roundText) => {
    const calls = toolCalls.map((c) => ({ ...c, id: c.id || `call_${randomUUID().slice(0, 8)}` }));
    messages.push({ role: 'assistant', content: roundText, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) });
    return calls;
  };

  const goalStartNote = goalRt?.beginTurn() || null; // 活跃目标的新用户轮首轮重述（压缩失忆防护 + 审计）

  try {
    // —— 计划阶段：只读 / 检索 / 待办工具产出计划，用户批准后才进入执行 ——
    if (planMode && typeof requestPlanDecision === 'function') {
      const planNames = planToolNames(harness.tools, skills);
      let planDone = false;
      for (round = 1; round <= Math.min(harness.maxRounds, PLAN_MAX_ROUNDS); round++) {
        const r = await runRound({ toolNames: planNames, extraSystem: PLAN_MODE_PROMPT });
        if (r.failed) return { turnId, text: finalText, rounds: round, tools: totalTools, failed: true };
        finalText = r.roundText;
        if (!r.toolCalls.length) {
          const planText = String(r.roundText || '').trim();
          emit('plan_proposed', { sessionId, turnId, plan: planText });
          const decision = await askPlan(planText);
          if (decision !== 'approve') {
            emit('plan_rejected', { sessionId, turnId, plan: planText });
            emit('turn_completed', { sessionId, turnId, totalRounds: round, totalTools, durationMs: Date.now() - started, finishReason: 'plan_rejected' });
            return { turnId, text: finalText, rounds: round, tools: totalTools, planRejected: true };
          }
          emit('plan_approved', { sessionId, turnId, plan: planText });
          const note = planExecutionNote(planText);
          store.append(sessionId, { t: 'user', text: note });
          records.push({ t: 'user', text: note });
          messages.push({ role: 'user', content: note });
          planDone = true;
          break;
        }
        await runToolCalls(withIds(r.toolCalls, r.roundText));
      }
      if (!planDone) {
        // 计划阶段触顶仍未产出计划：不进入执行，按 max_rounds 收尾
        emit('turn_completed', { sessionId, turnId, totalRounds: round, totalTools, durationMs: Date.now() - started, finishReason: 'max_rounds' });
        return { turnId, text: finalText, rounds: round, tools: totalTools };
      }
    }

    // —— 执行阶段：完整工具集（计划批准后计划文本作为既定契约已在上下文中）——
    const execToolNames = [...new Set([...harness.tools, ...(skills.length ? ['skill'] : []), ...allTools.map((t) => t.name)])];
    let goalNote = goalStartNote || ''; // goal 轮首重述 / 续跑 / 验证反馈提醒：只带一轮（runRound 消费后即清）
    for (round = round + 1; round <= harness.maxRounds; round++) {
      const roundT0 = Date.now();
      const r = await runRound({ toolNames: execToolNames, extraSystem: goalNote });
      goalNote = '';
      if (r.failed) { await goalRt?.finish(); return { turnId, text: finalText, rounds: round, tools: totalTools, failed: true }; }
      finalText = r.roundText;
      if (!r.toolCalls.length) {
        // 无工具轮：goal 在管辖时入账 + 提案结算 / 续跑决策；不在管辖时照旧结束
        const d = goalRt ? await goalRt.onIdle({ replyText: r.roundText, usage: currentEntry.usage, roundMs: Date.now() - roundT0 }) : { action: 'finish' };
        if (d.action === 'wrapup') { await runGoalWrapUp(); finished = true; break; }
        if (d.action === 'continue') { goalNote = d.extraSystem || ''; continue; }
        finished = true;
        break;
      }
      await runToolCalls(withIds(r.toolCalls, r.roundText));
      const stop = goalRt?.afterRound({ replyText: r.roundText, toolCalls: r.toolCalls, usage: currentEntry.usage, roundMs: Date.now() - roundT0 });
      if (stop === 'wrapup') { await runGoalWrapUp(); finished = true; break; }
      if (stop === 'updated' || stop === 'nudge') { goalNote = goalRt.consumeNote() || ''; continue; } // 目标已更新 / 无进展纠正提醒：下一轮注入
      if (stop === 'proposal') {
        // 终态提案：结算（验证未过且未到阈值时可带反馈续跑）
        const d = await goalRt.onProposal();
        if (d.action === 'continue') { goalNote = d.extraSystem || ''; continue; }
        finished = true;
        break;
      }
      if (stop) { finished = true; break; }
    }
  } catch (err) {
    const aborted = controller.signal.aborted || err?.name === 'AbortError';
    if (aborted) {
      if (currentEntry?.usage) recordRoundUsage(currentEntry.usage, true);
      emit('turn_cancelled', { sessionId, turnId });
      return { turnId, text: finalText, rounds: round, tools: totalTools, cancelled: true };
    }
    log('error', 'turn 运行异常', { sessionId, turnId, error: String(err) });
    emit('turn_failed', { sessionId, turnId, error: String(err), round });
    return { turnId, text: finalText, rounds: round, tools: totalTools, failed: true };
  }
  if (titleMode === 'model') await autoTitle(finalText); // 等终稿出来再花这笔标题钱，失败回退本地推导
  await goalRt?.finish(); // 终态提案结算与最终用量快照先于 turn_completed，客户端按序看到终态
  emit('turn_completed', { sessionId, turnId, totalRounds: round, totalTools, durationMs: Date.now() - started, finishReason: finished ? 'stop' : 'max_rounds' });
  return { turnId, text: finalText, rounds: round, tools: totalTools };
}

/** 工具参数解析：坏 JSON 不当异常抛出，转为可见错误文本回给模型 */
function safeArgs(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return { __raw: String(raw || '') }; }
}
