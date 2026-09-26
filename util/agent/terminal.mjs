/**
 * AuroraAgent 终端 REPL：与网页共用的 Agent Loop（loop.mjs）驱动，零依赖。
 * 思考过程暗色流式 / 工具调用单行状态（✓ ✗）/ 权限 readline 确认（y / n / a）；
 * 命令：/new /sessions /model /harness /think /temp /max /key /help /quit。
 * 数据（会话 / 提供方 / 用量账本）与网页完全同目录，两端可交替使用。
 */
import { createInterface } from 'node:readline';
import { SessionStore } from './session.mjs';
import { UsageLedger } from '../usage.mjs';
import { ProviderStore } from '../providers.mjs';
import { getHarness } from './harness.mjs';
import { runAgentTurn } from './loop.mjs';
import { loadConfig, saveConfig, PRICE, resolveDataDir } from '../config.mjs';

const BASE = process.env.AURORAAGENT_BASE_URL || 'https://api.longcat.chat';
const KEY_PAGE = 'https://longcat.chat/platform/api_keys';
const CLEAR = '\r\x1b[K';
const MODEL_RE = /^[A-Za-z0-9._:-]{1,80}$/;

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  magenta: '\x1b[35m', red: '\x1b[31m',
};
const paint = (color, s) => `${c[color]}${s}${c.reset}`;
const dim = (s) => `${c.dim}${s}${c.reset}`;
const thinkColor = (s) => `${c.dim}${c.cyan}${s}${c.reset}`;

const TOOL_LABELS = {
  read_file: '读取文件', list_dir: '浏览目录', write_file: '写入文件',
  edit_file: '编辑文件', shell: '执行命令', web_fetch: '抓取网页',
};
const toolLabel = (name) => TOOL_LABELS[name] || name;
const truncate = (s, n) => (String(s || '').length > n ? `${String(s).slice(0, n)}…` : String(s || ''));
const fmtCost = (cost) => (cost < 0.01 ? cost.toFixed(6) : cost.toFixed(4));

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
    console.log(paint('yellow', '[!] 还未配置 API Key'));
    console.log(`  1. 打开 ${KEY_PAGE} 注册/登录并创建 Key`);
    console.log('  2. 回来执行下面的命令之一:');
    console.log(`     ${paint('cyan', 'export AURORAAGENT_API_KEY="ak-你的Key"')} 然后 node chat.mjs`);
    console.log(`     或在对话中输入 ${paint('cyan', '/key ak-你的Key')}`);
    if (!oneShot) process.exit(1);
  }

  const dataDir = resolveDataDir();
  const store = new SessionStore(dataDir);
  const usage = new UsageLedger(dataDir);
  const providers = new ProviderStore(dataDir, {
    baseUrl: BASE, pathPrefix: '/openai/v1', apiKey: () => cfg.apiKey, model: () => cfg.model,
  }, () => []);

  let meta = store.list()[0] || store.create({
    model: cfg.model, provider: providers.providerForModel(cfg.model).id, harness: 'standard',
  });

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  let busy = false;
  let wantExit = false;
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
      if (r.t === 'user') console.log(dim('  你 › ') + truncate(r.text, 90));
      else if (r.t === 'assistant') console.log(dim('  AI › ') + truncate(r.text, 90));
      else if (r.t === 'tool_call') console.log(dim(`  · ${toolLabel(r.name)}`));
      else if (r.t === 'summary') console.log(dim('  · 早期对话已折叠为摘要'));
    }
    if (records.length > 6) console.log(dim(`  …共 ${records.length} 条记录`));
  };

  const printBanner = () => {
    const harness = getHarness(meta.harness);
    console.log(paint('magenta', '  AuroraAgent · 终端 Agent'));
    console.log(dim(`  模型 ${meta.model || cfg.model} · 模式 ${harness.label} · 思考 ${cfg.thinking ? '开' : '关'} · 温度 ${cfg.temperature} · 上限 ${cfg.maxTokens} tokens`));
    console.log(dim(`  会话 ${meta.name}（${meta.turns} 轮）· 工作目录 ${meta.workspace}`));
    console.log(dim('  命令: /help 查看全部 · 生成中 Ctrl+C 可中断并保留已生成内容 · 工具执行前会询问授权'));
    console.log(dim(`  Key 获取: ${KEY_PAGE}\n`));
  };

  const printHelp = () => {
    console.log(`
${paint('bold', '可用命令')}
  /help              显示本帮助
  /new               新建会话（携带当前模型与模式）
  /sessions          列出会话；/sessions <序号> 切换
  /model <名称>      切换模型（影响后续轮次）
  /harness <模式>    切换模式: minimal / standard / ultimate
  /think on|off      思考过程开关（默认开）
  /temp <0~1>        设置温度
  /max <数量>        设置单次最大输出 tokens
  /key <ak-xxx>      更新 API Key
  /quit              退出
`.trim());
  };

  /** 跑一个 turn：loop.mjs 驱动，事件映射为终端渲染 */
  async function turn(input) {
    const model = meta.model || cfg.model;
    const provider = providers.get(meta.provider) || providers.providerForModel(model);
    const harness = getHarness(meta.harness);
    const started = Date.now();
    let phase = 'idle'; // idle -> think -> text
    let atLineStart = true;
    let toolLineOpen = false;
    const rejectedTools = new Set(); // loop 对拒绝会补发 failed，这里去重并按拒绝呈现
    let controller = null;
    let aborted = false;
    let pendingPerm = null;

    const write = (s) => { process.stdout.write(s); atLineStart = s.endsWith('\n'); };
    const breakLine = () => { if (!atLineStart) { write('\n'); } };
    const endToolLine = () => { if (toolLineOpen) { write(CLEAR); toolLineOpen = false; } };

    const onSigint = () => {
      aborted = true;
      controller?.abort();
      // 权限询问期间中断：按拒绝放行，让循环收尾成 turn_cancelled
      if (pendingPerm) pendingPerm('n');
    };
    process.on('SIGINT', onSigint);

    const emit = (type, p) => {
      switch (type) {
        case 'model_round_started':
          endToolLine();
          breakLine();
          phase = 'idle'; // 新一轮：思考与正文各自带标题，不与上一轮连篇
          break;
        case 'thinking_chunk':
          endToolLine();
          if (phase !== 'think') { breakLine(); write(`\n${dim('思考 ')}`); phase = 'think'; }
          write(thinkColor(p.text));
          break;
        case 'text_chunk':
          endToolLine();
          if (phase !== 'text') {
            breakLine();
            if (phase === 'think') write(`\n${dim('─'.repeat(46))}\n`);
            phase = 'text';
          }
          write(p.text);
          break;
        case 'tool_event': {
          endToolLine();
          const label = toolLabel(p.toolName);
          const res = p.resource || (p.params && (p.params.path || p.params.url || p.params.command || p.params.dir)) || '';
          if (p.phase === 'started') {
            breakLine();
            write(`  ${dim('…')} ${label}${res ? ` ${dim(String(res))}` : ''}`);
            toolLineOpen = true;
          } else if (p.phase === 'confirmation_needed') {
            toolLineOpen = false; // 行已由 endToolLine 清掉，转为权限询问
          } else if (p.phase === 'confirmed') {
            write(`  ${dim('…')} ${label}${res ? ` ${dim(String(res))}` : ''}`);
            toolLineOpen = true;
          } else if (p.phase === 'completed') {
            write(`  ${paint('green', '✓')} ${label}${res ? ` ${res}` : ''}${p.durationMs != null ? dim(` ${p.durationMs}ms`) : ''}\n`);
            if (p.output) { breakLine(); write(dim(indent(p.output, 220)) + '\n'); }
          } else if (p.phase === 'failed') {
            const denied = rejectedTools.has(p.toolId);
            write(`  ${paint('red', '✗')} ${label}${res ? ` ${res}` : ''}${denied ? dim(' 已拒绝') : ''}\n`);
            if (p.output && !denied) { breakLine(); write(dim(indent(p.output, 220)) + '\n'); }
          } else if (p.phase === 'rejected') {
            rejectedTools.add(p.toolId); // 行不在此处打印：随后到的 failed 负责收尾
          }
          break;
        }
        case 'token_usage_updated':
          endToolLine();
          breakLine();
          write(dim(`  ↳ tokens 输入 ${p.inputTokens} · 输出 ${p.outputTokens} · 约 ¥${fmtCost(p.cost)}\n`));
          break;
        case 'context_compression_started':
          endToolLine();
          breakLine();
          write(dim('  ↳ 上下文超限，正在折叠早期对话…\n'));
          break;
        case 'context_compression_completed':
          endToolLine();
          breakLine();
          write(dim(`  ↳ 已折叠，保留近期 ${p.keptRecords} 条记录\n`));
          break;
        case 'context_compression_failed':
          endToolLine();
          breakLine();
          write(dim(`  ↳ 折叠失败，沿用原上下文：${p.error}\n`));
          break;
        case 'turn_cancelled':
          endToolLine();
          breakLine();
          write(dim('  (已中断，以上为部分输出，仍保留在会话中)\n'));
          break;
        case 'turn_failed':
          endToolLine();
          breakLine();
          write(`${paint('red', '✗')} ${p.error}\n`);
          break;
        case 'turn_completed':
          endToolLine();
          breakLine();
          write(dim(`  ↳ ${p.totalRounds} 轮 · ${p.totalTools} 个工具 · ${((Date.now() - started) / 1000).toFixed(1)}s\n`));
          break;
      }
    };

    const turnController = new AbortController();
    controller = turnController;
    process.stdout.write(`\n${paint('green', 'AuroraAgent')} ${dim('›')} `);
    phase = 'idle';
    try {
      await runAgentTurn({
        store, usage, session: meta, input, provider, model, harness, builtinPrice: PRICE,
        gen: { maxTokens: cfg.maxTokens, temperature: cfg.temperature, thinkingOn: cfg.thinking },
        emit, controller: turnController,
        // 权限询问与主输入共用同一条 line 通道（ask()），避免 readline 双消费；
        // 中断（Ctrl+C）时按拒绝放行，让循环收尾成 turn_cancelled
        requestPermission: ({ toolName, params, resource }) => new Promise((resolve) => {
          const res = resource || (params && (params.path || params.url || params.command || params.dir)) || '';
          write(`${paint('yellow', '  需要授权')} ${toolLabel(toolName)}${res ? ` ${res}` : ''}\n  [y]允许 [a]总是允许 [n]拒绝 › `);
          pendingPerm = (line) => {
            pendingPerm = null;
            atLineStart = true; // readline 已回显换行
            const a = String(line).trim().toLowerCase();
            resolve(a === 'a' || a === 'always' ? 'always' : a === 'n' || a === 'no' || a === '' ? 'deny' : 'allow');
          };
          ask().then((line) => { if (pendingPerm) pendingPerm(line); });
        }),
        log: () => {},
      });
    } finally {
      process.removeListener('SIGINT', onSigint);
      endToolLine();
      breakLine();
      meta = store.get(meta.id)?.meta || meta;
    }
    return aborted;
  }

  if (oneShot) {
    busy = true;
    await turn(oneShot);
    process.exit(0);
  }

  printBanner();
  if (meta.turns > 0) { console.log(dim('  最近几行:')); printRecap(meta); console.log(''); }

  for (;;) {
    if (process.stdin.isTTY) rl.setPrompt(paint('cyan', '你 › ')), rl.prompt();
    const line = (await ask()).trim();
    if (!line) continue;
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ').trim();
      switch (cmd) {
        case 'quit': case 'exit': rl.close(); return;
        case 'help': printHelp(); break;
        case 'new': {
          const created = store.create({ model: meta.model, provider: meta.provider, harness: meta.harness });
          meta = created;
          console.log(dim(`✓ 新会话已创建：${created.name}`));
          break;
        }
        case 'sessions': {
          if (!arg) {
            const list = store.list();
            list.forEach((m, i) => {
              const mark = m.id === meta.id ? paint('green', '→') : ' ';
              console.log(`  ${mark} ${i + 1}. ${m.name} ${dim(`· ${getHarness(m.harness).label} · ${m.turns} 轮 · ${m.updatedAt.slice(5, 16).replace('T', ' ')}`)}`);
            });
            if (!list.length) console.log(dim('  (没有会话)'));
            break;
          }
          const idx = Number(arg) - 1;
          const list = store.list();
          if (!Number.isInteger(idx) || idx < 0 || idx >= list.length) {
            console.log(paint('yellow', `用法: /sessions <1-${list.length || 1}>`));
            break;
          }
          meta = list[idx];
          console.log(dim(`✓ 已切换到：${meta.name}`));
          if (meta.turns > 0) printRecap(meta);
          break;
        }
        case 'model': {
          if (!arg) { console.log(dim(`当前模型: ${meta.model || cfg.model}`)); break; }
          if (!MODEL_RE.test(arg)) { console.log(paint('yellow', '模型 ID 含非法字符（仅限字母数字与 . _ : -，最长 80）')); break; }
          const p = providers.providerForModel(arg);
          meta = store.patch(meta.id, { model: arg, provider: p.id }) || meta;
          console.log(dim(`✓ 已切换到 ${arg}（提供方 ${p.name}）`));
          break;
        }
        case 'harness': {
          if (!arg) { console.log(dim(`当前模式: ${getHarness(meta.harness).label}（${meta.harness}）`)); break; }
          const h = getHarness(arg);
          if (h.id !== arg) { console.log(paint('yellow', `未知模式: ${arg}（可用 minimal / standard / ultimate）`)); break; }
          meta = store.patch(meta.id, { harness: h.id }) || meta;
          console.log(dim(`✓ 已切换到 ${h.label} 模式`));
          break;
        }
        case 'think':
          cfg.thinking = arg !== 'off';
          console.log(dim(`✓ 思考已${cfg.thinking ? '开启' : '关闭'}`));
          break;
        case 'temp': {
          const v = Number(arg);
          if (Number.isNaN(v) || v < 0 || v > 1) { console.log(paint('yellow', '温度需在 0 ~ 1 之间')); break; }
          cfg.temperature = v;
          console.log(dim(`✓ 温度 = ${v}`));
          break;
        }
        case 'max': {
          const v = Number(arg);
          if (!Number.isInteger(v) || v <= 0) { console.log(paint('yellow', 'max 需为正整数')); break; }
          cfg.maxTokens = v;
          console.log(dim(`✓ 最大输出 = ${v} tokens`));
          break;
        }
        case 'key':
          if (!arg) { console.log(paint('yellow', '用法: /key ak-xxx')); break; }
          cfg.apiKey = arg;
          cfg.keyIsOverride = false;
          console.log(dim('✓ Key 已更新并保存'));
          break;
        default:
          console.log(paint('yellow', `未知命令 /${cmd}，输入 /help 查看帮助`));
      }
      saveConfig(cfg);
      continue;
    }
    busy = true;
    await turn(line);
    busy = false;
    if (wantExit && !lineQueue.length) process.exit(0);
  }
}

/** 工具输出缩进预览：截断 + 每行前缀 */
function indent(text, limit) {
  const lines = String(text || '').split('\n');
  const shown = lines.length > 8 ? [...lines.slice(0, 8), `…（共 ${lines.length} 行）`] : lines;
  return shown.map((l) => `    ${truncate(l, limit)}`).join('\n');
}
