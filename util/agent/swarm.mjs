/**
 * 子代理（swarm）：task 工具把独立子任务派发为受限子 turn 并聚合结果。
 * 每个子代理 = 一个真实子会话（会话列表可见、转录可查）+ 独立上下文 + 同一套权限门控
 * （询问经同一 requestPermission 通道转交前端；会话级「总是允许」规则随派发继承）。
 * 子代理的流式文本不回显（只透出工具调用，两端呈现为嵌套工具卡），终稿经 task 工具结果回给父模型。
 * 不 import loop.mjs：runTurn 由调用方注入，避免环依赖。
 */

import { findAgentConfig, subagentOverrides } from './subagents.mjs';

/** 单次派发的子代理数量上限（控成本） */
export const MAX_CHILDREN = 4;
/** 嵌套深度上限：超过后不再派生（防递归失控） */
export const MAX_DEPTH = 2;

/**
 * 造一个派发器。ctx 与 loop.mjs 的 runAgentTurn 入参同构（runTurn 注入自身）。
 * @returns {(task?: string, tasks?: string[], opts?: { harness? }) => Promise<{ output: string, extra: { children } }>}
 *          opts.harness 覆盖子代理模式（goal 只读验证子代理用）
 */
export function createSpawner(ctx) {
  const {
    runTurn, store, usage, provider, model, harness, skills = [], builtinPrice,
    emit, controller, requestPermission, permissionMode = 'ask_when_needed', titleMode = 'local',
    rules = [], gen = {}, extraTools = [], workspace = '', depth = 0, agentProxy = '', log = () => {},
    sanitizeChildEnv = true, ignoreEnabled = true, promptCache = 'auto',
    providerFailover = true, providerFailoverMaxAttempts, failoverCandidates = null,
    // 声明式子代理（util/agent/subagents.mjs）：专人专用的模型 / 工具集 / 系统提示
    agents = [], resolveAgentProvider = null, ruleToggles = {},
  } = ctx;

  /** 跑一个子代理：新建子会话（继承工作目录与权限规则）→ 嵌套 turn → 汇总。
   *  opts.agent 指名声明式子代理时按配置覆盖模型 / 工具集 / 系统提示（专人专用） */
  const spawnOne = async (taskText, childHarness = harness, opts = {}) => {
    const task = String(taskText || '').slice(0, 500);
    if (depth >= MAX_DEPTH) {
      return { task, ok: false, text: `子代理嵌套深度已达上限（${MAX_DEPTH} 层），不再派生`, sessionId: '', rounds: 0, tools: 0 };
    }
    const cfg = opts.agent ? findAgentConfig(agents, opts.agent) : null;
    if (opts.agent && !cfg) {
      return { task, ok: false, text: `没有名为「${opts.agent}」的声明式子代理`, sessionId: '', rounds: 0, tools: 0 };
    }
    const override = cfg ? subagentOverrides(cfg, {
      resolveProvider: resolveAgentProvider,
      harnessTools: childHarness.tools,
      log,
    }) : null;
    // 模型覆盖：专人可跑别的模型（便宜模型干粗活），提供方随模型重新解析；
    // 解析不到就沿用父会话的，一条配置写错不该让整个派发失败
    const useModel = override?.model || model;
    const useProvider = override?.provider || provider;
    const useSkills = override?.skills?.length ? override.skills : skills;
    const child = store.create({
      name: cfg ? `${cfg.name}：${task.slice(0, 20)}` : `子任务：${task.slice(0, 24)}`,
      model: useModel, provider: useProvider.id, harness: childHarness.id, workspace,
    });
    if (rules.length) store.patch(child.id, { rules: rules.map(({ action, resource, effect }) => ({ action, resource, effect })) });
    const childController = new AbortController();
    const onParentAbort = () => childController.abort(new Error('父任务已中止'));
    if (controller.signal.aborted) childController.abort(new Error('父任务已中止'));
    else controller.signal.addEventListener('abort', onParentAbort, { once: true });
    // 子代理事件只透出工具调用与用量（打 subAgent 标记供两端嵌套渲染）；文本由终稿回传
    const childEmit = (type, payload) => {
      if (type === 'tool_event' || type === 'token_usage_updated') {
        emit(type, { ...payload, subAgent: true, subTask: task, subSessionId: child.id });
      }
    };
    let result;
    try {
      result = await runTurn({
        store, usage, session: child, input: task, provider: useProvider, model: useModel,
        harness: childHarness, builtinPrice, skills: useSkills, gen, extraTools,
        // 专人专用的系统提示经 extraSystem 注入（叠加在 harness 提示之上，不替换它）
        extraSystem: override?.systemPrompt || '',
        // 专人专用的工具集：只在这一个子 turn 里收窄，父会话工具箱不受影响
        toolNames: override?.toolNames || null,
        agentName: cfg?.name || '',
        ruleToggles,
        emit: childEmit, controller: childController,
        requestPermission, permissionMode, titleMode,
        planMode: false, // 计划是父层契约，子代理直接执行
        depth: depth + 1,
        agentProxy, // 子代理与父层共用同一条本机代理出站
        sanitizeChildEnv, ignoreEnabled, // 环境净化与忽略闸门开关随派发继承
        promptCache, // 提示缓存档位随派发继承（专人跑别的模型时按目标提供方口径决定是否插断点）
        providerFailover, providerFailoverMaxAttempts, failoverCandidates, // 故障转移配置与候选源随派发继承
        log,
      });
    } finally {
      controller.signal.removeEventListener('abort', onParentAbort);
    }
    const ok = Boolean(result && !result.failed && !result.cancelled && String(result.text || '').trim());
    return {
      task, ok,
      text: result?.cancelled ? '子代理被中止（父任务中断或客户端断开）' : String(result?.text || '').trim() || '子代理未产出文本',
      sessionId: child.id, rounds: result?.rounds || 0, tools: result?.tools || 0,
    };
  };

  /** 派发入口：task 单发或 tasks 并行（上限 MAX_CHILDREN），聚合为工具结果 */
  return async function spawn(task, tasks, opts = {}) {
    const childHarness = opts.harness || harness;
    if (depth >= MAX_DEPTH) {
      return { output: `子代理嵌套深度已达上限（${MAX_DEPTH} 层），本次派发被拒绝。请自行完成剩余工作。`, extra: { children: [] } };
    }
    const list = (Array.isArray(tasks) ? tasks : [task])
      .map((t) => String(t || '').trim())
      .filter(Boolean)
      .slice(0, MAX_CHILDREN);
    if (!list.length) return { output: '没有可派发的子任务：task 或 tasks 至少填一项，且描述不能为空', extra: { children: [] } };
    const children = await Promise.all(list.map((t) => spawnOne(t, childHarness, opts)));
    const okCount = children.filter((c) => c.ok).length;
    const lines = [`子代理结果（${okCount}/${children.length} 成功）：`];
    children.forEach((c, i) => {
      lines.push(`[${i + 1}] ${c.task}`);
      lines.push(c.ok ? c.text : `失败：${c.text}`);
    });
    return { output: lines.join('\n'), extra: { children } };
  };
}
