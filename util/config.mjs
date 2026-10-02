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
import { parseGoalConfig } from './agent/goal/config.mjs';
import { writeFileAtomic } from './atomic.mjs';
import { withFileLockSync } from './lock.mjs';
import { parseTuiConfig } from './tui/config.mjs';
import { parseAgentProxy } from './proxy.mjs';
import { parseIgnoreConfig } from './ignore.mjs';
import { parseToolSearchConfig } from './agent/tool-search.mjs';
import { parseCompactionConfig } from './agent/context.mjs';
import { parseCodeModeConfig } from './agent/codemode/execute.mjs';
import { parsePromptCacheWarmConfig } from './llm/cache-warmer.mjs';
import { parseRulesConfig } from './agent/rules.mjs';
import { parseFailoverConfig, parseFailoverSection, FAILOVER_DEFAULTS } from './llm/failover.mjs';

/** 限时折扣价: 输入 ¥2 / 输出 ¥8 每百万 tokens */
export const PRICE = { input: 2, output: 8 };

/** 权限三档（对齐 kimi Always Ask / Ask When Needed / Never Ask）：设定 ask 类动作的默认效应 */
export const PERMISSION_MODES = ['always_ask', 'ask_when_needed', 'never_ask'];
export const DEFAULT_PERMISSION_MODE = 'ask_when_needed';

/** 提示缓存档位：auto（缺省）提供方声明支持即启用；off 一律不启用。
 *  真正生效还要提供方 capacity.supportsPromptCache===true——不支持的线路多发一个字段就是 400 */
export const PROMPT_CACHE_MODES = ['auto', 'off'];
export const DEFAULT_PROMPT_CACHE_MODE = 'auto';
/** 单叶容错：坏值回退缺省（与 goal / tui / failover 各段同一纪律） */
export function parsePromptCache(raw) {
  return PROMPT_CACHE_MODES.includes(raw) ? raw : DEFAULT_PROMPT_CACHE_MODE;
}

/** 会话标题生成方式：local 本地推导（零成本，缺省）/ model 调模型总结（每新会话多一次小请求） */
export const TITLE_MODES = ['local', 'model'];
export const DEFAULT_TITLE_MODE = 'local';

/** 实验特性目录：AURORAAGENT_EXPERIMENTAL_<NAME> 单开；AURORAAGENT_EXPERIMENTAL_FLAG 全开。缺省关。 */
export const EXPERIMENTAL_FLAGS = ['MCP', 'HOOKS'];
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

export function loadConfig({ warn } = {}) {
  let saved = {};
  let fileExists = false;
  try {
    saved = JSON.parse(readFileSync(join(resolveDataDir(), CONFIG_FILE), 'utf8'));
    fileExists = true;
  } catch {}
  const overrideKey = process.env.AURORAAGENT_API_KEY || '';
  // 多提供方故障转移（429/5xx/网络错误时换到提供同模型的其它提供方重试，缺省开）
  const failover = parseFailoverConfig(saved, process.env, warn ? { warn } : {});
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
    titleMode: TITLE_MODES.includes(saved.titleMode) ? saved.titleMode : DEFAULT_TITLE_MODE,
    // Agent 沙箱出站代理（web_fetch 等工具用）：空 = 直连；坏值回退直连并告警
    agentProxy: parseAgentProxy(saved.agentProxy, warn ? { warn } : {}) || '',
    // goal 段解析（单叶容错 + 钳制）落在 goal/config.mjs；启动方传 warn  surfaced 坏值告警
    goal: parseGoalConfig(saved.goal, warn ? { warn } : {}),
    // tui 段解析（终端标题项序 + 通知三档）落在 tui/config.mjs，同样的单叶容错纪律
    tui: parseTuiConfig(saved.tui, warn ? { warn } : {}),
    // 忽略文件开关（.auroraagentignore 声明工作目录禁入区）：解析在 ignore.mjs，缺省开
    ignore: parseIgnoreConfig(saved.ignore),
    // shell 子进程环境净化（剔除 KEY/TOKEN/SECRET 等凭据形态变量）：缺省开
    sanitizeChildEnv: saved.sanitizeChildEnv !== false,
    // 提示缓存档位（auto / off）：提供方声明 supportsPromptCache 且非 off 时，wire.mjs 才会
    // 插缓存断点；不支持的线路保持历史字节形态。读取认 saved，保存走下方白名单回写
    promptCache: parsePromptCache(saved.promptCache),
    // 规则 toggle 表（用户显式关掉的规则不注入）：解析在 agent/rules.mjs，缺省全开
    rules: parseRulesConfig(saved),
    // tool_search（外部工具超阈值时标 deferred 省 token）：解析在 agent/tool-search.mjs，缺省关
    toolSearch: parseToolSearchConfig(saved.toolSearch),
    // 提示缓存续命（turn 结束后用同前缀廉价请求把缓存条目续上）：解析在 llm/cache-warmer.mjs，缺省关
    promptCacheWarm: parsePromptCacheWarmConfig(saved.promptCacheWarm),
    compaction: parseCompactionConfig(saved.compaction),
    // 代码模式（QuickJS 沙箱脚本）：开关 + 单次执行超时 + 输出 token 预算，解析在
    // agent/codemode/execute.mjs，缺省开（工具本身仍要过 policy 权限确认）
    codeMode: parseCodeModeConfig(saved.codeMode),
    providerFailover: failover.enabled,
    providerFailoverMaxAttempts: failover.maxAttempts,
    // failover 段原样透出（超时三件套 / 熔断五项 / 偏好有效期）：设置页读写与 saveConfig
    // 的白名单回写都要靠它在内存里存活，否则任何一次其它设置保存都会把这一节抹掉
    failover: parseFailoverSection(saved.failover),
  };
}

/** 盘上现值（saveConfig 用）：调用方未感知故障转移字段时保留，防止整体覆写误清（env 覆盖值不落盘） */
function savedFailover() {
  try {
    const saved = JSON.parse(readFileSync(join(resolveDataDir(), CONFIG_FILE), 'utf8'));
    const parsed = parseFailoverConfig(saved, {});
    return { providerFailover: parsed.enabled, providerFailoverMaxAttempts: parsed.maxAttempts };
  } catch { return { providerFailover: FAILOVER_DEFAULTS.enabled, providerFailoverMaxAttempts: FAILOVER_DEFAULTS.maxAttempts }; }
}

/** 盘上现值（saveConfig 用）：调用方未感知某段时保留盘上原值，防止整体覆写误清 */
function savedSection(key) {
  try { return JSON.parse(readFileSync(join(resolveDataDir(), CONFIG_FILE), 'utf8'))[key]; } catch { return undefined; }
}

/** 盘上现值（saveConfig 用）：调用方未感知 agentProxy 时保留，防止旧调用方整体覆写误清 */
function savedAgentProxy() {
  try { return parseAgentProxy(JSON.parse(readFileSync(join(resolveDataDir(), CONFIG_FILE), 'utf8')).agentProxy) || ''; } catch { return ''; }
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
    titleMode: TITLE_MODES.includes(cfg.titleMode) ? cfg.titleMode : DEFAULT_TITLE_MODE,
    goal: parseGoalConfig(cfg.goal),
    tui: parseTuiConfig(cfg.tui),
    ignore: cfg.ignore !== undefined ? parseIgnoreConfig(cfg.ignore) : (savedSection('ignore') !== undefined ? parseIgnoreConfig(savedSection('ignore')) : parseIgnoreConfig(undefined)),
    sanitizeChildEnv: cfg.sanitizeChildEnv !== undefined ? cfg.sanitizeChildEnv !== false : savedSection('sanitizeChildEnv') !== false,
    // 提示缓存档位：调用方未感知时保留盘上原值，防止其它设置保存把这一项抹掉
    promptCache: parsePromptCache(cfg.promptCache !== undefined ? cfg.promptCache : savedSection('promptCache')),
    rules: cfg.rules !== undefined ? parseRulesConfig(cfg.rules) : parseRulesConfig(savedSection('rules')),
    toolSearch: cfg.toolSearch !== undefined ? parseToolSearchConfig(cfg.toolSearch) : parseToolSearchConfig(savedSection('toolSearch')),
    promptCacheWarm: cfg.promptCacheWarm !== undefined ? parsePromptCacheWarmConfig(cfg.promptCacheWarm) : parsePromptCacheWarmConfig(savedSection('promptCacheWarm')),
    compaction: cfg.compaction !== undefined ? parseCompactionConfig(cfg.compaction) : parseCompactionConfig(savedSection('compaction')),
    codeMode: cfg.codeMode !== undefined ? parseCodeModeConfig(cfg.codeMode) : parseCodeModeConfig(savedSection('codeMode')),
    agentProxy: cfg.agentProxy !== undefined ? (parseAgentProxy(cfg.agentProxy) || '') : savedAgentProxy(),
    providerFailover: cfg.providerFailover !== undefined ? parseFailoverConfig(cfg, {}).enabled : savedFailover().providerFailover,
    providerFailoverMaxAttempts: cfg.providerFailoverMaxAttempts !== undefined
      ? parseFailoverConfig(cfg, {}).maxAttempts : savedFailover().providerFailoverMaxAttempts,
    failover: parseFailoverSection(cfg.failover),
  };
  if (!cfg.keyIsOverride) out.apiKey = cfg.apiKey;
  // 原子落盘 + 0600：配置里可能有 API Key，半截文件与全局可读都是事故（util/atomic.mjs）。
  // 外面再套跨进程锁（util/lock.mjs）：本函数是「读—改—整篇写回」，web 服务与终端同时保存时
  // 后落的快照会把对方那一笔改动整篇抹掉（lost update），原子写只治半截不治丢更新
  const configPath = join(resolveDataDir(), CONFIG_FILE);
  withFileLockSync(configPath, () => writeFileAtomic(configPath, JSON.stringify(out, null, 2) + '\n'));
}
