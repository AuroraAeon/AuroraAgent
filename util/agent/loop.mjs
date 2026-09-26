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
import { buildChatRequest, anthropicFrame, fetchUpstream } from '../wire.mjs';
import { upstreamHint } from '../llm/errors.mjs';
import { consumeAgentStream } from '../stream.mjs';
import { resolveTool, toolResource } from './tools.mjs';
import { PermissionPolicy, defaultRules } from './policy.mjs';
import { createSpawner } from './swarm.mjs';
import { PLAN_MAX_ROUNDS, PLAN_MODE_PROMPT, planExecutionNote, planToolNames } from './plan.mjs';
import { assembleMessages, needsCompaction, planCompaction, compactionMessages, contextWindowOf } from './context.mjs';

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
 *   gen: { maxTokens, temperature, thinkingOn }, skills = [],
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
    gen = {}, skills = [], extraTools = [], emit, controller, requestPermission, requestPlanDecision,
    permissionMode = 'ask_when_needed', planMode = false, depth = 0, log = () => {},
  } = ctx;
  const sessionId = session.id;
  const turnId = randomUUID();
  const started = Date.now();
  const price = settlePrice(provider, builtinPrice);

  store.append(sessionId, { t: 'user', text: input });
  store.patch(sessionId, { turns: (session.turns || 0) + 1 });
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
    emit, controller, requestPermission, permissionMode, rules: sessionRules, gen, extraTools,
    workspace: session.workspace, depth, log,
  });

  let totIn = 0, totOut = 0, totCost = 0;
  const recordRoundUsage = (u, stopped = false) => {
    const inTok = u?.prompt_tokens || 0;
    const outTok = u?.completion_tokens || 0;
    const cost = (inTok * price.input + outTok * price.output) / 1_000_000;
    totIn += inTok; totOut += outTok; totCost = Number((totCost + cost).toFixed(6));
    store.append(sessionId, { t: 'usage', inputTokens: inTok, outputTokens: outTok, cost });
    store.patch(sessionId, { inputTokens: totIn, outputTokens: totOut, cost: totCost });
    usage.record({ kind: 'agent', requestId: turnId, sessionId, model, provider: provider.id, ms: Date.now() - started, inputTokens: inTok, outputTokens: outTok, reasoningTokens: u?.completion_tokens_details?.reasoning_tokens || 0, cost: Number(cost.toFixed(6)), stopped });
    emit('token_usage_updated', { sessionId, turnId, model, inputTokens: inTok, outputTokens: outTok, cost: Number(cost.toFixed(6)) });
  };

  /** 超长时把早期记录折叠成一条 summary（压缩本身花一轮模型调用，失败不阻塞主流程） */
  const maybeCompact = async () => {
    const messages = assembleMessages({ harness, workspace: session.workspace, records, skills });
    if (!needsCompaction(messages, { windowTokens: contextWindowOf(provider), ratio: harness.compactRatio })) return;
    const plan = planCompaction(records);
    if (!plan) return;
    emit('context_compression_started', { sessionId, turnId, headRecords: plan.head.length });
    try {
      const wire = buildChatRequest(provider, { model, messages: compactionMessages(plan.head), maxTokens: 1024 });
      const upstream = await fetchUpstream(wire, { signal: controller.signal });
      if (!upstream.ok) throw new Error('HTTP ' + upstream.status);
      let summary = '';
      await consumeAgentStream(upstream.body.getReader(), { controller, usage: null }, { onText: (t) => { summary += t; } });
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
    const onAbort = () => resolve('deny');
    if (controller.signal.aborted) return resolve('deny');
    controller.signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(requestPermission(payload))
      .then((d) => { controller.signal.removeEventListener('abort', onAbort); resolve(d === 'allow' || d === 'always' ? d : 'deny'); })
      .catch(() => { controller.signal.removeEventListener('abort', onAbort); resolve('deny'); });
  });

  /** 计划决策询问：abort 即视为驳回 */
  const askPlan = (plan) => new Promise((resolve) => {
    const onAbort = () => resolve('reject');
    if (controller.signal.aborted) return resolve('reject');
    controller.signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(requestPlanDecision({ plan }))
      .then((d) => { controller.signal.removeEventListener('abort', onAbort); resolve(d === 'approve' ? 'approve' : 'reject'); })
      .catch(() => { controller.signal.removeEventListener('abort', onAbort); resolve('reject'); });
  });

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
    const wire = buildChatRequest(provider, {
      model, messages, toolNames,
      sendThinking: provider.builtin || Boolean(provider.thinking),
      thinkingOn: gen.thinkingOn !== false,
      maxTokens: provider.builtin ? gen.maxTokens : provider.maxTokens,
      temperature: provider.builtin ? gen.temperature : provider.temperature,
    });
    const upstream = await fetchUpstream(wire, { signal: controller.signal, onRetry: (n, e) => log('warn', '上游连接失败，准备重试', { attempt: n, error: String(e) }) });
    if (!upstream.ok) {
      const hint = upstreamHint(provider, upstream.status, await upstream.text());
      log('warn', '上游错误', { status: upstream.status, provider: provider.id, sessionId });
      emit('turn_failed', { sessionId, turnId, error: hint, round });
      return { failed: true };
    }
    currentEntry = { controller, usage: null };
    let roundText = '';
    let roundThink = '';
    const { toolCalls } = await consumeAgentStream(upstream.body.getReader(), currentEntry, {
      onText: (t) => { roundText += t; emit('text_chunk', { sessionId, turnId, text: t }); },
      onThinking: (t) => { roundThink += t; emit('thinking_chunk', { sessionId, turnId, text: t }); },
      onToolCallDelta: (i, cur) => emit('tool_event', { sessionId, turnId, phase: 'params_partial', toolId: cur.id || `call_${i}`, toolName: cur.name, params: cur.args }),
    }, { translate: provider.protocol === 'anthropic' ? anthropicFrame : undefined });
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
      const tool = resolveTool(call.name, extraTools);
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
            const res = await tool.run(safeArgs(call.arguments), { workspace: session.workspace, skills, todoStore, spawn });
            // 工具可返回字符串或 { output, extra }：extra 是结构化负载（diff / todos），
            // 进转录与 tool_event 供两端渲染，但不进模型消息（模型只看 output 文本）
            if (res && typeof res === 'object') { output = String(res.output ?? ''); extra = res.extra; }
            else { output = String(res ?? ''); }
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

  const withIds = (toolCalls, roundText) => {
    const calls = toolCalls.map((c) => ({ ...c, id: c.id || `call_${randomUUID().slice(0, 8)}` }));
    messages.push({ role: 'assistant', content: roundText, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) });
    return calls;
  };

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
    const execToolNames = [...new Set([...harness.tools, ...(skills.length ? ['skill'] : []), ...extraTools.map((t) => t.name)])];
    for (round = round + 1; round <= harness.maxRounds; round++) {
      const r = await runRound({ toolNames: execToolNames });
      if (r.failed) return { turnId, text: finalText, rounds: round, tools: totalTools, failed: true };
      finalText = r.roundText;
      if (!r.toolCalls.length) { finished = true; break; }
      await runToolCalls(withIds(r.toolCalls, r.roundText));
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
  emit('turn_completed', { sessionId, turnId, totalRounds: round, totalTools, durationMs: Date.now() - started, finishReason: finished ? 'stop' : 'max_rounds' });
  return { turnId, text: finalText, rounds: round, tools: totalTools };
}

/** 工具参数解析：坏 JSON 不当异常抛出，转为可见错误文本回给模型 */
function safeArgs(raw) {
  try { return JSON.parse(raw || '{}'); } catch { return { __raw: String(raw || '') }; }
}
