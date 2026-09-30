/**
 * AuroraAgent 终端 REPL 协调器（零依赖）：readline REPL + 声明式斜杠命令 + TUI 组件。
 * 流式渲染下沉 terminal-turn.mjs，纯助手在 terminal-format.mjs；对话框 / footer / 键位
 * 规范见 docs/tui-design.md，工具包见 util/tui/。颜色一律 painter（theme.mjs 单一真值源）。
 * 与网页共用同一套 Agent Loop（loop.mjs）与会话 / 账本数据目录，两端可交替使用。
 */
import { createInterface } from 'node:readline';
import { SessionStore } from './session.mjs';
import { GoalStore } from './goal/store.mjs';
import { GOAL_STATUS_LABELS, GOAL_WAIT_LABELS } from './goal/types.mjs';
import { goalUsageChip } from './goal/budget.mjs';
import { applyUserGoalAction, setUserGoalObjective, clearUserGoal } from './goal/actions.mjs';
import { parseGoalCommand, formatGoalSummary, GOAL_COMMAND_HELP } from './goal/command.mjs';
import { UsageLedger } from '../usage.mjs';
import { ProviderStore } from '../providers.mjs';
import { FailoverState } from '../llm/failover-state.mjs';
import { parseFailoverConfig, effectiveTimeouts } from '../llm/failover.mjs';
import { HARNESSES, getHarness } from './harness.mjs';
import { loadConfig, saveConfig, PRICE, resolveDataDir, experimentalEnabled, TITLE_MODES } from '../config.mjs';
import { McpRegistry } from '../mcp/registry.mjs';
import { defineCommands, commandHelpLines, parseCommand } from '../tui/commands.mjs';
import { renderFooter } from '../tui/footer.mjs';
import { buildTerminalTitle, oscTitle, clearTitle } from '../tui/title.mjs';
import { createNotifier } from '../tui/notify.mjs';
import { paletteFor, createPainter } from '../tui/theme.mjs';
import { SearchableList } from '../tui/searchable-list.mjs';
import { pick } from '../tui/pick.mjs';
import { runTerminalTurn } from './terminal-turn.mjs';
import { loadSkills, skillInvocationText } from './skills.mjs';
import { SideSession } from './side-session.mjs';
import { join } from 'node:path';
import { truncate, toolLabel } from './terminal-format.mjs';
import { formatQueueLines, parseQueueArg, pickQueueItem } from './queue-cmd.mjs';
import { JobStore } from '../jobs/store.mjs';
import { formatJobLines, parseCronArg, pickJob } from './cron-cmd.mjs';
import { createHookRunner } from './hooks/index.mjs';
import { parseHooksArg, formatHookLines, formatHookEventLines, formatHookTestLines } from './hooks-cmd.mjs';
import { createCheckpointRuntime, readCheckpointHistory } from './checkpoint.mjs';
import { restoreCheckpoint } from './checkpoint-restore.mjs';
import { parseCheckpointArg, formatCheckpointLines, formatCheckpointDiffLines } from './checkpoint-cmd.mjs';
import { trimRecordsToTurn } from './checkpoint-restore.mjs';
import { discoverRules } from './rules.mjs';
import { parseRulesArg, formatRuleLines, formatRuleToggleLines, ruleCandidatePaths } from './rules-cmd.mjs';

const BASE = process.env.AURORAAGENT_BASE_URL || 'https://api.longcat.chat';
const KEY_PAGE = 'https://longcat.chat/platform/api_keys';
const MODEL_RE = /^[A-Za-z0-9._:-]{1,80}$/;
const LIST_HINT = '↑↓ navigate · ←→ page · Enter select · Esc cancel';
const THEMES = [
  { id: 'dark', label: '暗色' },
  { id: 'light', label: '亮色' },
  { id: 'auto', label: '跟随终端' },
];

/** 终端入口：argv 透传 --key 与 -p（单次提问） */
export async function runTerminal({ argv = [] } = {}) {
  const cfg = loadConfig();
  const keyIdx = argv.indexOf('--key');
  if (keyIdx >= 0 && argv[keyIdx + 1]) {
    cfg.apiKey = argv[keyIdx + 1];
    if (!cfg.keyIsOverride && process.env.AURORAAGENT_API_KEY) cfg.keyIsOverride = true;
  }
  const pIdx = argv.indexOf('-p');
  const oneShot = pIdx >= 0 ? argv[pIdx + 1] : null;

  if (!cfg.apiKey) {
    const p0 = createPainter(paletteFor('auto').colors);
    console.log(p0.warning('[!] 还未配置 API Key'));
    console.log(`  1. 打开 ${KEY_PAGE} 注册/登录并创建 Key`);
    console.log('  2. 回来执行下面的命令之一:');
    console.log(`     ${p0.primary('export AURORAAGENT_API_KEY="ak-你的Key"')} 然后 node chat.mjs`);
    console.log(`     或在对话中输入 ${p0.primary('/key ak-你的Key')}`);
    if (!oneShot) process.exit(1);
  }

  const dataDir = resolveDataDir();
  // 技能目录：内置 skills/ + 用户 <数据目录>/skills/（进程启动时加载一次，新增技能重启后生效）
  const skills = loadSkills({ userDir: join(dataDir, 'skills') });
  const store = new SessionStore(dataDir);
  const goals = new GoalStore(dataDir);
  // 定时任务（#3149）：与网页共用同一份 <数据目录>/jobs.json（各自进程内一份 store，落盘原子写不打架）
  const jobs = new JobStore(dataDir);
  const usage = new UsageLedger(dataDir);
  // 故障转移运行时状态（熔断快照 + 热切换偏好）：与网页共用同一份 <数据目录>/failover-state.json，
  // 两个客户端因此共享「哪家不健康」的跨请求记忆
  const failoverState = new FailoverState(dataDir, {
    warn: (m, e) => console.error(painter().warning(`${m}${e && e.error ? `（${e.error}）` : ''}`)),
    config: { circuit: parseFailoverConfig(cfg, {}).circuit },
    prefTtlMs: parseFailoverConfig(cfg, {}).prefTtlHours * 3600_000,
  }).load();
  const failoverTimeouts = () => effectiveTimeouts(parseFailoverConfig(loadConfig(), {}));
  const providers = new ProviderStore(dataDir, {
    baseUrl: BASE, pathPrefix: '/openai/v1', apiKey: () => cfg.apiKey, model: () => cfg.model,
  }, () => [], {
    prefFor: (m) => failoverState.prefFor(m),
    failoverEnabled: () => loadConfig().providerFailover !== false,
  });

  // MCP 注册表（实验特性门控）：启用时后台连接并发现工具，/mcp 查看状态
  const mcp = experimentalEnabled('MCP') ? new McpRegistry({ dataDir }) : null;
  if (mcp) mcp.refresh().catch(() => {});
  // 检查点运行时按会话持有（历史跨轮累积）：终端与网页各一份 store，但快照本体在仓库 .git
  // 或数据目录 backups/，两端看到的是同一批检查点。切会话时按新会话的工作目录重建
  let checkpointRt = null;
  const checkpointFor = (sid, workspace) => {
    if (checkpointRt && checkpointRt.sessionId === sid) return checkpointRt;
    checkpointRt = createCheckpointRuntime({
      workspace, dataDir, sessionId: sid, log: () => {},
      history: readCheckpointHistory(store.get(sid)?.meta),
    });
    return checkpointRt;
  };
  // 事件钩子运行器（实验特性门控）：按工作目录缓存——项目钩子与个人钩子的发现根不同，
  // 切换会话（换工作目录）时看到的是那一份目录的钩子。门控关闭时恒空转
  const hookRunners = new Map();
  const hookRunnerFor = (workspace) => {
    const key = String(workspace || process.cwd());
    let runner = hookRunners.get(key);
    if (!runner) {
      runner = createHookRunner({ workspace: key, dataDir, log: () => {} });
      hookRunners.set(key, runner);
    }
    return runner;
  };

  let meta = store.list()[0] || store.create({
    model: cfg.model, provider: providers.providerForModel(cfg.model).id, harness: 'standard', titleMode: cfg.titleMode,
  });

  // 主题：环境变量 AURORAAGENT_THEME 或会话内 /theme 切换；painter 每帧从当前色板新建
  let themeChoice = process.env.AURORAAGENT_THEME || 'auto';
  const painter = () => createPainter(paletteFor(themeChoice).colors);
  const foot = { tokens: null, cost: null }; // footer 展示的最近一次用量
  // 系统通知器：按 tui.notifications 配置（when/method/events）发 OSC9 / OSC777 / bel
  const notifier = createNotifier({ notifications: cfg.tui.notifications });

  // Ctrl+/（\x1f）切换主 / 侧边对话。监听必须在 createInterface 之前挂上：data 监听按注册
  // 顺序触发，先摘掉 readline 的 keypress 监听，本 chunk 的控制符就不会进输入缓冲
  // （emitKeypressEvents 的 keypress 事件随后空转），下一 tick 恢复（与 pick.mjs 拾矿同源）。
  const ctrlSlash = { handler: () => {} };
  if (process.stdin.isTTY) {
    process.stdin.on('data', (d) => {
      if (String(d) !== '\x1f') return;
      const saved = process.stdin.rawListeners('keypress').slice();
      for (const l of saved) process.stdin.removeListener('keypress', l);
      setImmediate(() => { for (const l of saved) process.stdin.on('keypress', l); });
      ctrlSlash.handler();
    });
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  // OSC 终端标题：状态词随 mode/busy 变；退出与挂起清空、恢复重设
  const applyTitle = () => {
    const t = buildTerminalTitle(cfg.tui.terminalTitle, {
      state: btwMode ? '侧边对话' : busy ? '生成中' : '就绪',
      session: meta.name,
      app: 'AuroraAgent',
    });
    if (t) process.stdout.write(oscTitle(t));
  };
  // 挂起（Ctrl+Z）：Node 会拦截 SIGTSTP 的重发导致假挂起，改用不可捕获的 SIGSTOP 真正停下；
  // 期间标题已清空，SIGCONT（fg）后按当前状态重设
  process.on('SIGTSTP', () => {
    process.stdout.write(clearTitle());
    process.kill(process.pid, 'SIGSTOP');
  });
  process.on('SIGCONT', () => applyTitle());
  // 退出统一出口：清标题再走（oneShot / close / wantExit 三条路径共用）
  const cleanExit = () => { process.stdout.write(clearTitle()); process.exit(0); };

  const hooks = {}; // turn 运行期挂 abort；rl 的 SIGINT 事件中转进来（raw mode 下无真信号）
  rl.on('SIGINT', () => {
    if (hooks.abort) hooks.abort(); // 生成中：中断并保留已生成内容
    else if (btwMode) discardBtw(); // 侧边对话空提示符：丢弃侧边对话，回到主对话
    else rl.close(); // 主对话空提示符：退出（与无监听时的 readline 默认行为一致）
  });
  let busy = false;
  let btw = null; // 侧边对话实例（SideSession；null = 未开）
  let btwMode = false; // 侧边对话模式（/btw 进入，Ctrl+/ 切换）
  let wantExit = false;
  let quitting = false;
  const lineQueue = [];
  let lineWaiter = null;
  rl.on('line', (raw) => {
    const line = raw.trim();
    if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(line); }
    else lineQueue.push(line);
  });
  rl.on('close', () => { if (!busy && !lineQueue.length) cleanExit(); wantExit = true; });
  const ask = () => {
    if (lineQueue.length) return Promise.resolve(lineQueue.shift());
    if (wantExit) cleanExit();
    return new Promise((res) => { lineWaiter = res; });
  };

  /** 打印会话尾部几行，帮助找回上下文 */
  const printRecap = (m) => {
    const records = store.records(m.id);
    for (const r of records.slice(-6)) {
      if (r.t === 'user') console.log(painter().dim('  你 › ') + truncate(r.text, 90));
      else if (r.t === 'assistant') console.log(painter().dim('  AI › ') + truncate(r.text, 90));
      else if (r.t === 'tool_call') console.log(painter().dim(`  · ${toolLabel(r.name)}`));
      else if (r.t === 'summary') console.log(painter().dim('  · 早期对话已折叠为摘要'));
    }
    if (records.length > 6) console.log(painter().dim(`  …共 ${records.length} 条记录`));
  };

  const printBanner = () => {
    const p = painter();
    const harness = getHarness(meta.harness);
    console.log(p.accent('  AuroraAgent · 终端 Agent'));
    console.log(p.dim(`  模型 ${meta.model || cfg.model} · 模式 ${harness.label} · 思考 ${cfg.thinking ? '开' : '关'} · 温度 ${cfg.temperature} · 上限 ${cfg.maxTokens} tokens`));
    console.log(p.dim(`  会话 ${meta.name}（${meta.turns} 轮）· 工作目录 ${meta.workspace}`));
    console.log(p.dim('  命令: /help 查看全部 · 生成中 Ctrl+C 可中断并保留已生成内容 · 工具执行前会询问授权'));
    console.log(p.dim(`  Key 获取: ${KEY_PAGE}\n`));
  };

  const printHelp = () => {
    const p = painter();
    console.log(`\n${p.bold('textStrong', '可用命令')}`);
    for (const line of commandHelpLines(commands)) console.log(p.dim(line));
    console.log(p.dim('  生成中 Ctrl+C 可中断并保留已生成内容 · 工具执行前按权限模式询问授权\n'));
  };

  /** 可搜索单选：SearchableList + docs/tui-design.md 第 3 节对话框；非 TTY 自动退化 */
  const choose = async ({ items, title, currentId, columns, text }) => {
    const list = new SearchableList(items, { pageSize: 8, text });
    list.focusById(currentId);
    return pick({
      list, title, hint: LIST_HINT, painter: painter(), ask, currentId, columns,
    });
  };

  const cmdSessions = async (arg) => {
    if (arg) {
      const list = store.list();
      const idx = Number(arg) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
        console.log(painter().warning(`用法: /sessions <1-${list.length || 1}>`));
        return;
      }
      meta = list[idx];
      applyTitle();
      console.log(painter().dim(`✓ 已切换到：${meta.name}`));
      if (meta.turns > 0) printRecap(meta);
      return;
    }
    const list = store.list();
    if (!list.length) { console.log(painter().dim('  (没有会话)')); return; }
    const chosen = await choose({
      items: list, title: '切换会话', currentId: meta.id,
      text: (m) => `${m.name} ${m.id}`,
      columns: (m) => [{ text: `${getHarness(m.harness).label} · ${m.turns} 轮`, width: 20 }],
    });
    if (!chosen) return;
    meta = chosen;
    applyTitle();
    console.log(painter().dim(`✓ 已切换到：${chosen.name}`));
    if (meta.turns > 0) printRecap(meta);
  };

  const cmdHarness = async (arg) => {
    if (arg) {
      const h = getHarness(arg);
      if (h.id !== arg) { console.log(painter().warning(`未知模式: ${arg}（可用 ${HARNESSES.map((x) => x.id).join(' / ')}）`)); return; }
      meta = store.patch(meta.id, { harness: h.id }) || meta;
      console.log(painter().dim(`✓ 已切换到 ${h.label} 模式`));
      return;
    }
    const chosen = await choose({
      items: HARNESSES, title: '选择模式', currentId: meta.harness,
      text: (h) => `${h.label} ${h.id} ${h.summary}`,
      columns: (h) => [{ text: h.tools.length ? `${h.tools.length} 工具 · ${h.maxRounds} 轮` : `无工具 · ${h.maxRounds} 轮`, width: 16 }],
    });
    if (!chosen) return;
    meta = store.patch(meta.id, { harness: chosen.id }) || meta;
    console.log(painter().dim(`✓ 已切换到 ${chosen.label} 模式`));
  };

  const cmdTheme = async (arg) => {
    if (arg) {
      if (!THEMES.some((t) => t.id === arg)) {
        console.log(painter().warning(`未知主题: ${arg}（可用 ${THEMES.map((t) => t.id).join(' / ')}）`));
        return;
      }
      themeChoice = arg;
      console.log(painter().dim(`✓ 主题 = ${THEMES.find((t) => t.id === arg).label}`));
      return;
    }
    const chosen = await choose({ items: THEMES, title: '终端主题', currentId: themeChoice, text: (t) => `${t.label} ${t.id}` });
    if (!chosen) return;
    themeChoice = chosen.id;
    console.log(painter().dim(`✓ 主题 = ${chosen.label}`));
  };

  /** /goal：一会话一目标的用户面管理（解析与文案和网页 Composer 共用 command.mjs 单一事实源） */
  const cmdGoal = (arg) => {
    const p = painter();
    const intent = parseGoalCommand(arg);
    const cur = goals.get(meta.id);
    switch (intent.kind) {
      case 'view': {
        if (!cur) { console.log(p.dim('当前会话没有目标：/goal <你想达成的目标> 设立，或让模型调用 create_goal')); return; }
        console.log(`  ${p.text('目标')} ${p.dim(cur.goalId)}`);
        for (const line of formatGoalSummary(cur).split('\n')) console.log(`  ${line}`);
        if (cur.executionWait) console.log(p.dim(`  当前${GOAL_WAIT_LABELS[cur.executionWait.reason] || '等待中'}`));
        return;
      }
      case 'help':
        for (const line of GOAL_COMMAND_HELP.split('\n')) console.log(p.dim(`  ${line}`));
        return;
      case 'error':
        console.log(p.warning(intent.message));
        return;
      case 'edit': {
        if (!cur) { console.log(p.warning('当前会话没有目标')); return; }
        // 回填输入框续编（readline 写入即插入当前行；换字符归一防提前提交）
        rl.write(`/goal ${String(cur.objective || '').replace(/\s+/g, ' ')}`);
        return;
      }
      case 'clear': {
        const { cleared } = clearUserGoal(goals, meta.id);
        console.log(p.dim(cleared ? '✓ 目标已移除' : '当前会话没有目标'));
        return;
      }
      case 'create': {
        try {
          const existed = Boolean(cur) && cur.status !== 'complete';
          const g = setUserGoalObjective(goals, meta.id, intent.objective, intent.tokenBudget, { expectedUpdatedAt: cur?.updatedAt });
          const budgetNote = intent.tokenBudget != null ? ` · 预算 ${intent.tokenBudget} tokens` : '';
          console.log(p.dim(`✓ ${existed ? '目标文本已更新' : '新目标已设立'}${budgetNote}：${truncate(g.objective, 60)}`));
        } catch (e) { console.log(p.warning(e.message)); }
        return;
      }
      case 'budget': {
        if (!cur) { console.log(p.warning('当前会话没有目标')); return; }
        try {
          const g = applyUserGoalAction(goals, meta.id, 'budget', { tokenBudget: intent.tokenBudget, expectedUpdatedAt: cur.updatedAt });
          const rearmed = cur.status === 'budget_limited' && g.status === 'active';
          console.log(p.dim(`✓ 预算已${intent.tokenBudget == null ? '清除' : `设为 ${intent.tokenBudget}`}${rearmed ? '，目标已重新武装' : ''}`));
        } catch (e) { console.log(p.warning(e.message)); }
        return;
      }
      default: {
        // pause / resume / stop：状态迁移（拒绝信息由 applyUserGoalAction 说清原因）
        if (!cur) { console.log(p.warning('当前会话没有目标')); return; }
        try {
          const g = applyUserGoalAction(goals, meta.id, intent.kind);
          const label = { pause: '已暂停', resume: '已恢复', stop: '已停止' }[intent.kind];
          console.log(p.dim(`✓ 目标${label}：${GOAL_STATUS_LABELS[g.status]}`));
        } catch (e) { console.log(p.warning(e.message)); }
        return;
      }
    }
  };

  /**
   * /queue 家族：查看 / 立即发送 / 移除 / 清空本地排队行。
   * 队列本身由 lineQueue 持有（busy 期间输入自动入队，空闲即按序发出），
   * 与网页侧 util/agent/queue.mjs 的服务端队列是同一条用户意图的两种落点。
   */
  const cmdQueue = (arg) => {
    const p = painter();
    const parsed = parseQueueArg(arg);
    if (parsed.action === 'list') {
      for (const line of formatQueueLines(lineQueue)) console.log('  ' + p.dim(line));
      if (lineQueue.length) console.log(p.dim(`  /queue send <序号> 立即发送 · /queue drop <序号> 移除 · /queue clear 清空`));
      return;
    }
    if (parsed.action === 'clear') {
      const n = lineQueue.length;
      lineQueue.length = 0;
      console.log(n ? p.dim(`✓ 已清空 ${n} 条排队消息`) : p.dim('队列本就是空的'));
      return;
    }
    if (parsed.action === 'error') { console.log(p.warning(parsed.message)); return; }
    const picked = pickQueueItem(lineQueue, parsed.index);
    if (picked.error) { console.log(p.warning(picked.error)); return; }
    const idx = lineQueue.indexOf(picked.item);
    if (parsed.action === 'send') {
      const [item] = lineQueue.splice(idx, 1);
      lineQueue.unshift(item);
      console.log(p.dim(`✓ 已把「${truncate(item, 40)}」挪到队首，下一条就发它`));
      return;
    }
    lineQueue.splice(idx, 1);
    console.log(p.dim(`✓ 已移除「${truncate(picked.item, 40)}」`));
  };

  /**
   * /cron 家族：查看 / 新建 / 删除 / 立即跑 / 启停当前会话的定时任务。
   * 到期执行由网页服务的调度器负责（util/jobs/schedule.mjs），终端只做增删改查与手动触发——
   * 手动触发就是把到期内容作为一条普通用户消息发出去，走的是同一条 runTurn。
   */
  const cmdCron = (arg) => {
    const p = painter();
    const parsed = parseCronArg(arg);
    if (parsed.action === 'list') {
      for (const line of formatJobLines(jobs.forSession(meta.id))) console.log('  ' + p.dim(line));
      console.log(p.dim('  /cron add <名称> | <表达式> | <到期内容> · /cron run <id> 立即跑 · /cron on|off <id> 启停'));
      return;
    }
    if (parsed.action === 'help') {
      console.log(p.dim('  用法: /cron [add <名称> | <表达式> | <到期内容>|remove <id>|run <id>|on|off <id>]'));
      return;
    }
    if (parsed.action === 'error') { console.log(p.warning(parsed.message)); return; }
    const mine = jobs.forSession(meta.id);
    if (parsed.action === 'add') {
      try {
        const job = jobs.create({ name: parsed.name, sessionId: meta.id, prompt: parsed.prompt, schedule: parsed.schedule, enabled: true });
        const when = job.schedule.kind === 'cron' ? job.schedule.expr : `每 ${Math.round(job.schedule.everyMs / 60000)} 分钟`;
        console.log(p.dim(`✓ 已创建「${job.name}」：${when}，下次 ${new Date(job.nextRunAt).toLocaleString('zh-CN', { hour12: false })}（id=${job.id.slice(0, 8)}）`));
      } catch (e) { console.log(p.warning(e.message)); }
      return;
    }
    const picked = pickJob(mine, parsed.id);
    if (picked.error) { console.log(p.warning(picked.error)); return; }
    const job = picked.job;
    if (parsed.action === 'remove') {
      jobs.remove(job.id);
      console.log(p.dim(`✓ 已删除「${job.name}」`));
      return;
    }
    if (parsed.action === 'on' || parsed.action === 'off') {
      const updated = jobs.update(job.id, () => ({ enabled: parsed.action === 'on' }));
      console.log(p.dim(`✓ 「${updated.name}」已${updated.enabled ? '启用' : '停用'}`));
      return;
    }
    // run：到期内容作为一条普通用户消息发出去（由 REPL 主循环接着跑）
    console.log(p.dim(`✓ 立即执行「${job.name}」：${truncate(job.prompt, 60)}`));
    lineQueue.push(job.prompt);
  };

  /**
   * /hooks 家族：查看 / 手动触发当前工作目录的事件钩子。
   * 钩子由 loop.mjs 在各阶段闸口自动触发（见 util/agent/hooks/），这里只做「看得见」与「试得动」——
   * test 用一个合成 payload 打真实脚本，不跑上游、不动会话，纯验证脚本写得对不对。
   */
  const cmdHooks = async (arg) => {
    const p = painter();
    const parsed = parseHooksArg(arg);
    if (parsed.action === 'events') {
      for (const line of formatHookEventLines()) console.log('  ' + p.dim(line));
      return;
    }
    if (parsed.action === 'error') { console.log(p.warning(parsed.message)); return; }
    const runner = hookRunnerFor(meta.workspace);
    if (parsed.action === 'list') {
      for (const line of formatHookLines({ enabled: runner.enabled, hooks: runner.hooks })) console.log('  ' + p.dim(line));
      console.log(p.dim('  /hooks events 看全部事件 · /hooks test <事件名> 手动触发一次'));
      return;
    }
    const outcome = await runner.fire(parsed.event, {
      sessionId: meta.id, turnId: 'manual', workspace: meta.workspace || process.cwd(), round: 0,
    }, { input: '（手动触发，非真实发言）', manual: true });
    for (const line of formatHookTestLines(parsed.event, outcome)) console.log('  ' + p.dim(line));
  };

  /**
   * /checkpoint 家族：查看 / 预览 / 回滚当前会话的检查点。
   * 每轮用户发言开始时自动拍一张（util/agent/checkpoint.mjs），这里只做「看得见、看得懂、
   * 敢回滚」——restore 前先给 diff 预览，回滚本身带事务（失败自动回到恢复前的工作区）。
   */
  const cmdCheckpoint = async (arg) => {
    const p = painter();
    const parsed = parseCheckpointArg(arg);
    if (parsed.action === 'list') {
      const rt = checkpointFor(meta.id, meta.workspace);
      for (const line of formatCheckpointLines(rt.entries)) console.log('  ' + p.dim(line));
      console.log(p.dim('  /checkpoint diff <轮次> 预览 · /checkpoint restore <轮次> [chat] 回滚 · /checkpoint clean 清空'));
      return;
    }
    if (parsed.action === 'error') { console.log(p.warning(parsed.message)); return; }
    if (busy) { console.log(p.warning('正在生成中，等这一轮结束后再回滚')); return; }
    const rt = checkpointFor(meta.id, meta.workspace);
    const entry = rt.entries.find((e) => e.turnIndex === parsed.turnIndex);
    if (!entry) {
      console.log(p.warning(`第 ${parsed.turnIndex} 轮没有检查点（可用：${rt.entries.map((e) => e.turnIndex).join('、') || '无'}）`));
      return;
    }
    if (parsed.action === 'diff') {
      for (const line of formatCheckpointDiffLines(store.records(meta.id), parsed.turnIndex, rt.entries)) console.log('  ' + p.dim(line));
      return;
    }
    if (parsed.action === 'clean') {
      await rt.close();
      console.log(p.dim('✓ 已清掉当前会话的全部检查点'));
      return;
    }
    try {
      const r = await restoreCheckpoint(meta.workspace, entry, { dataDir, sessionId: meta.id, log: () => {} });
      const what = r.kind === 'mirror' ? `还原 ${r.restored} 个文件、删掉 ${r.removed} 个本轮新建文件` : '工作区已回到那一轮';
      console.log(p.dim(`✓ 已回滚到第 ${parsed.turnIndex} 轮：${what}`));
      if (parsed.withChat) {
        const cut = trimRecordsToTurn(store.records(meta.id), parsed.turnIndex);
        if (cut.trimmed > 0) store.replaceRecords(meta.id, cut.records);
        console.log(p.dim(`✓ 对话已裁到第 ${parsed.turnIndex} 轮（删掉之后 ${cut.trimmed} 条记录）`));
      } else {
        console.log(p.dim('  对话记录保留（要连对话一起裁：/checkpoint restore <轮次> chat）'));
      }
    } catch (e) { console.log(p.warning(e?.message || String(e))); }
  };

  /**
   * /rules 家族：查看 / 开关当前发现的规则（用户指令层）。
   * 规则文件在文件系统里编辑（<工作目录>/AGENTS.md、<工作目录>/.auroraagent/rules/*.md、
   * <数据目录>/rules/*.md），这里只做「开 / 关」——与网页设置页「规则」section 共用同一份
   * toggle 表（config.rules.toggles），一端改另一端下一轮即生效。
   */
  const cmdRules = (arg) => {
    const p = painter();
    const parsed = parseRulesArg(arg);
    if (parsed.action === 'error') { console.log(p.warning(parsed.message)); return; }
    const dataDir = resolveDataDir();
    const state = () => {
      const { rules, warnings } = discoverRules({ workspace: meta.workspace, dataDir });
      return {
        rules, warnings,
        toggles: loadConfig().rules?.toggles || {},
        paths: ruleCandidatePaths({ input: '', records: store.records(meta.id) }),
      };
    };
    const s = state();
    if (parsed.action === 'list') {
      for (const line of formatRuleLines(s)) console.log('  ' + p.dim(line));
      return;
    }
    if (!s.rules.some((r) => r.name === parsed.name)) {
      console.log(p.warning(`没有名为「${parsed.name}」的规则（可用：${s.rules.map((r) => r.name).join('、') || '无'}）`));
      return;
    }
    cfg.rules = { toggles: { ...s.toggles, [parsed.name]: parsed.action === 'on' } };
    saveConfig(cfg);
    for (const line of formatRuleToggleLines(parsed.action, parsed.name, s)) console.log('  ' + p.dim(line));
  };

  /** 声明式斜杠命令表：/help 与分发同源；技能派生命令追加进同一张表（/<技能名> 直接调用） */
  const baseCommands = [
    { name: 'help', summary: '显示全部命令', run: printHelp },
    { name: 'new', summary: '新建会话（携带当前模型与模式）', run: () => {
      const created = store.create({
        model: meta.model, provider: meta.provider, harness: meta.harness, planMode: meta.planMode === true,
        titleMode: TITLE_MODES.includes(meta.titleMode) ? meta.titleMode : cfg.titleMode,
      });
      meta = created;
      applyTitle();
      console.log(painter().dim(`✓ 新会话已创建：${created.name}`));
    } },
    { name: 'sessions', argHint: '[序号]', summary: '列出 / 切换会话（无参数弹出选择器）', run: cmdSessions },
    { name: 'model', argHint: '<名称>', summary: '显示 / 切换模型', run: (arg) => {
      if (!arg) { console.log(painter().dim(`当前模型: ${meta.model || cfg.model}`)); return; }
      if (!MODEL_RE.test(arg)) { console.log(painter().warning('模型 ID 含非法字符（仅限字母数字与 . _ : -，最长 80）')); return; }
      const p = providers.providerForModel(arg);
      meta = store.patch(meta.id, { model: arg, provider: p.id }) || meta;
      console.log(painter().dim(`✓ 已切换到 ${arg}（提供方 ${p.name}）`));
    } },
    { name: 'harness', argHint: '<模式>', summary: '切换模式（无参数弹出选择器）', run: cmdHarness },
    { name: 'theme', argHint: '<dark|light|auto>', summary: '切换终端主题（无参数弹出选择器）', run: cmdTheme },
    { name: 'mcp', summary: 'MCP 服务器与工具状态（实验特性）', run: () => {
      if (!mcp) { console.log(painter().dim('MCP 未开启：设置 AURORAAGENT_EXPERIMENTAL_MCP=1 后重启')); return; }
      const rows = mcp.status();
      if (!rows.length) { console.log(painter().dim('尚未配置 MCP 服务器（数据目录 mcp.json）')); return; }
      for (const s of rows) {
        const state = s.enabled === false ? painter().dim('已停用') : s.connected ? painter().success(`已连接 · ${s.tools} 个工具`) : painter().error(`连接失败：${s.error || '未知原因'}`);
        console.log(`  ${painter().text(s.name || s.id)} ${painter().dim(`(${s.transport})`)} ${state}`);
      }
      console.log(painter().dim(`  可用 MCP 工具 ${mcp.tools.length} 个：${mcp.tools.map((t) => t.name).join('、') || '（无）'}`));
    } },
    { name: 'title', argHint: '<local|model>', summary: '会话标题生成方式（local 本地推导零成本 / model 调模型总结）', run: (arg) => {
      const want = String(arg || '').trim();
      if (!want) {
        console.log(painter().dim(`当前标题生成方式: ${meta.titleMode === 'model' ? '模型总结（每个新会话多一次小额请求）' : '本地推导（零成本）'}`));
        return;
      }
      if (!TITLE_MODES.includes(want)) { console.log(painter().warning('用法: /title local|model（local 本地推导，model 调模型总结）')); return; }
      meta = store.patch(meta.id, { titleMode: want }) || meta;
      console.log(painter().dim(`✓ 标题生成方式已切换为${want === 'model' ? '模型总结（每个新会话多一次小额请求）' : '本地推导（零成本）'}`));
    } },
    { name: 'goal', argHint: '<目标内容>|[pause|resume|stop|budget <n>|clear|edit|help]', summary: '会话目标（无参查看；/<目标内容> 设立或改写；edit 回填续编）', run: cmdGoal },
    { name: 'queue', argHint: '[send|drop <序号>|clear]', summary: '消息队列：生成中提交的消息在此排队（无参列出，send 立即发送，drop 移除）', run: cmdQueue },
    { name: 'cron', argHint: '[add <名称> | <表达式> | <内容>|remove|run|on|off <id>]', summary: '定时任务：到期自动在当前会话跑一轮 Agent（无参列出）', run: cmdCron },
    { name: 'hooks', argHint: '[list|events|test <事件名>]', summary: '事件钩子：脚本在 turn 各阶段自动触发（实验特性，无参列出）', run: cmdHooks },
    { name: 'checkpoint', argHint: '[list|diff <轮次>|restore <轮次> [chat]|clean]', summary: '检查点：每轮开始时自动拍工作区快照，可整体回滚（无参列出）', run: cmdCheckpoint },
    { name: 'rules', argHint: '[list|on <名称>|off <名称>]', summary: '规则：AGENTS.md 等项目约定按条件注入系统提示（无参列出）', run: cmdRules },
    { name: 'btw', argHint: '<问题>', summary: '侧边对话：继承当前会话历史开聊，不落盘不进会话列表；Ctrl+/ 切换、Ctrl+C 丢弃', run: async (arg) => {
      const q = String(arg || '').trim();
      if (!q) { console.log(painter().warning('用法: /btw <问题>（侧边对话，继承当前会话历史，不落盘）')); return; }
      if (!btw) btw = new SideSession(meta, { prefix: store.records(meta.id) });
      btwMode = true;
      busy = true;
      applyTitle();
      await runTurn(q, true); // await：busy 期间 Ctrl+C 走中断而非丢弃
      busy = false;
      applyTitle();
    } },
    { name: 'plan', argHint: 'on|off', summary: '计划模式开关（默认关；开启后下一轮先出计划，批准才执行）', run: (arg) => {
      const on = arg !== 'off';
      meta = store.patch(meta.id, { planMode: on }) || meta;
      console.log(painter().dim(`✓ 计划模式已${on ? '开启（下一轮先出计划，y 批准后执行）' : '关闭'}`));
    } },
    { name: 'think', argHint: 'on|off', summary: '思考过程开关（默认开）', run: (arg) => {
      cfg.thinking = arg !== 'off';
      console.log(painter().dim(`✓ 思考已${cfg.thinking ? '开启' : '关闭'}`));
    } },
    { name: 'temp', argHint: '<0~1>', summary: '设置温度', run: (arg) => {
      const v = Number(arg);
      if (Number.isNaN(v) || v < 0 || v > 1) { console.log(painter().warning('温度需在 0 ~ 1 之间')); return; }
      cfg.temperature = v;
      console.log(painter().dim(`✓ 温度 = ${v}`));
    } },
    { name: 'max', argHint: '<数量>', summary: '设置单次最大输出 tokens', run: (arg) => {
      const v = Number(arg);
      if (!Number.isInteger(v) || v <= 0) { console.log(painter().warning('max 需为正整数')); return; }
      cfg.maxTokens = v;
      console.log(painter().dim(`✓ 最大输出 = ${v} tokens`));
    } },
    { name: 'key', argHint: '<ak-xxx>', summary: '更新 API Key', run: (arg) => {
      if (!arg) { console.log(painter().warning('用法: /key ak-xxx')); return; }
      cfg.apiKey = arg;
      cfg.keyIsOverride = false;
      console.log(painter().dim('✓ Key 已更新并保存'));
    } },
    { name: 'quit', aliases: ['exit'], summary: '退出', run: () => { quitting = true; rl.close(); } },
  ];
  const skillCommands = skills.map((s) => ({
    name: s.name,
    summary: `[技能] ${s.description}`,
    run: async (arg) => { await runTurn(skillInvocationText(s, arg), false, s.name); },
  }));
  const commands = defineCommands([...baseCommands, ...skillCommands]);

  const footerState = () => ({
    model: meta.model || cfg.model,
    harness: getHarness(meta.harness).label,
    thinking: cfg.thinking,
    permissionMode: cfg.permissionMode,
    planMode: meta.planMode === true,
    titleMode: TITLE_MODES.includes(meta.titleMode) ? meta.titleMode : cfg.titleMode,
    tokens: foot.tokens,
    cost: foot.cost,
    goal: (() => { const g = goals.get(meta.id); return g && g.status === 'active' ? goalUsageChip(g) : null; })(),
    // 消息队列（#3212）：生成中提交的消息在服务端排队，footer 报个数即可（/queue 看明细）
    queue: lineQueue.length,
    busy,
  });

  // side=true 跑侧边对话：内存门面 store、不接管 goal、用量仍记真实账本
  const runTurn = (input, side = false, skill = '') => {
    const target = side ? btw.meta : meta;
    return runTerminalTurn({
      extraTools: mcp ? mcp.tools : [],
      goalStore: side ? null : goals,
      store: side ? btw : store,
      usage, session: target, input, inputSkill: skill, skills,
      provider: providers.get(target.provider) || providers.providerForModel(target.model || cfg.model),
      model: target.model || cfg.model,
      harness: getHarness(target.harness),
      cfg, painter: painter(), ask, hooks, notifier,
      // 故障转移与网页同源：候选=全部提供方（同模型 / 有 Key 过滤在 llm/failover.mjs）
      failoverCandidates: () => providers.all(),
      providerFailover: cfg.providerFailover, providerFailoverMaxAttempts: cfg.providerFailoverMaxAttempts,
      failoverState, failoverTimeouts: failoverTimeouts(), failoverQueue: () => providers.failoverQueueIds(),
      onUsage: (u) => { foot.tokens = (u.inputTokens || 0) + (u.outputTokens || 0); foot.cost = u.cost; },
      onSession: (m) => { if (side) btw.meta = m; else meta = m; },
    });
  };

  /** 提示符重绘：异步输出（Ctrl+/ 切换等）后把提示符与已键入内容拉回新行 */
  const redrawPrompt = () => {
    if (!process.stdin.isTTY) return;
    rl.setPrompt(painter().roleUser(btwMode ? '侧 › ' : '你 › '));
    rl.prompt(true);
  };

  /** 丢弃侧边对话回到主对话（Ctrl+C 空输入触发） */
  const discardBtw = () => {
    btw = null;
    btwMode = false;
    console.log(painter().dim('  (侧边对话已丢弃，回到主对话)'));
    applyTitle();
    redrawPrompt();
  };

  // Ctrl+/ 切换：没有侧边对话时给提示不开切换
  ctrlSlash.handler = () => {
    if (!btw) {
      console.log(painter().dim('  (还没有侧边对话：/btw <问题> 开一个，继承当前会话历史，不落盘)'));
      redrawPrompt();
      return;
    }
    btwMode = !btwMode;
    applyTitle();
    console.log(painter().dim(`  (切换到${btwMode ? '侧边' : '主'}对话${btwMode ? `，已继承 ${btw.items.length} 条历史前缀` : ''})`));
    redrawPrompt();
  };

  if (oneShot) {
    busy = true;
    applyTitle();
    await runTurn(oneShot);
    cleanExit();
  }

  printBanner();
  applyTitle();
  if (meta.turns > 0) { console.log(painter().dim('  最近几行:')); printRecap(meta); console.log(''); }

  for (;;) {
    const p = painter();
    process.stdout.write(renderFooter(footerState(), p, process.stdout.columns || 80) + '\n');
    if (process.stdin.isTTY) { rl.setPrompt(p.roleUser(btwMode ? '侧 › ' : '你 › ')); rl.prompt(); }
    const line = (await ask()).trim();
    if (!line) continue;
    const parsed = parseCommand(line);
    if (parsed) {
      const def = commands.get(parsed.name);
      if (!def) console.log(painter().warning(`未知命令 /${parsed.name}，输入 /help 查看帮助`));
      else await def.run(parsed.arg);
      if (quitting) return;
      saveConfig(cfg);
      continue;
    }
    busy = true;
    applyTitle();
    await runTurn(line, btwMode && Boolean(btw));
    busy = false;
    applyTitle();
    if (wantExit && !lineQueue.length) cleanExit();
  }
}
