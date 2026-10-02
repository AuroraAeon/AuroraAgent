/**
 * 扩展系统（零依赖，仅 Node 内置模块；迁移 pi packages/coding-agent 的 project-extensions 本地化）。
 *
 * 形态：用户把 .mjs 丢进 <数据目录>/extensions/，每个文件默认导出
 *   { name, tools?: [{ name, description, parameters, run(args, ctx) }], commands?: [{ name, description, run }] }
 * 工具经 util/llm/tool.mjs 归一化后与内置工具、MCP 工具同形态入列（ext__<扩展>__<工具>）。
 *
 * 安全边界（pi docs/security.md 反复强调的那条，一条不让）：
 *  - 扩展跑在本进程内，权限与 AuroraAgent 完全相同。它能读你的会话转录、你的 API Key、
 *    你的文件，并代表你执行任何动作。所以加载不是自动的：必须显式批准「这个文件 + 这份哈希」；
 *  - 批准粒度 = 文件内容 sha256。改了文件哈希就变，重新加载时立即变成未信任、不再入列——
 *    「批准过的扩展悄悄换了实现」这条最常见的供应链花招在这里直接失效；
 *  - 扩展工具一律不过白名单：默认 ask（policy.mjs 的 ext__* 规则），与 mcp__* 同姿态。
 *    用户可以在会话里选「总是允许」把它提起来，那是用户自己的决定，不是默认值；
 *  - 坏模块 fail-open：单个扩展抛异常 / 不符合契约只跳过它并报错，绝不让整个 Agent 起不来。
 *
 * 与 pi 的差距（lite 边界）：pi 还支持项目级 .pi/extensions + 项目信任 + npm 包安装 +
 * hook 事件（project_trust 等）。本地单用户工具只做数据目录级 + 哈希批准；npm 安装意味着
 * 把供应链整个搬进来，与「后端零依赖」的底线冲突，不做。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../atomic.mjs';

const EXT_DIR = 'extensions';
const TRUST_FILE = 'extensions-trust.json';
const TRUST_VERSION = 1;
/** 扩展工具名前缀（与 mcp__ 同构，policy.mjs 的 ext__* 规则据此默认 ask） */
export const EXT_TOOL_PREFIX = 'ext__';
const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const MODULE_MAX_BYTES = 512 * 1024;

export function extensionDir(dataDir) {
  return join(String(dataDir || ''), EXT_DIR);
}

export function extensionTrustPath(dataDir) {
  return join(String(dataDir || ''), TRUST_FILE);
}

/** 批准键 = 文件内容 sha256（不是路径！路径会改名，内容哈希不会） */
export function trustKey(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 读信任表；坏文件按空表处理（不阻塞启动，代价是重新批准一次） */
export function loadExtensionTrust(dataDir) {
  try {
    const j = JSON.parse(readFileSync(extensionTrustPath(dataDir), 'utf8'));
    if (!j || typeof j !== 'object' || j.v !== TRUST_VERSION || !j.files || typeof j.files !== 'object') return {};
    return j.files;
  } catch { return {}; }
}

export function saveExtensionTrust(dataDir, files) {
  try {
    writeFileAtomic(extensionTrustPath(dataDir), JSON.stringify({ v: TRUST_VERSION, files }, null, 2));
    return true;
  } catch { return false; }
}

/** 批准一个扩展文件：读内容 → 记 sha256 → 落盘 0600 */
export function approveExtension(dataDir, fileName) {
  const file = safeJoin(extensionDir(dataDir), fileName);
  if (!file) return { ok: false, error: '非法的扩展文件名' };
  let bytes;
  try { bytes = readFileSync(file); } catch { return { ok: false, error: '文件不存在或读不到' }; }
  if (bytes.length > MODULE_MAX_BYTES) return { ok: false, error: `扩展文件过大（>${Math.floor(MODULE_MAX_BYTES / 1024)}KB）` };
  const files = loadExtensionTrust(dataDir);
  files[trustKey(bytes)] = { name: String(fileName), at: new Date().toISOString() };
  if (!saveExtensionTrust(dataDir, files)) return { ok: false, error: '信任表写入失败' };
  return { ok: true, key: trustKey(bytes), files };
}

export function revokeExtension(dataDir, key) {
  const files = loadExtensionTrust(dataDir);
  if (!files[String(key || '')]) return { ok: false, error: '没有这条批准记录' };
  delete files[String(key)];
  return { ok: saveExtensionTrust(dataDir, files), files };
}

/** 只允许一层文件名（拒绝 .. / 绝对路径 / 子目录）：扩展必须直接躺在 extensions/ 下 */
function safeJoin(dir, name) {
  const raw = String(name || '');
  if (!raw || raw.includes('/') || raw.includes('\\') || raw.includes('..') || raw.startsWith('.')) return null;
  if (!raw.endsWith('.mjs')) return null;
  const abs = join(dir, raw);
  return existsSync(abs) && statSync(abs).isFile() ? abs : null;
}

/** 磁盘上可见的扩展文件（不含子目录 / 非 .mjs） */
export function listExtensionFiles(dataDir) {
  try {
    return readdirSync(extensionDir(dataDir)).filter((f) => f.endsWith('.mjs')).sort();
  } catch { return []; }
}

/** 校验一个扩展模块的契约；返回 { ok, error?, extension? } */
export function validateExtensionModule(mod, fileName) {
  if (!mod || typeof mod !== 'object') return { ok: false, error: '模块没有默认导出对象' };
  const name = String(mod.name || '').trim();
  if (!NAME_RE.test(name)) return { ok: false, error: 'name 必填，只能用字母数字与 - _，最长 32 字符' };
  const tools = Array.isArray(mod.tools) ? mod.tools : [];
  const bad = tools.find((t) => !t || typeof t !== 'object' || !NAME_RE.test(String(t.name || '')) || typeof t.run !== 'function');
  if (bad) return { ok: false, error: `工具 ${String(bad?.name || '?')} 缺少 name（合法形态）或 run 函数` };
  const dupe = new Set();
  for (const t of tools) {
    const key = String(t.name);
    if (dupe.has(key)) return { ok: false, error: `工具名重复：${key}` };
    dupe.add(key);
  }
  const commands = Array.isArray(mod.commands) ? mod.commands : [];
  const badCmd = commands.find((c) => !c || typeof c !== 'object' || typeof c.run !== 'function' || !String(c.name || '').startsWith('/'));
  if (badCmd) return { ok: false, error: 'commands 的 name 必须以 / 开头且带 run 函数' };
  return { ok: true, extension: { name, tools, commands, file: String(fileName) } };
}

/**
 * 加载全部「已信任」扩展。返回：
 *   extensions —— 通过信任与契约校验的扩展（可直接取 tools）
 *   untrusted  —— 磁盘上有但哈希不在信任表里的（等用户批准）
 *   errors     —— 加载 / 契约失败的文件与原因（fail-open：只跳过它）
 */
export async function loadExtensions(dataDir) {
  const trusted = loadExtensionTrust(dataDir);
  const extensions = [];
  const untrusted = [];
  const errors = [];
  for (const fileName of listExtensionFiles(dataDir)) {
    const file = safeJoin(extensionDir(dataDir), fileName);
    if (!file) { errors.push({ file: fileName, error: '路径不合法（只支持 extensions/ 下的一层 .mjs）' }); continue; }
    let bytes;
    try { bytes = readFileSync(file); } catch { errors.push({ file: fileName, error: '读取失败' }); continue; }
    if (bytes.length > MODULE_MAX_BYTES) { errors.push({ file: fileName, error: '文件过大' }); continue; }
    const key = trustKey(bytes);
    if (!trusted[key]) { untrusted.push({ file: fileName, key, bytes: bytes.length }); continue; }
    let mod = null;
    try {
      const url = `file://${encodeURI(file).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
      mod = (await import(url)).default;
    } catch (e) { errors.push({ file: fileName, error: `导入失败：${String(e?.message || e)}` }); continue; }
    const v = validateExtensionModule(mod, fileName);
    if (!v.ok) { errors.push({ file: fileName, error: v.error }); continue; }
    extensions.push(v.extension);
  }
  return { extensions, untrusted, errors };
}

/**
 * 扩展工具 → Loop 的 extraTools 同形态（ext__<扩展>__<工具>，参数 schema 原样透传）。
 * 形状与 MCP 注册表的 #wrap 对齐：必须自带 run——normalizeTool 只出 wire 形状（name /
 * description / parameters / action / deferred），会把 run 抹掉，模型一调用就是
 * 「tool.run is not a function」。resolveTool 把 extraTools 原样交给 Loop 执行，
 * 这里少一个字段，整条扩展工具链就是断的。
 */
export function extensionTools(extensions = []) {
  const out = [];
  const seen = new Set();
  for (const ext of extensions) {
    for (const t of ext.tools || []) {
      const name = `${EXT_TOOL_PREFIX}${ext.name}__${t.name}`;
      if (seen.has(name)) continue; // 同名冲突时先到先得（另一处报 errors 由加载方决定）
      seen.add(name);
      out.push({
        name,
        description: `[扩展:${ext.name}] ${String(t.description || t.name)}`,
        action: name,
        parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} },
        run: async (args, ctx) => t.run(args, ctx),
      });
    }
  }
  return out;
}

/** 扩展命令 → 终端斜杠命令表（defineCommands 的输入形状；调用方决定何时加载） */
export function extensionCommands(extensions = []) {
  const out = [];
  for (const ext of extensions) {
    for (const c of ext.commands || []) {
      out.push({ name: String(c.name), description: `[扩展:${ext.name}] ${String(c.description || '')}`, run: c.run });
    }
  }
  return out;
}
