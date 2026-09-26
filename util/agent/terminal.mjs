/**
 * AuroraAgent 终端 REPL 协调器（零依赖）：readline REPL + 声明式斜杠命令 + TUI 组件。
 * 流式渲染下沉 terminal-turn.mjs，纯助手在 terminal-format.mjs；对话框 / footer / 键位
 * 规范见 docs/tui-design.md，工具包见 util/tui/。颜色一律 painter（theme.mjs 单一真值源）。
 * 与网页共用同一套 Agent Loop（loop.mjs）与会话 / 账本数据目录，两端可交替使用。
 */
import { createInterface } from 'node:readline';
import { SessionStore } from './session.mjs';
import { UsageLedger } from '../usage.mjs';
import { ProviderStore } from '../providers.mjs';
import { HARNESSES, getHarness } from './harness.mjs';
import { loadConfig, saveConfig, PRICE, resolveDataDir } from '../config.mjs';
import { defineCommands, commandHelpLines, parseCommand } from '../tui/commands.mjs';
import { renderFooter } from '../tui/footer.mjs';
import { paletteFor, createPainter } from '../tui/theme.mjs';
import { SearchableList } from '../tui/searchable-list.mjs';
import { pick } from '../tui/pick.mjs';
import { runTerminalTurn } from './terminal-turn.mjs';
import { loadSkills, skillInvocationText } from './skills.mjs';
import { join } from 'node:path';
import { truncate, toolLabel } from './terminal-format.mjs';

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
  const usage = new UsageLedger(dataDir);
  const providers = new ProviderStore(dataDir, {
    baseUrl: BASE, pathPrefix: '/openai/v1', apiKey: () => cfg.apiKey, model: () => cfg.model,
  }, () => []);

  let meta = store.list()[0] || store.create({
    model: cfg.model, provider: providers.providerForModel(cfg.model).id, harness: 'standard',
  });

  // 主题：环境变量 AURORAAGENT_THEME 或会话内 /theme 切换；painter 每帧从当前色板新建
  let themeChoice = process.env.AURORAAGENT_THEME || 'auto';
  const painter = () => createPainter(paletteFor(themeChoice).colors);
  const foot = { tokens: null, cost: null }; // footer 展示的最近一次用量

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  const hooks = {}; // turn 运行期挂 abort；rl 的 SIGINT 事件中转进来（raw mode 下无真信号）
  rl.on('SIGINT', () => {
    if (hooks.abort) hooks.abort(); // 生成中：中断并保留已生成内容
    else rl.close(); // 空提示符：退出（与无监听时的 readline 默认行为一致）
  });
  let busy = false;
  let wantExit = false;
  let quitting = false;
  const lineQueue = [];
  let lineWaiter = null;
  rl.on('line', (raw) => {
    const line = raw.trim();
    if (lineWaiter) { const w = lineWaiter; lineWaiter = null; w(line); }
    else lineQueue.push(line);
  });
  rl.on('close', () => { if (!busy && !lineQueue.length) process.exit(0); wantExit = true; });
  const ask = () => {
    if (lineQueue.length) return Promise.resolve(lineQueue.shift());
    if (wantExit) process.exit(0);
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

  /** 声明式斜杠命令表：/help 与分发同源；技能派生命令追加进同一张表（/<技能名> 直接调用） */
  const baseCommands = [
    { name: 'help', summary: '显示全部命令', run: printHelp },
    { name: 'new', summary: '新建会话（携带当前模型与模式）', run: () => {
      const created = store.create({ model: meta.model, provider: meta.provider, harness: meta.harness, planMode: meta.planMode === true });
      meta = created;
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
    run: async (arg) => { await runTurn(skillInvocationText(s, arg)); },
  }));
  const commands = defineCommands([...baseCommands, ...skillCommands]);

  const footerState = () => ({
    model: meta.model || cfg.model,
    harness: getHarness(meta.harness).label,
    thinking: cfg.thinking,
    permissionMode: cfg.permissionMode,
    planMode: meta.planMode === true,
    tokens: foot.tokens,
    cost: foot.cost,
  });

  const runTurn = (input) => runTerminalTurn({
    store, usage, session: meta, input, skills,
    provider: providers.get(meta.provider) || providers.providerForModel(meta.model || cfg.model),
    model: meta.model || cfg.model,
    harness: getHarness(meta.harness),
    cfg, painter: painter(), ask, hooks,
    onUsage: (u) => { foot.tokens = (u.inputTokens || 0) + (u.outputTokens || 0); foot.cost = u.cost; },
    onSession: (m) => { meta = m; },
  });

  if (oneShot) {
    busy = true;
    await runTurn(oneShot);
    process.exit(0);
  }

  printBanner();
  if (meta.turns > 0) { console.log(painter().dim('  最近几行:')); printRecap(meta); console.log(''); }

  for (;;) {
    const p = painter();
    process.stdout.write(renderFooter(footerState(), p, process.stdout.columns || 80) + '\n');
    if (process.stdin.isTTY) { rl.setPrompt(p.roleUser('你 › ')); rl.prompt(); }
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
    await runTurn(line);
    busy = false;
    if (wantExit && !lineQueue.length) process.exit(0);
  }
}
