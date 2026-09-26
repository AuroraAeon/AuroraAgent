#!/usr/bin/env node
/** 连接自检: 验证 API Key 可用、查看模型列表、发一条最小请求（AuroraAgent） */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.MODELTESTER_BASE_URL || 'https://api.longcat.chat';

// 数据目录三级回退：env → 本地已有 config 用当前目录（源码态）→ ~/Library/Application Support/ModelTester（App 态）
function resolveDataDir() {
  if (process.env.MODELTESTER_DATA_DIR) return process.env.MODELTESTER_DATA_DIR;
  if (existsSync(join(__dirname, 'modeltester.config.json'))) return __dirname;
  return join(homedir(), 'Library', 'Application Support', 'ModelTester');
}

function loadConfig() {
  let saved = {};
  try { saved = JSON.parse(readFileSync(join(resolveDataDir(), 'modeltester.config.json'), 'utf8')); } catch {}
  return { apiKey: process.env.MODELTESTER_API_KEY || saved.apiKey || '', model: saved.model || 'LongCat-2.5-Preview' };
}

const cfg = loadConfig();
if (!cfg.apiKey) {
  console.log('✗ 未配置 API Key');
  console.log('  1. 打开 https://longcat.chat/platform/api_keys 注册并创建 Key');
  console.log('  2. export MODELTESTER_API_KEY="sk-你的Key" 后重试，或写入 modeltester.config.json');
  process.exit(1);
}

console.log('1) 查询模型列表 …');
try {
  const r = await fetch(`${BASE}/openai/v1/models`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const ids = (j.data || []).map((m) => m.id);
  console.log(`   ✓ 可用模型: ${ids.join(', ') || '(列表为空)'}`);
  if (ids.length && !ids.includes(cfg.model)) console.log(`   [!] 当前配置的模型 ${cfg.model} 不在列表中`);
} catch (e) {
  console.log(`   ✗ ${e.message}`);
  if (String(e.message).includes('401')) {
    console.log('   → Key 无效，请检查 https://longcat.chat/platform/api_keys');
    process.exit(1);
  }
}

console.log('2) 发送测试请求 …');
try {
  const r = await fetch(`${BASE}/openai/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: 'user', content: '只回复：连接成功' }],
      max_tokens: 16,
      temperature: 0,
      thinking: { type: 'disabled' },
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.log(`   ✗ HTTP ${r.status}: ${t}`);
    if (r.status === 402) console.log('   → 账号额度已用尽，三条路: ① https://longcat.chat/platform/ 充值 ② Token资源包每日 10:00/16:00/21:00/23:00 抢购 ③ 邀请好友领奖励');
    process.exit(1);
  }
  const j = await r.json();
  console.log(`   ✓ 模型回复: ${j.choices?.[0]?.message?.content}`);
  console.log(`   ✓ 用量: ${JSON.stringify(j.usage)}`);
  console.log('\n全部通过，可以开始体验了:  npm run chat  或  npm run web');
} catch (e) {
  console.log(`   ✗ ${e.message}`);
  process.exit(1);
}
