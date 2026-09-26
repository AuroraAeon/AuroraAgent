#!/usr/bin/env node
/**
 * ModelTester 终端聊天客户端（零依赖，Node 18+）· 当前接入：LongCat-2.5-Preview
 * 用法:
 *   node chat.mjs              # 交互式聊天
 *   node chat.mjs -p "问题"     # 单次提问
 *   node chat.mjs --key sk-xxx  # 临时指定 Key（不覆盖配置）
 * API Key 获取: https://longcat.chat/platform/api_keys
 */
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SseParser, estimateTokens } from './util/sse.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
// 数据目录三级回退：env → 本地已有 config 用当前目录（源码态）→ ~/Library/Application Support/ModelTester（App 态）
function resolveDataDir() {
  if (process.env.MODELTESTER_DATA_DIR) return process.env.MODELTESTER_DATA_DIR;
  if (existsSync(join(__dirname, 'modeltester.config.json'))) return __dirname;
  return join(homedir(), 'Library', 'Application Support', 'ModelTester');
}
const CONFIG_PATH = join(resolveDataDir(), 'modeltester.config.json');
const BASE = process.env.MODELTESTER_BASE_URL || 'https://api.longcat.chat';
const KEY_PAGE = 'https://longcat.chat/platform/api_keys';

// 限时折扣价: 输入 ¥2 / 输出 ¥8 每百万 tokens
export const PRICE = { input: 2, output: 8 };
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CLEAR = '\r\x1b[K';

const c = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m',
  magenta: '\x1b[35m', red: '\x1b[31m',
};
const paint = (color, s) => `${c[color]}${s}${c.reset}`;
const dim = (s) => `${c.dim}${s}${c.reset}`;
const thinkColor = (s) => `${c.dim}${c.cyan}${s}${c.reset}`;

export function loadConfig() {
  let saved = {};
  let fileExists = false;
  try { saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); fileExists = true; } catch {}
  const overrideKey = process.env.MODELTESTER_API_KEY || '';
  return {
    apiKey: overrideKey || saved.apiKey || '',
    // 环境变量 Key 只是临时覆盖: 配置文件已有 Key 时绝不写回文件
    keyIsOverride: Boolean(overrideKey) && fileExists && Boolean(saved.apiKey),
    model: saved.model || 'LongCat-2.5-Preview',
    thinking: saved.thinking !== false,
    temperature: saved.temperature ?? 0.7,
    maxTokens: saved.maxTokens ?? 32768,
  };
}

function saveConfig(cfg) {
  const out = {
    model: cfg.model, thinking: cfg.thinking,
    temperature: cfg.temperature, maxTokens: cfg.maxTokens,
  };
  if (!cfg.keyIsOverride) out.apiKey = cfg.apiKey;
  writeFileSync(CONFIG_PATH, JSON.stringify(out, null, 2) + '\n');
}

/** 流式请求。on: { think, text, status }；返回 { usage, aborted } */
export async function streamChat(cfg, messages, on) {
  const controller = new AbortController();
  on.signal?.(controller);
  const resp = await fetch(`${BASE}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      max_tokens: cfg.maxTokens,
      temperature: cfg.temperature,
      thinking: { type: cfg.thinking ? 'enabled' : 'disabled' },
    }),
    signal: controller.signal,
  });
  if (!resp.ok) {
    let msg = await resp.text();
    try { msg = JSON.parse(msg).error?.message || msg; } catch {}
    const hint = resp.status === 401
      ? `\nAPI Key 无效或未填写。请访问 ${KEY_PAGE} 获取，然后用 /key <你的Key> 或设置环境变量 MODELTESTER_API_KEY。`
      : resp.status === 402
        ? '\n账号额度已用尽: ① longcat.chat/platform 充值 ② Token资源包每日 10:00/16:00/21:00/23:00 抢购 ③ 邀请好友领奖励'
        : resp.status === 429 ? '\n请求太频繁，稍后再试。' : '';
    throw new Error(`HTTP ${resp.status}: ${msg}${hint}`);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  let usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const ev of parser.feed(decoder.decode(value, { stream: true }))) {
      if (ev.data === '[DONE]') continue;
      try {
        const j = JSON.parse(ev.data);
        if (j.usage) usage = j.usage;
        const d = j.choices?.[0]?.delta;
        if (d?.reasoning_content) on.think?.(d.reasoning_content);
        if (d?.content) on.text?.(d.content);
      } catch {}
    }
  }
  for (const ev of parser.end()) {
    if (ev.data === '[DONE]') continue;
    try {
      const j = JSON.parse(ev.data);
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta;
      if (d?.reasoning_content) on.think?.(d.reasoning_content);
      if (d?.content) on.text?.(d.content);
    } catch {}
  }
  return { usage };
}

function fmtUsage(usage, ms, est) {
  const inTok = usage?.prompt_tokens;
  const outTok = usage?.completion_tokens;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  const cost = ((inTok ?? 0) * PRICE.input + (outTok ?? 0) * PRICE.output) / 1_000_000;
  const secs = ms / 1000;
  const tps = outTok && secs > 0.2 ? ` · ${(outTok / secs).toFixed(1)} tok/s` : '';
  const parts = [
    `${secs.toFixed(1)}s`,
    `输入 ${inTok ?? '~' + est.in}`,
    reasoning ? `思考 ${reasoning}` : null,
    `输出 ${outTok ?? '~' + est.out}`,
    tps || null,
    `约 ¥${cost.toFixed(4)}`,
  ].filter(Boolean);
  return dim(`  ↳ ${parts.join(' · ')}`);
}

function printBanner(cfg) {
  console.log(paint('magenta', '  ModelTester · 终端聊天'));
  console.log(dim(`  模型 ${cfg.model} · 思考 ${cfg.thinking ? '开' : '关'} · 温度 ${cfg.temperature} · 上限 ${cfg.maxTokens} tokens`));
  console.log(dim('  命令: /help 查看全部 · 生成中 Ctrl+C 可中断并保留已生成内容'));
  console.log(dim(`  Key 获取: ${KEY_PAGE}\n`));
}

function printHelp() {
  console.log(`
${paint('bold', '可用命令')}
  /help            显示本帮助
  /clear           清空对话上下文
  /think on|off    思考过程开关（默认开）
  /model <名称>    切换模型: LongCat-2.5-Preview / LongCat-2.0
  /temp <0~1>      设置温度
  /max <数量>      设置单次最大输出 tokens
  /img <图片路径>   附带图片（多模态），如下一行输入问题
  /key <ak-xxx>    更新 API Key
  /quit            退出
`.trim());
}

async function main() {
  const cfg = loadConfig();
  const keyIdx = process.argv.indexOf('--key');
  if (keyIdx >= 0 && process.argv[keyIdx + 1]) {
    cfg.apiKey = process.argv[keyIdx + 1];
    if (!cfg.keyIsOverride && process.env.MODELTESTER_API_KEY) cfg.keyIsOverride = true;
  }
  const oneShotIdx = process.argv.indexOf('-p');
  const oneShot = oneShotIdx >= 0 ? process.argv[oneShotIdx + 1] : null;

  if (!cfg.apiKey) {
    console.log(paint('yellow', '[!] 还未配置 API Key'));
    console.log(`  1. 打开 ${KEY_PAGE} 注册/登录并创建 Key`);
    console.log('  2. 回来执行下面的命令之一:');
    console.log(`     ${paint('cyan', 'export MODELTESTER_API_KEY="ak-你的Key"')} 然后 node chat.mjs`);
    console.log(`     或在聊天中输入 ${paint('cyan', '/key ak-你的Key"')}`);
    if (!oneShot) process.exit(1);
  }

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

  const messages = [];
  let pendingImage = null;

  async function turn(userText) {
    if (pendingImage) {
      messages.push({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: pendingImage.dataUrl } },
          { type: 'text', text: userText },
        ],
      });
      pendingImage = null;
    } else {
      messages.push({ role: 'user', content: userText });
    }
    process.stdout.write(`\n${paint('green', 'ModelTester')} ${dim('›')} `);
    const started = Date.now();
    const estIn = estimateTokens(JSON.stringify(messages));
    let phase = 'connecting'; // connecting -> thinking -> answering
    let answer = '';
    let thinkLen = 0;
    let frame = 0;
    let aborted = false;
    let controller = null;

    const statusTimer = setInterval(() => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const label = phase === 'thinking' ? `思考中 ${secs}s` : phase === 'answering' ? `生成中 ${secs}s` : `连接中 ${secs}s`;
      process.stdout.write(`${CLEAR}${dim(SPINNER[frame++ % SPINNER.length] + ' ' + label)}`);
    }, 120);
    const clearStatus = () => process.stdout.write(CLEAR);

    const onSigint = () => { aborted = true; controller?.abort(); };
    process.on('SIGINT', onSigint);

    try {
      const { usage } = await streamChat(cfg, messages, {
        signal: (c2) => { controller = c2; },
        think: (t) => {
          if (phase !== 'thinking') { clearStatus(); process.stdout.write(`\n${dim('思考 ')}`); phase = 'thinking'; }
          thinkLen += t.length;
          process.stdout.write(thinkColor(t));
        },
        text: (t) => {
          if (phase !== 'answering') {
            clearStatus();
            if (phase === 'thinking') process.stdout.write(`\n${dim('─'.repeat(46))}\n`);
            phase = 'answering';
          }
          answer += t;
          process.stdout.write(t);
        },
      });
      clearStatus();
      if (phase === 'thinking') process.stdout.write(`\n${dim('─'.repeat(46))}\n`);
      process.stdout.write('\n');
      const estOut = estimateTokens(answer);
      console.log(fmtUsage(usage, Date.now() - started, { in: estIn, out: estOut }));
      messages.push({ role: 'assistant', content: answer });
      if (aborted) console.log(dim('  (已手动中断，以上为部分输出，仍保留在上下文中)'));
    } catch (err) {
      clearStatus();
      process.stdout.write('\n');
      if (aborted) {
        if (answer) {
          messages.push({ role: 'assistant', content: answer });
          console.log(dim(`  (已中断，保留已生成的 ${answer.length} 字)`));
        } else {
          messages.pop();
          console.log(dim('  (已中断，未产生内容)'));
        }
      } else {
        console.log(paint('red', `✗ ${err.message}`));
        messages.pop();
      }
    } finally {
      clearInterval(statusTimer);
      process.removeListener('SIGINT', onSigint);
    }
    process.stdout.write('\n');
  }

  if (oneShot) {
    busy = true;
    await turn(oneShot);
    process.exit(0);
  }

  printBanner(cfg);
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
        case 'clear': messages.length = 0; console.log(dim('✓ 上下文已清空')); break;
        case 'think':
          cfg.thinking = arg !== 'off';
          console.log(dim(`✓ 思考已${cfg.thinking ? '开启' : '关闭'}`)); break;
        case 'model':
          if (!arg) { console.log(dim(`当前模型: ${cfg.model}`)); break; }
          cfg.model = arg; console.log(dim(`✓ 已切换到 ${cfg.model}`)); break;
        case 'temp': {
          const v = Number(arg);
          if (Number.isNaN(v) || v < 0 || v > 1) { console.log(paint('yellow', '温度需在 0 ~ 1 之间')); break; }
          cfg.temperature = v; console.log(dim(`✓ 温度 = ${v}`)); break;
        }
        case 'max': {
          const v = Number(arg);
          if (!Number.isInteger(v) || v <= 0) { console.log(paint('yellow', 'max 需为正整数')); break; }
          cfg.maxTokens = v; console.log(dim(`✓ 最大输出 = ${v} tokens`)); break;
        }
        case 'key':
          if (!arg) { console.log(paint('yellow', '用法: /key ak-xxx')); break; }
          cfg.apiKey = arg; cfg.keyIsOverride = false; console.log(dim('✓ Key 已更新并保存')); break;
        case 'img': {
          if (!arg) { console.log(paint('yellow', '用法: /img /路径/图片.png')); break; }
          try {
            const buf = readFileSync(arg);
            const mime = arg.toLowerCase().endsWith('.png') ? 'image/png'
              : arg.toLowerCase().endsWith('.gif') ? 'image/gif'
              : arg.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
            pendingImage = { path: arg, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
            console.log(dim(`✓ 图片已附加: ${arg}，请输入你的问题`));
          } catch (e) {
            console.log(paint('red', `✗ 读不到图片: ${e.message}`));
          }
          break;
        }
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

// 作为被其他模块 import 的工具库时不启动交互界面
const invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main();
