/**
 * Agent Loop：turn 运行器（对齐 OpenBitFun DialogTurn 生命周期，按本地单用户场景落地）。
 * 一个 turn = 若干「模型轮」：流式读取 → 有工具调用就经权限门控执行并回填结果 → 继续，
 * 直到模型不再要求工具或触顶。全过程经 emit 推送 AgentEvent，转录落 session store，
 * 每轮按提供方单价记入用量账本。中断（AbortController）保留已生成内容。
 */
import { randomUUID } from 'node:crypto';
import { buildChatRequest, anthropicFrame, fetchUpstream, upstreamHint } from '../wire.mjs';
import { consumeAgentStream } from '../stream.mjs';
import { getTool, toolResource } from './tools.mjs';
import { PermissionPolicy, defaultRules } from './policy.mjs';
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
 *   gen: { maxTokens, temperature, thinkingOn },
 *   emit(type, payload), controller: AbortController,
 *   requestPermission({ toolId, toolName, params, resource }) => 'allow'|'deny'|'always',
 *   log(level, msg, extra)
 * }
 * @returns {{ turnId, text, rounds, tools, cancelled?, failed? }}
 */
export async function runAgentTurn(ctx) {
  const {
    store, usage, session, input, provider, model, harness, builtinPrice,
    gen = {}, emit, controller, requestPermission, log = () => {},
  } = ctx;
  const sessionId = session.id;
  const turnId = randomUUID();
  const started = Date.now();
  const price = settlePrice(provider, builtinPrice);

  store.append(sessionId, { t: 'user', text: input });
  store.patch(sessionId, { turns: (session.turns || 0) + 1 });
  let records = store.records(sessionId);
  emit('turn_started', { sessionId, turnId, turnIndex: (session.turns || 0) + 1, userInput: input, model, provider: provider.id, harness: harness.id });

  // 会话级权限规则（「总是允许」沉淀处）叠加在默认规则之上
  const sessionRules = Array.isArray(session.rules) ? session.rules.slice() : [];
  const policy = new PermissionPolicy([...defaultRules(), ...sessionRules]);

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
    const messages = assembleMessages({ harness, workspace: session.workspace, records });
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

  let messages = assembleMessages({ harness, workspace: session.workspace, records });
  let round = 0;
  let finalText = '';
  let totalTools = 0;
  let finished = false;
  let currentEntry = null;
  try {
    for (round = 1; round <= harness.maxRounds; round++) {
      await maybeCompact();
      messages = assembleMessages({ harness, workspace: session.workspace, records });
      emit('model_round_started', { sessionId, turnId, round });
      const wire = buildChatRequest(provider, {
        model, messages, toolNames: harness.tools,
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
        return { turnId, text: finalText, rounds: round, tools: totalTools, failed: true };
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
      finalText = roundText;
      if (!toolCalls.length) { finished = true; break; }

      const calls = toolCalls.map((c) => ({ ...c, id: c.id || `call_${randomUUID().slice(0, 8)}` }));
      messages.push({ role: 'assistant', content: roundText, tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) });

      for (const call of calls) {
        totalTools++;
        const toolId = call.id;
        const t0 = Date.now();
        store.append(sessionId, { t: 'tool_call', id: toolId, name: call.name, args: safeArgs(call.arguments) });
        emit('tool_event', { sessionId, turnId, phase: 'started', toolId, toolName: call.name, params: safeArgs(call.arguments) });
        const tool = getTool(call.name);
        let ok = true;
        let output = '';
        if (!tool) {
          ok = false;
          output = `未知工具：${call.name}。当前模式可用工具：${harness.tools.join('、') || '（无）'}`;
        } else {
          const resource = toolResource(call.name, safeArgs(call.arguments));
          const effect = policy.evaluate(call.name, resource);
          if (effect === 'deny') {
            ok = false;
            output = '权限策略拒绝执行该操作。';
            emit('tool_event', { sessionId, turnId, phase: 'rejected', toolId, toolName: call.name, params: safeArgs(call.arguments) });
          } else if (effect === 'ask') {
            emit('tool_event', { sessionId, turnId, phase: 'confirmation_needed', toolId, toolName: call.name, params: safeArgs(call.arguments), resource });
            const decision = await askPermission({ sessionId, turnId, toolId, toolName: call.name, params: safeArgs(call.arguments), resource, action: call.name });
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
            try { output = await tool.run(safeArgs(call.arguments), { workspace: session.workspace }); }
            catch (e) { ok = false; output = `工具执行失败：${e.message}`; }
          }
        }
        const durationMs = Date.now() - t0;
        store.append(sessionId, { t: 'tool_result', id: toolId, name: call.name, ok, output });
        records.push({ t: 'tool_call', id: toolId, name: call.name, args: safeArgs(call.arguments) });
        records.push({ t: 'tool_result', id: toolId, name: call.name, ok, output });
        messages.push({ role: 'tool', tool_call_id: toolId, content: String(output) });
        emit('tool_event', { sessionId, turnId, phase: ok ? 'completed' : 'failed', toolId, toolName: call.name, output: String(output).slice(0, 2000), durationMs });
      }
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
