/**
 * 终端 turn 渲染器：把 loop.mjs 的 AgentEvent 流映射为终端输出——思考暗色流式、工具单行
 * 状态（✓ ✗）、权限 readline 确认（y / n / a）、用量脚注、中断保留已生成内容。
 * 与 coordinator（terminal.mjs）分担行数预算；颜色一律由调用方注入的 painter 提供
 * （每帧从当前色板新建，主题切换当帧生效）。契约：docs/tui-design.md + util/agent/events.mjs。
 */
import { runAgentTurn } from './loop.mjs';
import { PRICE, TITLE_MODES } from '../config.mjs';
import { toolLabel, fmtCost, indent, truncate, CLEAR } from './terminal-format.mjs';
import { GOAL_STATUS_LABELS, GOAL_WAIT_LABELS } from './goal/types.mjs';
import { goalUsageChip } from './goal/budget.mjs';

/** 故障转移切换原因中文文案（后端 llm/failover.mjs 的 failoverReason 词表镜像） */
const SWITCH_REASON_LABELS = { rate_limit: '上游限流', server: '上游故障', network: '网络异常', timeout: '上游超时', semantic: '上游返回错误', circuit_open: '提供方已熔断', unknown: '上游异常' };

/**
 * 跑一个 turn 并渲染。session 引用会被 loop 更新，故结束后经 onSession 回传最新 meta。
 * footer 状态（tokens / cost）经 onUsage 回传，供 coordinator 的 footer 状态条展示。
 * hooks 由 coordinator 持有：readline 终端模式下 Ctrl+C 不产生真 SIGINT（raw mode 吞掉），
 * 改由 rl 的 'SIGINT' 事件经 hooks.abort 中转进来，保证「生成中 Ctrl+C 可中断」的承诺成立。
 * notifier（util/tui/notify.mjs）可选：完成 / 失败 / 授权 / 提问四类事件按 tui.notifications
 * 配置发系统通知（unfocused 时先尽力探测焦点，失败按未聚焦通知——宁可多响不漏响）。
 */
export async function runTerminalTurn({ store, usage, session, input, provider, model, harness, cfg, painter, ask, onUsage, onSession, hooks, extraTools = [], goalStore = null, notifier = null, failoverCandidates = null, providerFailover = true, providerFailoverMaxAttempts,
  failoverState = null, failoverTimeouts = null, failoverQueue = null }) {
  const started = Date.now();
  let phase = 'idle'; // idle -> think -> text
  let atLineStart = true;
  let toolLineOpen = false;
  const rejectedTools = new Set(); // loop 对拒绝会补发 failed，这里去重并按拒绝呈现
  let controller = null;
  let aborted = false;
  let pendingPerm = null;
  let pendingPlan = null;
  let lastGoalStatus = null; // goal 状态去重键：只在状态真变时打印（用量事件不刷屏）

  const write = (s) => { process.stdout.write(s); atLineStart = s.endsWith('\n'); };
  const breakLine = () => { if (!atLineStart) write('\n'); };
  const endToolLine = () => { if (toolLineOpen) { write(CLEAR); toolLineOpen = false; } };

  const onSigint = () => {
    aborted = true;
    controller?.abort();
    // 权限 / 计划询问期间中断：按拒绝 / 驳回放行，让循环收尾成 turn_cancelled
    if (pendingPerm) pendingPerm('n');
    if (pendingPlan) pendingPlan('n');
  };
  process.on('SIGINT', onSigint);
  if (hooks) hooks.abort = onSigint;

  const emit = (type, p) => {
    switch (type) {
      case 'model_round_started':
        endToolLine();
        breakLine();
        phase = 'idle'; // 新一轮：思考与正文各自带标题，不与上一轮连篇
        break;
      case 'thinking_chunk':
        endToolLine();
        if (phase !== 'think') { breakLine(); write(`\n${painter.dim('思考 ')}`); phase = 'think'; }
        write(painter.think(p.text));
        break;
      case 'text_chunk':
        endToolLine();
        if (phase !== 'text') {
          breakLine();
          if (phase === 'think') write(`\n${painter.dim('─'.repeat(46))}\n`);
          phase = 'text';
        }
        write(p.text);
        break;
      case 'tool_event': {
        endToolLine();
        const label = toolLabel(p.toolName);
        const sub = p.subAgent ? `${painter.accent('└')} ` : ''; // 子代理工具调用缩进一级呈现
        const res = p.resource || (p.params && (p.params.path || p.params.url || p.params.command || p.params.dir)) || '';
        if (p.phase === 'started') {
          breakLine();
          write(`  ${sub}${painter.dim('…')} ${label}${res ? ` ${painter.dim(String(res))}` : ''}`);
          toolLineOpen = true;
        } else if (p.phase === 'confirmation_needed') {
          toolLineOpen = false; // 行已由 endToolLine 清掉，转为权限询问
          notifier?.notify('permission-required', { title: session.name, body: `需要授权：${label}${res ? ` ${res}` : ''}` });
        } else if (p.phase === 'confirmed') {
          write(`  ${sub}${painter.dim('…')} ${label}${res ? ` ${painter.dim(String(res))}` : ''}`);
          toolLineOpen = true;
        } else if (p.phase === 'completed') {
          write(`  ${sub}${painter.success('✓')} ${label}${res ? ` ${res}` : ''}${p.durationMs != null ? painter.dim(` ${p.durationMs}ms`) : ''}\n`);
          if (p.toolName === 'todo' && Array.isArray(p.extra?.todos)) {
            const t = p.extra.todos;
            write(`  ${painter.dim(`待办进度 ${t.filter((x) => x.done).length}/${t.length}`)}\n`);
          }
          if (p.output) { breakLine(); write(painter.dim(indent(p.output, 220)) + '\n'); }
        } else if (p.phase === 'failed') {
          const denied = rejectedTools.has(p.toolId);
          write(`  ${sub}${painter.error('✗')} ${label}${res ? ` ${res}` : ''}${denied ? painter.dim(' 已拒绝') : ''}\n`);
          if (p.output && !denied) { breakLine(); write(painter.dim(indent(p.output, 220)) + '\n'); }
        } else if (p.phase === 'rejected') {
          rejectedTools.add(p.toolId); // 行不在此处打印：随后到的 failed 负责收尾
        }
        break;
      }
      case 'plan_proposed':
        endToolLine();
        breakLine();
        write(`\n${painter.accent('  计划')}（只读探索产出，尚未执行任何修改）\n`);
        notifier?.notify('question-required', { title: session.name, body: '计划待批准' });
        write(painter.text(indent(String(p.plan || ''), 220)) + '\n');
        break;
      case 'plan_approved':
        endToolLine();
        breakLine();
        write(painter.success('  计划已批准，进入执行') + '\n');
        break;
      case 'plan_rejected':
        endToolLine();
        breakLine();
        write(painter.warning('  计划已驳回，未做任何修改') + '\n');
        break;
      case 'goal_created': {
        endToolLine();
        breakLine();
        const g = p.goal;
        lastGoalStatus = `${g.status}:${g.statusReason || ''}`;
        write(`  ${painter.accent('目标')} ${truncate(g.objective, 60)} ${painter.dim(goalUsageChip(g))}
`);
        break;
      }
      case 'goal_status_changed': {
        endToolLine();
        breakLine();
        const g = p.goal;
        const key = `${g.status}:${g.statusReason || ''}`;
        if (key !== lastGoalStatus) {
          lastGoalStatus = key;
          const reason = p.statusReason ? painter.dim(`（${p.statusReason}）`) : '';
          write(`  ${painter.accent('目标')} → ${painter.text(GOAL_STATUS_LABELS[g.status] || g.status)}${reason} ${painter.dim(goalUsageChip(g))}
`);
        }
        break;
      }
      case 'goal_wait_changed':
        if (!p.reason) break; // 等待结束不单独打印：紧随其后的状态变更事件会说明
        endToolLine();
        breakLine();
        write(`  ${painter.dim(`目标${GOAL_WAIT_LABELS[p.reason] || '等待中'}…`)}
`);
        break;
      case 'token_usage_updated':
        endToolLine();
        breakLine();
        write(painter.dim(`  ↳ tokens 输入 ${p.inputTokens} · 输出 ${p.outputTokens} · 约 ¥${fmtCost(p.cost)}\n`));
        onUsage?.({ inputTokens: p.inputTokens, outputTokens: p.outputTokens, cost: p.cost });
        break;
      case 'context_compression_started':
        endToolLine();
        breakLine();
        write(painter.dim('  ↳ 上下文超限，正在折叠早期对话…\n'));
        break;
      case 'context_compression_completed':
        endToolLine();
        breakLine();
        write(painter.dim(`  ↳ 已折叠，保留近期 ${p.keptRecords} 条记录\n`));
        break;
      case 'context_compression_failed':
        endToolLine();
        breakLine();
        write(painter.dim(`  ↳ 折叠失败，沿用原上下文：${p.error}\n`));
        break;
      case 'provider_switched':
        endToolLine();
        breakLine();
        write(`  ${painter.accent('切换')} ${p.fromName || p.from} → ${p.toName || p.to} ${painter.dim(`（${SWITCH_REASON_LABELS[p.reason] || p.reason}，第 ${p.attempt} 次尝试）`)}\n`);
        break;
      case 'session_renamed':
        endToolLine();
        breakLine();
        write(painter.dim(`  ↳ 会话标题已${p.mode === 'model' ? '由模型总结' : '按首条消息'}更新为 ${p.name}\n`));
        break;
      case 'turn_cancelled':
        endToolLine();
        breakLine();
        write(painter.dim('  (已中断，以上为部分输出，仍保留在会话中)\n'));
        break;
      case 'turn_failed':
        endToolLine();
        breakLine();
        write(`${painter.error('✗')} ${p.error}\n`);
        notifier?.notify('turn-failed', { title: session.name, body: String(p.error || '任务失败').slice(0, 120) });
        break;
      case 'turn_completed':
        endToolLine();
        breakLine();
        write(painter.dim(`  ↳ ${p.totalRounds} 轮 · ${p.totalTools} 个工具 · ${((Date.now() - started) / 1000).toFixed(1)}s\n`));
        notifier?.notify('turn-complete', { title: session.name, body: `已完成 · ${p.totalRounds} 轮 · ${p.totalTools} 个工具` });
        break;
    }
  };

  const turnController = new AbortController();
  controller = turnController;
  write(`\n${painter.success('AuroraAgent')} ${painter.dim('›')} `);
  phase = 'idle';
  try {
    await runAgentTurn({
      store, usage, session, input, provider, model, harness, builtinPrice: PRICE,
      gen: { maxTokens: cfg.maxTokens, temperature: cfg.temperature, thinkingOn: cfg.thinking },
      emit, controller: turnController, extraTools, goalStore, goalCfg: cfg.goal,
      permissionMode: cfg.permissionMode,
      planMode: session.planMode !== undefined ? session.planMode === true : cfg.planMode === true,
      titleMode: TITLE_MODES.includes(session.titleMode) ? session.titleMode : cfg.titleMode,
      agentProxy: cfg.agentProxy,
      providerFailover: providerFailover !== false && cfg.providerFailover !== false,
      providerFailoverMaxAttempts: providerFailoverMaxAttempts || cfg.providerFailoverMaxAttempts,
      failoverCandidates,
      failoverState, failoverTimeouts, failoverQueue,
      // 权限询问与主输入共用同一条 line 通道（ask()），避免 readline 双消费；
      // 中断（Ctrl+C）时按拒绝放行，让循环收尾成 turn_cancelled
      requestPermission: ({ toolName, params, resource }) => new Promise((resolve) => {
        const res = resource || (params && (params.path || params.url || params.command || params.dir)) || '';
        write(`${painter.warning('  需要授权')} ${toolLabel(toolName)}${res ? ` ${res}` : ''}\n  [y]允许 [a]总是允许 [n]拒绝 › `);
        pendingPerm = (line) => {
          pendingPerm = null;
          atLineStart = true; // readline 已回显换行
          const a = String(line).trim().toLowerCase();
          resolve(a === 'a' || a === 'always' ? 'always' : a === 'n' || a === 'no' || a === '' ? 'deny' : 'allow');
        };
        ask().then((line) => { if (pendingPerm) pendingPerm(line); });
      }),
      // 计划决策与权限询问共用同一条 line 通道；Ctrl+C 按驳回放行
      requestPlanDecision: ({ plan }) => new Promise((resolve) => {
        write(`\n${painter.accent('  计划')}（只读探索产出，尚未执行任何修改）\n`);
        write(painter.text(indent(String(plan || ''), 220)) + '\n');
        write(`  [y]批准执行 [n]驳回 › `);
        pendingPlan = (line) => {
          pendingPlan = null;
          atLineStart = true;
          const a = String(line).trim().toLowerCase();
          resolve(a === 'y' || a === 'yes' ? 'approve' : 'reject');
        };
        ask().then((line) => { if (pendingPlan) pendingPlan(line); });
      }),
      log: () => {},
    });
  } finally {
    process.removeListener('SIGINT', onSigint);
    if (hooks) hooks.abort = null;
    endToolLine();
    breakLine();
    onSession?.(store.get(session.id)?.meta || session);
  }
  return aborted;
}
