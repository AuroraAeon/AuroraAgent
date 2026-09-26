#!/usr/bin/env node
/**
 * 纯色图片识别测试: 本地生成一组纯色 PNG，逐张问当前接入的模型（LongCat）
 * "这张图片主要是什么颜色"，统计判定与通过率。
 * 零依赖（node:zlib 手写 PNG），直接请求真实上游，会计入账号用量。
 *
 * 用法:
 *   npm run color                 # 全部用例
 *   node tools/color-test.mjs --only 红     # 只跑名字以"红"开头的用例
 *   node tools/color-test.mjs --json --round 2 > round2.json   # 机器可读输出
 */
import { deflateSync } from 'node:zlib';
import { loadConfig, streamChat, PRICE } from '../chat.mjs';

const PROMPT = '这张图片的主要颜色是什么？请只回答颜色名称（如"红色"），不要解释。';
const TIMEOUT_MS = 90_000;

// ---------- 终端着色 ----------
const c = { green: '\x1b[32m', red: '\x1b[31m', dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', reset: '\x1b[0m' };
const paint = (color, s) => `${c[color]}${s}${c.reset}`;

// ---------- 极简 PNG 编码器（truecolor, 8bit, 无交错） ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let k = n;
    for (let j = 0; j < 8; j++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1;
    t[n] = k;
  }
  return t;
})();
function crc32(buf) {
  let v = 0xffffffff;
  for (let i = 0; i < buf.length; i++) v = CRC_TABLE[(v ^ buf[i]) & 0xff] ^ (v >>> 8);
  return (v ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([td, data])));
  return Buffer.concat([len, td, data, crc]);
}
/** 通用 PNG 生成: paint(x, y) 返回该像素的 [r, g, b] */
function makePng(width, height, paint) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint(x, y, width, height);
      row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const raw = Buffer.concat(rows);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

const solid = (rgb) => () => rgb;

/** 对照组: 底色 + 中心圆，验证视觉链路本身是否正常 */
const withCircle = (bg, fg, ratio = 0.3) => (x, y, w, h) => {
  const dx = x - w / 2; const dy = y - h / 2;
  return Math.hypot(dx, dy) < w * ratio ? fg : bg;
};

// ---------- 终端显示宽度（CJK 记 2） ----------
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x20000 && cp <= 0x3fffd))) ? 2 : 1;
  }
  return w;
}
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - dispWidth(s)));
const truncate = (s, n) => {
  let out = ''; let w = 0;
  for (const ch of String(s)) {
    const cw = dispWidth(ch);
    if (w + cw > n - 1) { out += '…'; break; }
    out += ch; w += cw;
  }
  return out;
};

// ---------- 测试用例 ----------
const CASES = [
  { name: '红',   rgb: [220, 30, 30],   aliases: ['红', '赤'] },
  { name: '绿',   rgb: [30, 160, 60],   aliases: ['绿'] },
  { name: '蓝',   rgb: [40, 90, 220],   aliases: ['蓝'] },
  { name: '黄',   rgb: [240, 200, 30],  aliases: ['黄'] },
  { name: '紫',   rgb: [140, 60, 190],  aliases: ['紫'] },
  { name: '橙',   rgb: [240, 130, 30],  aliases: ['橙'] },
  { name: '青',   rgb: [30, 190, 190],  aliases: ['青', '蓝绿'] },
  { name: '粉',   rgb: [240, 150, 180], aliases: ['粉'] },
  { name: '黑',   rgb: [10, 10, 10],    aliases: ['黑'] },
  { name: '白',   rgb: [245, 245, 245], aliases: ['白'] },
  { name: '灰',   rgb: [128, 128, 128], aliases: ['灰'] },
  { name: '棕',   rgb: [140, 90, 45],   aliases: ['棕', '褐'] },
  { name: '红@64', rgb: [220, 30, 30],  size: 64, aliases: ['红', '赤'] }, // 复现"纯红被判黑色"的历史个案
  { name: '深蓝', rgb: [12, 24, 90],    aliases: ['蓝'] },                  // 深色易被误判为黑
  // 对照组: 非均匀图像。若它能答对，说明视觉链路正常，问题只在均匀纯色图
  { name: '红底白圆', rgb: [220, 30, 30], paint: withCircle([220, 30, 30], [245, 245, 245]), aliases: ['红'], control: true },
];

async function ask(cfg, dataUrl) {
  let ctrl = null;
  const timer = setTimeout(() => ctrl?.abort(), TIMEOUT_MS);
  const started = Date.now();
  let answer = '';
  try {
    const { usage } = await streamChat({ ...cfg, thinking: false, temperature: 0 }, [
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: PROMPT },
      ] },
    ], { signal: (c2) => { ctrl = c2; }, text: (t) => { answer += t; } });
    return { answer: answer.trim(), usage, ms: Date.now() - started, error: null };
  } catch (err) {
    return { answer: '', usage: null, ms: Date.now() - started, error: err.name === 'AbortError' ? '超时' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const cfg = loadConfig();
  if (!cfg.apiKey) {
    console.log('[!] 未找到 API Key。请先在 auroraagent.config.json 配置，或 export AURORAAGENT_API_KEY。');
    process.exit(1);
  }
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;
  const cases = only ? CASES.filter((k) => k.name.includes(only)) : CASES;
  if (!cases.length) { console.log(`没有匹配 "${only}" 的用例`); process.exit(1); }
  const jsonMode = process.argv.includes('--json');
  const roundIdx = process.argv.indexOf('--round');
  const round = roundIdx >= 0 ? Number(process.argv[roundIdx + 1]) : null;

  if (!jsonMode) console.log(`${c.bold}纯色图片识别测试${c.reset} · 模型 ${cfg.model} · ${cases.length} 个用例 · 每张 PNG 本地生成\n`);
  const rows = [];
  let pass = 0; let errCount = 0;
  let tokIn = 0; let tokOut = 0;

  for (const k of cases) {
    const size = k.size ?? 256;
    const paintFn = k.paint ?? solid(k.rgb);
    const dataUrl = 'data:image/png;base64,' + makePng(size, size, (x, y) => paintFn(x, y, size, size)).toString('base64');
    const r = await ask(cfg, dataUrl);
    if (r.error) {
      errCount++;
      rows.push({ ...k, size, ok: false, answer: `(${r.error})`, ms: r.ms, error: r.error });
      if (!jsonMode) console.log(`${paint('red', '✗')} ${pad(k.name, 6)} rgb(${k.rgb.join(',')}) ${c.dim}${size}px${c.reset}  ${paint('red', r.error)}`);
      continue;
    }
    tokIn += r.usage?.prompt_tokens ?? 0;
    tokOut += r.usage?.completion_tokens ?? 0;
    const norm = r.answer.toLowerCase().replace(/[\s*`"'"'。.,，!！?？]/g, '');
    const ok = k.aliases.some((a) => norm.includes(a.toLowerCase()));
    if (ok) pass++;
    rows.push({ ...k, size, ok, answer: r.answer, ms: r.ms, usage: r.usage });
    if (jsonMode) continue;
    const tag = k.control ? `${c.cyan}(对照)${c.reset} ` : '';
    console.log(`${ok ? paint('green', '✓') : paint('red', '✗')} ${tag}${pad(k.name, 6)} rgb(${k.rgb.join(',')}) ${c.dim}${size}px${c.reset}  ${pad(r.answer.replace(/\s+/g, ' '), 16)} ${c.dim}${(r.ms / 1000).toFixed(1)}s${c.reset}`);
  }

  if (jsonMode) {
    const out = {
      round, model: cfg.model, ts: new Date().toISOString(),
      cases: rows.map((r) => ({
        name: r.name, rgb: r.rgb, size: r.size, ok: r.ok,
        answer: r.answer.replace(/\s+/g, ' ').trim(), ms: r.ms,
        control: Boolean(r.control), error: r.error || null,
        usage: r.usage ? { input: r.usage.prompt_tokens, output: r.usage.completion_tokens } : null,
      })),
    };
    console.log(JSON.stringify(out));
    process.exit(0);
  }

  const total = rows.length;
  const cost = (tokIn * PRICE.input + tokOut * PRICE.output) / 1_000_000;
  console.log(`\n${c.bold}明细${c.reset}`);
  for (const r of rows) {
    const mark = r.ok ? paint('green', '通过') : paint('red', '未过');
    console.log(`  ${pad(r.name, 7)} ${mark}  模型答: ${truncate(r.answer.replace(/\s+/g, ' ') || '(空)', 40)}`);
  }
  console.log(`\n${c.bold}汇总${c.reset}: ${pass}/${total} 通过${errCount ? ` · ${errCount} 个请求失败` : ''} · 输入 ${tokIn} tok · 输出 ${tokOut} tok · 约 ¥${cost.toFixed(4)}`);
  const ctrl = rows.find((r) => r.control);
  if (ctrl) console.log(`${c.dim}对照组(红底白圆): ${ctrl.ok ? '答对 → 视觉链路正常，纯色失败是模型对均匀图像的识别缺陷' : '也未答对 → 视觉链路本身可能故障，需排查图片上传/解码'}${c.reset}`);
  const bad = rows.filter((r) => !r.ok && !r.answer.startsWith('('));
  if (bad.length) console.log(`${c.dim}误判颜色: ${bad.map((r) => r.name).join('、')}${c.reset}`);
}

main();
