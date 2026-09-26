/**
 * 配置与数据目录：三级回退（env → 同目录已有 config 用当前目录（源码态）→ ~/Library/Application Support/AuroraAgent（App 态））。
 * web.mjs / chat.mjs / check.mjs / tools/install-service.mjs 共用本文件，不再各自内联实现。
 * 5.0.0 起旧命名（ModelTester / MODELTESTER_*）全部更名 AuroraAgent；本文件顺带负责一次性迁移：
 * 旧数据目录整体搬迁（含旧名 config 就地改名），幂等、失败静默，不影响启动。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/** 限时折扣价: 输入 ¥2 / 输出 ¥8 每百万 tokens */
export const PRICE = { input: 2, output: 8 };

/** 权限三档（对齐 kimi Always Ask / Ask When Needed / Never Ask）：设定 ask 类动作的默认效应 */
export const PERMISSION_MODES = ['always_ask', 'ask_when_needed', 'never_ask'];
export const DEFAULT_PERMISSION_MODE = 'ask_when_needed';

/** 实验特性目录：AURORAAGENT_EXPERIMENTAL_<NAME> 单开；AURORAAGENT_EXPERIMENTAL_FLAG 全开。缺省关。 */
export const EXPERIMENTAL_FLAGS = ['MCP'];
export function experimentalEnabled(name) {
  if (process.env.AURORAAGENT_EXPERIMENTAL_FLAG) return true;
  return Boolean(process.env['AURORAAGENT_EXPERIMENTAL_' + String(name || '').toUpperCase()]);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CONFIG_FILE = 'auroraagent.config.json';
const LEGACY_CONFIG_FILE = 'modeltester.config.json';
const LEGACY_DATA_DIR = join(homedir(), 'Library', 'Application Support', 'ModelTester');

/** 目录内旧名 config 就地改名（源码态与迁移后各调用一次，幂等） */
function renameLegacyConfig(dir) {
  try {
    const from = join(dir, LEGACY_CONFIG_FILE);
    const to = join(dir, CONFIG_FILE);
    if (existsSync(from) && !existsSync(to)) renameSync(from, to);
  } catch {}
}

/** 旧数据目录 → 新目录：目标未初始化就整体搬迁（原子改名）；已初始化则只补缺的文件。旧目录留底不删。 */
function migrateLegacyDataDir(target) {
  try {
    if (!existsSync(LEGACY_DATA_DIR)) return;
    mkdirSync(target, { recursive: true });
    if (!existsSync(join(target, CONFIG_FILE)) && !existsSync(join(target, LEGACY_CONFIG_FILE))) {
      try { renameSync(LEGACY_DATA_DIR, target); renameLegacyConfig(target); return; } catch {}
    }
    for (const name of readdirSync(LEGACY_DATA_DIR)) {
      const to = join(target, name === LEGACY_CONFIG_FILE ? CONFIG_FILE : name);
      if (!existsSync(to)) copyFileSync(join(LEGACY_DATA_DIR, name), to);
    }
  } catch {}
}

/** 数据目录三级回退（env 显式指定优先；env 缺省时旧目录整体搬迁到新命名目录） */
export function resolveDataDir() {
  if (process.env.AURORAAGENT_DATA_DIR) return process.env.AURORAAGENT_DATA_DIR;
  const devDir = join(__dirname, '..');
  renameLegacyConfig(devDir);
  if (existsSync(join(devDir, CONFIG_FILE))) return devDir;
  const appDir = join(homedir(), 'Library', 'Application Support', 'AuroraAgent');
  migrateLegacyDataDir(appDir);
  return appDir;
}

export function loadConfig() {
  let saved = {};
  let fileExists = false;
  try {
    saved = JSON.parse(readFileSync(join(resolveDataDir(), CONFIG_FILE), 'utf8'));
    fileExists = true;
  } catch {}
  const overrideKey = process.env.AURORAAGENT_API_KEY || '';
  return {
    apiKey: overrideKey || saved.apiKey || '',
    // 环境变量 Key 只是临时覆盖: 配置文件已有 Key 时绝不写回文件
    keyIsOverride: Boolean(overrideKey) && fileExists && Boolean(saved.apiKey),
    model: saved.model || 'LongCat-2.5-Preview',
    thinking: saved.thinking !== false,
    temperature: saved.temperature ?? 0.7,
    maxTokens: saved.maxTokens ?? 32768,
    permissionMode: PERMISSION_MODES.includes(saved.permissionMode) ? saved.permissionMode : DEFAULT_PERMISSION_MODE,
    planMode: saved.planMode === true,
  };
}

/** 只持久化非密钥敏感字段的变更由调用方决定；apiKey 仅在调用方显式要求时写入 */
export function saveConfig(cfg) {
  const out = {
    model: cfg.model,
    thinking: cfg.thinking,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    permissionMode: PERMISSION_MODES.includes(cfg.permissionMode) ? cfg.permissionMode : DEFAULT_PERMISSION_MODE,
    planMode: cfg.planMode === true,
  };
  if (!cfg.keyIsOverride) out.apiKey = cfg.apiKey;
  writeFileSync(join(resolveDataDir(), CONFIG_FILE), JSON.stringify(out, null, 2) + '\n');
}
