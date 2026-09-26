/**
 * 配置与数据目录：三级回退（env → 同目录已有 config 用当前目录（源码态）→ ~/Library/Application Support/ModelTester（App 态））。
 * 从 chat.mjs 抽出供终端 Agent 与工具库共用；web.mjs / check.mjs / tools/install-service.mjs 各自的内联实现须与本文件保持一致。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** 限时折扣价: 输入 ¥2 / 输出 ¥8 每百万 tokens */
export const PRICE = { input: 2, output: 8 };

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 数据目录三级回退（四处实现必须保持一致，见 AGENTS.md 第 4 节） */
export function resolveDataDir() {
  if (process.env.MODELTESTER_DATA_DIR) return process.env.MODELTESTER_DATA_DIR;
  if (existsSync(join(__dirname, '..', 'modeltester.config.json'))) return join(__dirname, '..');
  return join(homedir(), 'Library', 'Application Support', 'ModelTester');
}

export function loadConfig() {
  let saved = {};
  let fileExists = false;
  try {
    saved = JSON.parse(readFileSync(join(resolveDataDir(), 'modeltester.config.json'), 'utf8'));
    fileExists = true;
  } catch {}
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

/** 只持久化非密钥敏感字段的变更由调用方决定；apiKey 仅在调用方显式要求时写入 */
export function saveConfig(cfg) {
  const out = {
    model: cfg.model,
    thinking: cfg.thinking,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
  };
  if (!cfg.keyIsOverride) out.apiKey = cfg.apiKey;
  writeFileSync(join(resolveDataDir(), 'modeltester.config.json'), JSON.stringify(out, null, 2) + '\n');
}
