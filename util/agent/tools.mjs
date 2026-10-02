/**
 * Agent 工具集：十一个内置工具，全部经 JSON Schema 描述参数。
 * 安全边界（文档如实说明）：写类文件工具经 resolveInside 禁锢在会话工作目录；读类工具
 * 额外放开「已加载技能目录」这一只读白名单根，供模型读取技能附属的 references / scripts / assets；
 * 文件类工具在 resolveInside 之后再过 util/ignore.mjs 的忽略闸门（.auroraagentignore 声明的
 * 禁入区，命中即拒并带锁形标记）；shell 以工作目录为 cwd 执行、带超时与输出截断，子进程环境
 * 经 sanitizeChildEnv 净化（剔除凭据形态变量），但无 OS 级沙箱——
 * 真正的门控是 policy.mjs 的权限决策与前端确认流。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, sep, dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { toOpenAIFunction, toAnthropicTool } from '../llm/tool.mjs';
import { proxyFetch } from '../proxy.mjs';
import { findSkill, renderSkillContent, skillDirs, SKILL_FOLLOWUP } from './skills.mjs';
import { IGNORE_FILE_NAME, LOCK_TEXT_SYMBOL } from '../ignore.mjs';
import { runRipgrepAsync, excludeGlobs } from '../ripgrep.mjs';
import { staleFileNotice } from './file-tracker.mjs';
import { TOOL_SEARCH_DESCRIPTION, DEFAULT_TOOL_SEARCH_LIMIT, Bm25Ranker, createToolSearchDocument } from './tool-search.mjs';

const MAX_OUTPUT = 32 * 1024;   // 单次工具回给模型的文本上限
const MAX_FETCH = 64 * 1024;    // web_fetch 正文上限
const MAX_ENTRIES = 500;        // list_dir 条数上限
/** 杀整棵进程组：zsh -lc 起的后代（build / server / sleep &）不随 shell 一起退，
 *  只杀 shell 自己会留下一堆孤儿进程（移植 pi bash.ts 的 killProcessTree 口径） */
function killProcessTree(child) {
  const pid = child.pid;
  if (pid && process.platform !== 'win32') {
    try { process.kill(-pid, 'SIGKILL'); return; } catch { /* 组已不存在 / 无权限：退回杀 shell 本身 */ }
  }
  try { child.kill('SIGKILL'); } catch { /* 进程已退出 */ }
}

/** shell 输出 spill 目录（进程级，退出即删） */
const SHELL_SPILL_DIR = join(tmpdir(), `auroraagent-shell-${process.pid}`);
let shellSpillSeq = 0;
let shellSpillHooked = false;
function shellSpillPath() {
  if (!shellSpillHooked) {
    shellSpillHooked = true;
    process.on('exit', () => { try { rmSync(SHELL_SPILL_DIR, { recursive: true, force: true }); } catch { /* 清理失败静默 */ } });
  }
  mkdirSync(SHELL_SPILL_DIR, { recursive: true });
  return join(SHELL_SPILL_DIR, `cmd-${++shellSpillSeq}.log`);
}

const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024; // 工具结果图片（截图）内联进消息序列的体积上限
const IMAGE_CACHE_MAX = 8;                  // base64 缓存张数（历史每轮都会重放同一张图）
const IMAGE_DATA_URL_CACHE = new Map();

/**
 * 工具结果的多模态图片负载 → OpenAI 形状的 tool 消息 content。
 * computer_use 的截图经 extra.image = { path, mime, width, height } 随结果回传：模型要能
 * 「看见」屏幕，故把图片转成 data URL 与文本一起进消息序列；无图片（或文件已不在）时保持
 * 纯字符串，历史行为不变。Anthropic 侧由 llm/message.mjs 的 toAnthropicContent 翻成 image block。
 * 同一张图会被历史每轮重放读到，按 path+size+mtime 缓存 base64，避免长会话里反复读盘。
 */
export function toolMessageContent(output, extra) {
  const img = extra && extra.image;
  const text = String(output ?? '');
  if (!img || !img.path) return text;
  let url = '';
  try {
    const st = statSync(img.path);
    if (st.isFile() && st.size > 0 && st.size <= MAX_IMAGE_BYTES) {
      const key = `${img.path}|${st.size}|${Math.floor(st.mtimeMs)}`;
      let hit = IMAGE_DATA_URL_CACHE.get(key);
      if (hit === undefined) {
        hit = `data:${img.mime || 'image/png'};base64,${readFileSync(img.path).toString('base64')}`;
        if (IMAGE_DATA_URL_CACHE.size >= IMAGE_CACHE_MAX) IMAGE_DATA_URL_CACHE.clear();
        IMAGE_DATA_URL_CACHE.set(key, hit);
      }
      url = hit;
    }
  } catch { /* 截图文件已不在（清理 / 换数据目录）时只回文本，不让整轮请求失败 */ }
  if (!url) return text;
  // 文本为空时给一句占位：个别上游拒绝「只有图片」的 tool content
  return [{ type: 'text', text: text || '（截图如下）' }, { type: 'image_url', image_url: { url } }];
}


export class ToolError extends Error {
  constructor(message, code = 'tool_error') {
    super(message);
    this.code = code;
  }
}

/** 把用户/模型给的路径解析到工作目录内，越界即拒（防 .. 穿越与绝对路径逃逸）；
 *  extraRoots 是只读白名单根（已加载技能的绝对目录），让模型能读技能附属的
 *  references / scripts / assets——只有读类工具会传它，写类工具一律只认工作目录 */
export function resolveInside(root, p, extraRoots = []) {
  const abs = resolve(root, String(p || ''));
  if (abs === root || abs.startsWith(root + sep)) return abs;
  for (const r of extraRoots || []) {
    if (r && (abs === r || abs.startsWith(r + sep))) return abs;
  }
  throw new ToolError(`路径越界：${p} 不在工作目录或已加载的技能目录内`, 'path_escape');
}

/**
 * 忽略闸门：resolveInside 之后过。命中即拒（中文原因 + 锁形标记），
 * 让模型知道「文件在，但被用户声明为禁入区」——它会换别的文件，而不是反复重试同一路径。
 * ctx.ignore 由 Loop 按会话工作目录注入（util/ignore.mjs）；缺省（终端旧调用方 / 单测）不拦。
 */
function gateIgnored(ctx, abs, shown) {
  const ctl = ctx?.ignore;
  if (!ctl || typeof ctl.isIgnored !== 'function') return;
  const hit = ctl.isIgnored(abs);
  if (hit.ignored) {
    throw new ToolError(`${shown} 被 ${IGNORE_FILE_NAME} 声明为禁入区（匹配规则：${hit.pattern}）${LOCK_TEXT_SYMBOL}`, 'ignored');
  }
}

/**
 * 检查点镜像钩子（非 git 工作区的回滚靠它）：写落笔前把被改文件的原内容抄进本轮镜像。
 * git 仓库由 checkpoint.mjs 的 stash 快照管，这里恒为空转（capture 内部判 mirror 是否存在）。
 * ctx.checkpoint 由 Loop 按会话注入；缺省（终端旧调用方 / 单测）不抄。
 */
function captureForCheckpoint(ctx, abs) {
  ctx?.checkpoint?.capture?.(abs);
}

/**
 * shell 子进程环境净化：剔除凭据形态变量（KEY / TOKEN / SECRET / PASSWORD / CREDENTIAL），
 * 只留运行命令必需的基础项。模型跑的命令能读走上游 Key 是真实风险——一条 `env | curl …`
 * 就是事故。enabled=false 可关（排障用），缺省开；白名单内的键即使形态匹配也保留。
 */
const CHILD_ENV_KEEP = new Set(['PATH', 'HOME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'USER', 'LOGNAME', 'TERM', 'TZ', 'PWD', 'ZDOTDIR']);
const CHILD_ENV_DROP_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
export function sanitizeChildEnv(env = process.env, enabled = true) {
  const src = env || {};
  if (enabled === false) return { ...src };
  const out = {};
  for (const k of Object.keys(src)) {
    if (CHILD_ENV_DROP_RE.test(k) && !CHILD_ENV_KEEP.has(k)) continue;
    out[k] = src[k];
  }
  return out;
}

/** 读类工具的允许根集合：会话工作目录 + 已加载技能目录（写类工具不放开） */
function readRoots(ctx) {
  return ctx?.skills ? skillDirs(ctx.skills) : [];
}

/** 展示路径：工作目录内用相对路径，白名单根内（技能附属文件）用绝对路径，便于回传给 read_file */
function displayPath(ctx, abs) {
  const rel = relative(ctx.workspace, abs);
  return rel && !rel.startsWith('..') ? rel.split(sep).join('/') : abs.split(sep).join('/');
}

function truncate(text, limit = MAX_OUTPUT) {
  const s = String(text);
  if (s.length <= limit) return s;
  return `${s.slice(0, limit)}\n...[输出被截断：共 ${s.length} 字符，上限 ${limit}。请缩小范围后重试]`;
}

function numbered(lines, from) {
  const width = String(from + lines.length - 1).length;
  return lines.map((l, i) => `${String(from + i).padStart(width)}  ${l}`).join('\n');
}

/** 行级 diff：首尾公共行夹住变更区，附带 2 行上下文；超过 MAX_DIFF_LINES 行时折叠 */
const MAX_DIFF_LINES = 60;

export function lineDiff(oldText, newText, context = 2) {
  const a = String(oldText ?? '').split('\n');
  const b = String(newText ?? '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const from = Math.max(0, start - context);
  const out = [];
  for (let i = from; i < start; i++) out.push({ type: 'context', lineNo: i + 1, text: a[i] });
  for (let i = start; i < endA; i++) out.push({ type: 'del', lineNo: i + 1, text: a[i] });
  for (let i = start; i < endB; i++) out.push({ type: 'add', lineNo: i + 1, text: b[i] });
  const toB = Math.min(b.length, endB + context);
  for (let i = endB; i < toB; i++) out.push({ type: 'context', lineNo: i + 1, text: b[i] });
  if (out.length > MAX_DIFF_LINES) {
    return [...out.slice(0, MAX_DIFF_LINES - 1), { type: 'meta', lineNo: 0, text: `…（diff 过长已折叠，共 ${out.length} 行）` }];
  }
  return out;
}

/** diff 行数组 → 紧凑文本（模型可见，终端预览同款） */
export function diffToText(diff = []) {
  if (!diff.length) return '（无变化）';
  return diff.map((d) => {
    const mark = d.type === 'add' ? '+' : d.type === 'del' ? '-' : d.type === 'meta' ? ' ' : ' ';
    return `${mark} ${String(d.lineNo).padStart(4)}  ${d.text}`;
  }).join('\n');
}

/** 待办清单渲染（[x] / [ ] 为 ASCII 标记，规避 emoji 铁律） */
export function renderTodoList(items = []) {
  if (!items.length) return '（待办清单为空）';
  const done = items.filter((t) => t.done).length;
  const lines = items.map((t, i) => `${i + 1}. [${t.done ? 'x' : ' '}] ${t.text}`);
  return `待办 ${done}/${items.length} 完成：\n${lines.join('\n')}`;
}

/** 检索类工具共享的目录遍历：跳过版本库 / 依赖 / 构建产物等噪音目录，回调每个文件绝对路径 */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.venv', '__pycache__', '.next', 'coverage', 'public/app']);
const MAX_FILE_BYTES = 512 * 1024;

/** 检索遍历的跳过谓词：目录被跳过即整枝剪掉（忽略规则对目录生效时省掉整棵子树的枚举） */
function walkFiles(root, onFile, { skipDir = () => false, skipFile = () => false } = {}) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const abs = join(root, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name) && !skipDir(abs)) walkFiles(abs, onFile, { skipDir, skipFile });
    } else if (ent.isFile()) {
      if (!skipFile(abs)) onFile(abs);
    }
  }
}

/** ctx.ignore 存在时的跳过谓词（不存在 = 不拦，行为与接入前一致） */
function ignorePredicate(ctx) {
  const ctl = ctx?.ignore;
  if (!ctl || typeof ctl.isIgnored !== 'function') return () => false;
  return (abs) => ctl.isIgnored(abs).ignored;
}

/** 读文本文件；二进制（含 NUL）或超限返回 null */
function readTextFile(abs) {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const raw = readFileSync(abs, 'utf8');
    if (raw.slice(0, 8000).includes('\0')) return null;
    return raw;
  } catch { return null; }
}

/** 文件名 glob（仅 * 与 ?）转正则（大小写不敏感） */
function fileGlobRe(pattern) {
  const re = String(pattern || '').split('').map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('');
  return new RegExp(`(^|/)${re}$`, 'i');
}

/** 路径 glob 转正则：星号星号跨目录（含尾随斜杠时可匹配零层）、单星号匹配一段、问号匹配单字符 */
export function globToRegExp(pattern) {
  const p = String(pattern || '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*' && p[i + 1] === '*') {
      i++;
      if (p[i + 1] === '/') { re += '(?:.*/)?'; i++; } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/**
 * 检索用的 rg 排除参数：把 SKIP_DIRS 转成 rg 的 -g 排除（ripgrep 的 --no-ignore --hidden
 * 已关掉它自己的忽略文件与隐藏文件过滤，目录黑名单因此必须显式给，否则 .git 会被翻个底朝天）。
 * 名单只有 SKIP_DIRS 一份，ripgrep 路径与纯 JS 路径共用，不会各自漂移。
 */
const RG_EXCLUDE = excludeGlobs([...SKIP_DIRS]).flatMap((g) => ['-g', g]);
const RG_COMMON = ['--no-ignore', '--hidden', '--color=never', '--no-messages', ...RG_EXCLUDE];

/** 单行 rg JSON 输出 → 命中（rg 的 JSON 把 path / line_number / 文本分开给，路径或正文里带冒号也不会错位） */
function rgMatchLine(raw, root, ctx) {
  let ev;
  try { ev = JSON.parse(raw); } catch { return null; }
  if (ev?.type !== 'match' || !ev.data) return null;
  const rel = String(ev.data.path?.text || '');
  const line = Number(ev.data.line_number) || 0;
  const text = String(ev.data.lines?.text || '').replace(/\n$/, '');
  if (!rel || !line) return null;
  return { abs: join(root, rel), line, text };
}

/**
 * grep 的 ripgrep 路径。返回 null = 该回退到纯 JS 遍历（rg 没装 / 起不来 / rg 自己报错，
 * 典型是正则用了 Rust regex 不支持的语法）。过滤与截断仍由本文件负责：rg 只当快速遍历器用，
 * 「装没装 rg」因此不影响检索结果，只影响快慢。
 */
async function grepWithRipgrep(pattern, root, nameRe, cap, ctx) {
  // 末尾的 '.' 不能省：rg 没拿到路径参数时会转去读 stdin，而子进程的 stdin 是永不关闭的
  // 管道——那就不是「搜得慢」，是直接挂死到超时（本文件踩过的坑）
  const out = await runRipgrepAsync(['--json', '--regexp', pattern, '.', ...RG_COMMON], { cwd: root });
  if (!out || out.status === 2) return null;
  const skip = ignorePredicate(ctx);
  const hits = [];
  for (const raw of out.stdout.split('\n')) {
    if (!raw || hits.length >= cap) continue;
    const hit = rgMatchLine(raw, root, ctx);
    if (!hit) continue;
    if (nameRe && !nameRe.test(hit.abs.split('/').pop())) continue;
    if (skip(hit.abs)) continue;
    hits.push(`${displayPath(ctx, hit.abs)}:${hit.line}: ${hit.text.trimEnd().slice(0, 300)}`);
  }
  return hits;
}

/**
 * glob 的 ripgrep 路径：只借 rg 的目录遍历（--files），glob 语义仍由本文件的 globToRegExp
 * 判定（锚定 / 基名 / 单星不跨目录），保证两条路径对同一模式的答案一致。
 * @returns {string[]|null} 绝对路径数组；null = 回退
 */
async function globFilesWithRipgrep(root, ctx) {
  const out = await runRipgrepAsync(['--files', '--null', '.', ...RG_COMMON], { cwd: root });
  if (!out || out.status === 2) return null;
  const skip = ignorePredicate(ctx);
  const files = [];
  for (const rel of out.stdout.split('\0')) {
    if (!rel) continue;
    const abs = join(root, rel);
    if (skip(abs)) continue;
    files.push(abs);
  }
  return files;
}

export const TOOLS = [
  {
    name: 'read_file',
    parallel: true, // 只读无副作用：相邻的同类调用可并行执行（loop.mjs 的 runToolCalls 据此重叠）
    description: '读取工作目录内的文本文件，返回带行号的内容；范围过大时用 offset/limit 分段读',
    action: 'read_file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的文件路径' },
        offset: { type: 'integer', description: '起始行号（1 起），省略则从第 1 行' },
        limit: { type: 'integer', description: '最多读取的行数，默认 2000' },
      },
      required: ['path'],
    },
    run(args, ctx) {
      const abs = resolveInside(ctx.workspace, args.path, readRoots(ctx));
      gateIgnored(ctx, abs, args.path);
      let st;
      try { st = statSync(abs); } catch { throw new ToolError(`文件不存在：${args.path}`, 'not_found'); }
      if (st.isDirectory()) throw new ToolError(`${args.path} 是目录，请改用 list_dir`, 'is_dir');
      const raw = readFileSync(abs, 'utf8');
      ctx?.fileTracker?.note(abs); // 记下指纹：之后 edit_file 能发现「这文件被外部改过」
      // 文件以一个换行结尾时不把它算成空行（与编辑器行数一致）
      const lines = (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n');
      const from = Math.max(1, Number(args.offset) || 1);
      const limit = Math.min(5000, Math.max(1, Number(args.limit) || 2000));
      const slice = lines.slice(from - 1, from - 1 + limit);
      const head = `${args.path}（共 ${lines.length} 行，显示 ${from}-${from + slice.length - 1}）`;
      return truncate(`${head}\n${numbered(slice, from)}`);
    },
  },
  {
    name: 'list_dir',
    parallel: true, // 只读无副作用：相邻的同类调用可并行执行（loop.mjs 的 runToolCalls 据此重叠）
    description: '列出工作目录内某个目录的直接子项（目录带 / 后缀）',
    action: 'list_dir',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作目录的目录路径，省略则为工作目录根' } },
    },
    run(args, ctx) {
      const abs = resolveInside(ctx.workspace, args.path || '.', readRoots(ctx));
      gateIgnored(ctx, abs, args.path || '.');
      let st;
      try { st = statSync(abs); } catch { throw new ToolError(`目录不存在：${args.path}`, 'not_found'); }
      if (!st.isDirectory()) throw new ToolError(`${args.path} 不是目录，请改用 read_file`, 'not_dir');
      const names = readdirSync(abs, { withFileTypes: true })
        .map((d) => (d.isDirectory() ? `${d.name}/` : d.name))
        .sort((a, b) => a.localeCompare(b));
      if (!names.length) return `${args.path || '.'}/ （空目录）`;
      const shown = names.slice(0, MAX_ENTRIES);
      const suffix = names.length > shown.length ? `\n...[还有 ${names.length - shown.length} 项未显示]` : '';
      return truncate(`${args.path || '.'}/\n${shown.join('\n')}${suffix}`);
    },
  },
  {
    name: 'write_file',
    description: '把完整内容写入工作目录内的文件（覆盖写，自动创建父目录）',
    action: 'write_file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的文件路径' },
        content: { type: 'string', description: '要写入的完整内容' },
      },
      required: ['path', 'content'],
    },
    run(args, ctx) {
      const abs = resolveInside(ctx.workspace, args.path);
      gateIgnored(ctx, abs, args.path);
      captureForCheckpoint(ctx, abs); // 检查点镜像（非 git 工作区）：落笔前抄下原内容
      const stale = ctx?.fileTracker?.changedSince(abs);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, String(args.content ?? ''));
      ctx?.fileTracker?.refresh(abs); // 刷新指纹：别把自己这次的写算成外部改动
      const head = `已写入 ${args.path}（${String(args.content ?? '').length} 字符）`;
      return stale ? `${head}\n${staleFileNotice(args.path)}` : head;
    },
  },
  {
    name: 'edit_file',
    description: '对工作目录内的文件做精确字符串替换；old_string 多处出现时必须带足够上下文或设 replace_all',
    action: 'edit_file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对工作目录的文件路径' },
        old_string: { type: 'string', description: '要被替换掉的原文（需精确匹配，含缩进）' },
        new_string: { type: 'string', description: '替换后的新文本' },
        replace_all: { type: 'boolean', description: 'true 时替换全部出现处，默认 false' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    run(args, ctx) {
      const abs = resolveInside(ctx.workspace, args.path);
      gateIgnored(ctx, abs, args.path);
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) throw new ToolError('old_string 不能为空', 'bad_args');
      // 落笔前探一次新鲜度：模型可能隔着好几轮才来改这个文件，期间用户改过它
      const stale = ctx?.fileTracker?.changedSince(abs);
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch { throw new ToolError(`文件不存在：${args.path}`, 'not_found'); }
      const parts = text.split(oldStr);
      const count = parts.length - 1;
      if (count === 0) throw new ToolError(`未找到要替换的文本：请先 read_file 确认 ${args.path} 的当前内容`, 'no_match');
      if (count > 1 && !args.replace_all) {
        throw new ToolError(`要替换的文本在 ${args.path} 中出现 ${count} 次：请提供更多上下文以精确定位，或设 replace_all=true`, 'not_unique');
      }
      const next = args.replace_all ? parts.join(newStr) : text.replace(oldStr, newStr);
      captureForCheckpoint(ctx, abs); // 检查点镜像（非 git 工作区）：落笔前抄下原内容
      writeFileSync(abs, next);
      ctx?.fileTracker?.refresh(abs); // 刷新指纹：别把自己这次的写当成外部改动
      const diff = lineDiff(text, next);
      const head = `已替换 ${args.path} 中 ${args.replace_all ? count : 1} 处`;
      return {
        output: `${head}\n${stale ? staleFileNotice(args.path) : ''}${diffToText(diff)}`,
        extra: { diff, path: args.path },
      };
    },
  },
  {
    name: 'shell',
    description: '在工作目录内执行 shell 命令（zsh -lc），返回退出码与输出；输出超限会被截断',
    action: 'shell',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        timeout_seconds: { type: 'integer', description: '超时秒数，5-120，默认 30' },
      },
      required: ['command'],
    },
    run(args, ctx) {
      const cmd = String(args.command ?? '');
      if (!cmd.trim()) throw new ToolError('command 不能为空', 'bad_args');
      const timeout = Math.min(120, Math.max(5, Number(args.timeout_seconds) || 30)) * 1000;
      mkdirSync(ctx.workspace, { recursive: true });
      const t0 = Date.now();
      return new Promise((done, fail) => {
        // 独立进程组（detached）：超时 / 中止时杀整个组，zsh -lc 起的后代
        // （build、server、sleep &）不会只杀 shell 自己后残留成孤儿——macOS 无进程树工具，
        // 杀组是最简可靠做法（移植 pi bash.ts 的 killProcessTree 口径）
        const child = spawn('/bin/zsh', ['-lc', cmd], {
          cwd: ctx.workspace,
          env: sanitizeChildEnv(process.env, ctx?.sanitizeChildEnv !== false),
          detached: true,
        });
        let out = '';
        let err = '';
        let timedOut = false;
        let aborted = false;
        const timer = setTimeout(() => {
          timedOut = true;
          killProcessTree(child);
        }, timeout);
        // 用户中止（turn 级 signal）同样杀组：长命令说停就真停，不留野进程
        const onAbort = () => { aborted = true; killProcessTree(child); };
        if (ctx?.signal) {
          if (ctx.signal.aborted) onAbort();
          else ctx.signal.addEventListener('abort', onAbort, { once: true });
        }
        child.stdout.on('data', (d) => { out += d; if (out.length > MAX_OUTPUT * 2) out = out.slice(0, MAX_OUTPUT * 2); });
        child.stderr.on('data', (d) => { err += d; if (err.length > MAX_OUTPUT * 2) err = err.slice(0, MAX_OUTPUT * 2); });
        child.on('error', (e) => {
          clearTimeout(timer);
          ctx?.signal?.removeEventListener('abort', onAbort);
          fail(new ToolError(`命令启动失败：${e.message}`, 'spawn_error'));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          ctx?.signal?.removeEventListener('abort', onAbort);
          const wall = ((Date.now() - t0) / 1000).toFixed(1);
          const head = `$ ${cmd}\n(cwd: 工作目录, 退出码: ${code ?? 'null'}, 耗时 ${wall}s${timedOut ? ', 已超时终止' : ''}${aborted && !timedOut ? ', 已中止' : ''})`;
          const body = [out ? `stdout:\n${out}` : '', err ? `stderr:\n${err}` : ''].filter(Boolean).join('\n') || '（无输出）';
          const text = `${head}\n${body}`;
          // 超上限截断的同时把已捕获全文 spill 到临时文件，路径随提示回给模型——
          // shell 能读绝对路径（read_file 被禁锢在工作目录内读不到它，模型可 shell 取回）。
          // 进程退出即清理（见 shellSpillPath），不留垃圾文件
          if (text.length > MAX_OUTPUT) {
            try {
              const full = shellSpillPath();
              writeFileSync(full, text);
              return done(`${truncate(text)}\n\n[输出超过 ${Math.round(MAX_OUTPUT / 1024)}KB 上限已截断；已捕获部分全文在 ${full}（shell 可直接读取）]`);
            } catch { /* spill 失败不碍事：截断结果照常回 */ }
          }
          done(truncate(text));
        });
      });
    },
  },
  {
    name: 'web_fetch',
    parallel: true, // 只读无副作用：相邻的同类调用可并行执行（loop.mjs 的 runToolCalls 据此重叠）
    description: '抓取一个 http(s) URL 的文本内容（JSON 原样、HTML 截断返回），用于查文档等只读场景',
    action: 'web_fetch',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '完整的 http/https 地址' } },
      required: ['url'],
    },
    async run(args, ctx) {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new ToolError('只支持 http/https URL', 'bad_args');
      // 设置了本机代理（ctx.proxy）时经代理出站——本机直连被重置的站点（如维基百科）的出路
      const proxy = String(ctx?.proxy || '');
      let resp;
      try {
        resp = proxy
          ? await proxyFetch(url, proxy, { timeoutMs: 20000 })
          : await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
      } catch (e) { throw new ToolError(`抓取失败：${e.message}`, 'fetch_error'); }
      const text = await resp.text();
      return truncate(`HTTP ${resp.status} ${url}\n${text}`, MAX_FETCH);
    },
  },

  {
    name: 'grep',
    parallel: true, // 只读无副作用：相邻的同类调用可并行执行（loop.mjs 的 runToolCalls 据此重叠）
    description: '在工作目录内按正则搜索文件内容，返回 文件:行号: 内容；自动跳过 .git / node_modules / 构建产物，二进制文件不搜',
    action: 'grep',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式（JavaScript 语法，大小写敏感）' },
        path: { type: 'string', description: '搜索起点（相对工作目录），省略则整个工作目录' },
        glob: { type: 'string', description: '文件名过滤（如 *.mjs），省略则所有文本文件' },
        max_results: { type: 'integer', description: '最多返回的匹配条数，默认 50，上限 200' },
      },
      required: ['pattern'],
    },
    async run(args, ctx) {
      let re;
      try { re = new RegExp(String(args.pattern || '')); } catch (e) { throw new ToolError(`正则无效：${e.message}`, 'bad_args'); }
      const root = resolveInside(ctx.workspace, args.path || '.', readRoots(ctx));
      gateIgnored(ctx, root, args.path || '.');
      const nameRe = args.glob ? fileGlobRe(args.glob) : null;
      const cap = Math.min(200, Math.max(1, Number(args.max_results) || 50));
      // ripgrep 优先（util/ripgrep.mjs）：拿不到结果才回退到纯 JS 遍历
      const fast = await grepWithRipgrep(String(args.pattern || ''), root, nameRe, cap, ctx);
      if (fast) {
        if (!fast.length) return `未匹配到 /${args.pattern}/`;
        const more = fast.length >= cap ? `\n[已达上限 ${cap} 条，缩小 pattern 或 path 后重试]` : '';
        return truncate(`匹配 ${fast.length} 条：\n${fast.join('\n')}${more}`);
      }
      const hits = [];
      let scanned = 0;
      const skip = ignorePredicate(ctx);
      walkFiles(root, (abs) => {
        if (hits.length >= cap) return;
        if (nameRe && !nameRe.test(relative(root, abs).split('/').pop())) return;
        const text = readTextFile(abs);
        if (text == null) return;
        scanned++;
        const rel = displayPath(ctx, abs);
        const lines = text.split('\n');
        for (let i = 0; i < lines.length && hits.length < cap; i++) {
          if (re.test(lines[i])) hits.push(`${rel}:${i + 1}: ${lines[i].trimEnd().slice(0, 300)}`);
        }
      }, { skipDir: skip, skipFile: skip });
      if (!hits.length) return `未匹配到 /${args.pattern}/（扫描 ${scanned} 个文本文件）`;
      const more = hits.length >= cap ? `\n[已达上限 ${cap} 条，缩小 pattern 或 path 后重试]` : '';
      return truncate(`匹配 ${hits.length} 条（扫描 ${scanned} 个文本文件）：\n${hits.join('\n')}${more}`);
    },
  },
  {
    name: 'glob',
    parallel: true, // 只读无副作用：相邻的同类调用可并行执行（loop.mjs 的 runToolCalls 据此重叠）
    description: '按文件名模式在工作目录内查找文件（** 跨目录、* 匹配一段、? 匹配单字符），返回相对路径列表',
    action: 'glob',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，如 **/*.mjs、src/*.ts、package.json' },
        path: { type: 'string', description: '搜索起点（相对工作目录），省略则工作目录根' },
      },
      required: ['pattern'],
    },
    async run(args, ctx) {
      const pattern = String(args.pattern || '').trim();
      if (!pattern) throw new ToolError('pattern 不能为空', 'bad_args');
      const root = resolveInside(ctx.workspace, args.path || '.', readRoots(ctx));
      gateIgnored(ctx, root, args.path || '.');
      const hasSlash = pattern.includes('/');
      const re = globToRegExp(pattern);
      const out = [];
      const skip = ignorePredicate(ctx);
      // ripgrep 只负责「快速把文件列出来」，模式匹配仍走上面的 globToRegExp
      const fast = await globFilesWithRipgrep(root, ctx);
      if (fast) {
        for (const abs of fast) {
          if (out.length >= 500) break;
          const rel = relative(root, abs).split(sep).join('/');
          const target = hasSlash ? rel : rel.split('/').pop();
          if (re.test(target)) out.push(displayPath(ctx, abs));
        }
      } else {
        walkFiles(root, (abs) => {
          if (out.length >= 500) return;
          const rel = relative(root, abs).split(sep).join('/');
          const target = hasSlash ? rel : rel.split('/').pop();
          if (re.test(target)) out.push(displayPath(ctx, abs));
        }, { skipDir: skip, skipFile: skip });
      }
      out.sort();
      if (!out.length) return `未匹配到 ${pattern}`;
      const more = out.length >= 500 ? `\n[已达上限 500 条，缩小 pattern 后重试]` : '';
      return truncate(`匹配 ${out.length} 个文件：\n${out.join('\n')}${more}`);
    },
  },
  {
    name: 'todo',
    description: '维护任务待办清单：list 查看 / add 新增 / done 完成 / remove 删除（序号 1 起）。多步任务先规划再逐项更新',
    action: 'todo',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'done', 'remove'], description: 'list 查看；add 新增；done 标记完成；remove 删除' },
        item: { type: 'string', description: 'add 填事项文本；done / remove 填序号' },
      },
      required: ['action'],
    },
    run(args, ctx) {
      const store = ctx?.todoStore;
      if (!store) throw new ToolError('todo 工具需要会话上下文', 'no_ctx');
      const action = String(args.action || 'list').toLowerCase();
      if (action === 'list') return renderTodoList(store.get());
      if (action === 'add') {
        const text = String(args.item || '').trim();
        if (!text) throw new ToolError('add 需要 item 事项文本', 'bad_args');
        store.set([...store.get(), { text, done: false }]);
      } else if (action === 'done' || action === 'remove') {
        const items = store.get();
        const idx = Number(args.item) - 1;
        if (!Number.isInteger(idx) || idx < 0 || idx >= items.length) {
          throw new ToolError(`序号无效：${args.item}（当前共 ${items.length} 项）`, 'bad_args');
        }
        if (action === 'done') {
          const next = items.slice();
          next[idx] = { ...next[idx], done: true };
          store.set(next);
        } else {
          store.set(items.filter((_, i) => i !== idx));
        }
      } else {
        throw new ToolError(`未知动作：${action}（list / add / done / remove）`, 'bad_args');
      }
      return { output: renderTodoList(store.get()), extra: { todos: store.get() } };
    },
  },
  {
    name: 'skill',
    description: '加载一个技能的完整指令。当用户请求与系统提示技能目录里某个技能的描述匹配时调用；返回的文本是本次任务必须遵循的规范，并带出该技能的绝对目录与附属资源清单（references / scripts / assets，按需读取）',
    action: 'skill',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '技能名称（取自系统提示里的技能目录）' } },
      required: ['name'],
    },
    run(args, ctx) {
      const skills = Array.isArray(ctx?.skills) ? ctx.skills : [];
      const skill = findSkill(skills, args.name);
      if (!skill) {
        const names = skills.map((s) => s.name).join('、') || '（无）';
        throw new ToolError(`技能不存在：${args.name}。可用技能：${names}`, 'not_found');
      }
      // 同一轮内重复激活：指令已在上下文里，短回执替代整篇正文，避免重复占额
      if (ctx?.skillsLoaded?.has(skill.name)) {
        return `[技能：${skill.name}] 已在本轮加载过，指令仍在上下文中，直接遵循即可，不要重复加载。`;
      }
      ctx?.skillsLoaded?.add(skill.name);
      return `${renderSkillContent(skill)}\n${SKILL_FOLLOWUP}`;
    },
  },
  {
    name: 'task',
    description: '派发子代理并行执行独立子任务并汇总结果。每个子代理有完整工具集与独立上下文，但看不到父会话内容——子任务描述必须自含（目标、范围、产出要求）。适用于可并行拆解或需要独立上下文的子任务',
    action: 'task',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '单个子任务描述（自含：目标、范围、产出要求）' },
        tasks: { type: 'array', items: { type: 'string' }, description: '多个子任务（并行派发，上限 4 个）' },
      },
    },
    run(args, ctx) {
      const spawn = ctx?.spawn;
      if (typeof spawn !== 'function') throw new ToolError('task 工具需要会话运行时上下文', 'no_ctx');
      return spawn(args.task, args.tasks);
    },
  },
  {
    // tool_search：MCP 等外部工具超出阈值时被标 deferred 不进请求（省工具定义 token），
    // 模型经此检索元数据。AuroraAgent 的 resolveTool 从全量解析执行，命中即可直接调用，
    // 不需要「激活后下一轮才生效」的状态机（迁移 pi tool-search/tool.ts，见 util/agent/tool-search.mjs）
    name: 'tool_search',
    description: TOOL_SEARCH_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索词：功能 / 资源 / 操作的自然语言描述（中文即可）' },
        limit: { type: 'integer', description: `最多返回几个工具，缺省 ${DEFAULT_TOOL_SEARCH_LIMIT}` },
      },
      required: ['query'],
    },
    run(args, ctx) {
      const query = String(args.query || '').trim();
      if (!query) throw new ToolError('query 不能为空：描述你要找的能力即可', 'bad_args');
      const want = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 20) : DEFAULT_TOOL_SEARCH_LIMIT;
      // ctx.allTools 是 Loop 注入的本 turn 全量工具（含未随请求声明的 deferred 外部工具）
      const all = typeof ctx?.allTools === 'function' ? ctx.allTools() : (Array.isArray(ctx?.allTools) ? ctx.allTools : []);
      const seen = new Set();
      const candidates = all.filter((t) => t && t.name && t.deferred === true && !seen.has(t.name) && (seen.add(t.name), true));
      if (!candidates.length) {
        return '没有可检索的工具：当前没有「未随请求声明」的外部工具（MCP 工具要么已在声明列表里，要么未连接），直接用可用工具列表中的工具即可。';
      }
      const matches = new Bm25Ranker().rank(query, candidates.map(createToolSearchDocument), want);
      if (!matches.length) return `未检索到与「${query}」匹配的工具（可换更通用的词重试）。`;
      const byName = new Map(candidates.map((t) => [t.name, t]));
      const lines = matches.map((m, i) => {
        const t = byName.get(m.name);
        const oneLine = String(t.description || '').trim().split(/\r?\n/)[0];
        return `${i + 1}. ${t.name}：${oneLine}\n参数 Schema：\n${JSON.stringify(t.parameters || {}, null, 2)}`;
      });
      return [`命中 ${matches.length} 个工具。可直接按名调用（无需等到下一轮）：`, ...lines].join('\n');
    },
  },
];
export function getTool(name) {
  return TOOLS.find((t) => t.name === String(name || '')) || null;
}

/**
 * tools 拼装缓存：每个模型轮都要按 (toolNames, extraTools) 重建一次 tools[]，
 * 长会话里这是纯重复劳动。缓存键含 extraTools 各工具对象的标识——
 * MCP 刷新会换新对象（标识随之变），因此不会服务陈旧 schema；
 * 约定工具对象创建后不再原地修改（normalizeTool 一律产出新对象）。
 */
const objIds = new WeakMap();
let objIdSeq = 0;
function objId(o) {
  let v = objIds.get(o);
  if (v === undefined) { v = ++objIdSeq; objIds.set(o, v); }
  return v;
}
const convCache = new WeakMap(); // 工具对象 -> { openai, anthropic } 转换结果
const schemaCache = new Map();   // 缓存键 -> tools[]
/**
 * schemaCache 上限：键含 extraTools 各对象的标识，而 code 工具是每 turn 现造一份新对象
 * （描述要列本 turn 可调用工具，MCP 连接断开也会换）——标识随之每轮一变，无上限的
 * Map 会在长会话里稳步长胖。到了上限丢最早的一条（换键的成本只是重跑一次转换）。
 */
const SCHEMA_CACHE_MAX = 256;
function schemaCacheSet(key, value) {
  if (schemaCache.size >= SCHEMA_CACHE_MAX && !schemaCache.has(key)) schemaCache.delete(schemaCache.keys().next().value);
  schemaCache.set(key, value);
}
/** 缓存键的 deferred 标记位：同一批工具对象被 Loop 打 / 摘 deferred 时（toolSearch 开关切换）
 *  键必须随之变化，否则会服务「未过滤」或「过度过滤」的陈旧 tools[] */
function deferredMask(extraTools) { return extraTools.map((t) => (t && t.deferred === true ? 'd' : 'a')).join(''); }

function converted(t) {
  let c = convCache.get(t);
  if (!c) { c = { openai: toOpenAIFunction(t), anthropic: toAnthropicTool(t) }; convCache.set(t, c); }
  return c;
}

function pickTools(names, extraTools = []) {
  const picked = names.length ? TOOLS.filter((t) => names.includes(t.name)) : [];
  const extra = extraTools.filter((t) => names.includes(t.name));
  // deferred 工具不进请求顶层 tools[]：保持字节稳定以命中提示缓存；Loop 侧仍可解析执行
  return [...picked, ...extra].filter((t) => t.deferred !== true);
}

/** OpenAI function calling 形状的 tools 参数；extraTools 承载 MCP 等外部工具 */
export function toolSchemas(names, extraTools = []) {
  const key = `openai|${names.join(',')}|${deferredMask(extraTools)}|${extraTools.map(objId).join(',')}`;
  let hit = schemaCache.get(key);
  if (!hit) { hit = pickTools(names, extraTools).map((t) => converted(t).openai); schemaCacheSet(key, hit); }
  return hit;
}

/** Anthropic Messages 形状（input_schema 而非 parameters） */
export function anthropicToolSchemas(names, extraTools = []) {
  const key = `anthropic|${names.join(',')}|${deferredMask(extraTools)}|${extraTools.map(objId).join(',')}`;
  let hit = schemaCache.get(key);
  if (!hit) { hit = pickTools(names, extraTools).map((t) => converted(t).anthropic); schemaCacheSet(key, hit); }
  return hit;
}

/**
 * 本 turn 实际可调用的工具对象全集：内置按 toolNames 取，外加 extraTools 全量
 * （含被 tool_search 标了 deferred 的外部工具——不进请求顶层只为省 token，Loop 侧照样能解析执行，
 *  因而脚本也该看得见、调得着）。
 * 与 pickTools 的区别就在 deferred：那条是「进请求」的口径，这条是「调得着」的口径。
 */
export function effectiveTools(names, extraTools = []) {
  const picked = names && names.length ? TOOLS.filter((t) => names.includes(t.name)) : [];
  return [...picked, ...extraTools];
}

/** 工具解析：内置优先，其次 extraTools（MCP 工具经 loop 注入） */
export function resolveTool(name, extraTools = []) {
  return getTool(name) || extraTools.find((t) => t.name === String(name || '')) || null;
}

/** 权限判定的资源标识：文件类取路径，shell 取命令，web_fetch 取 URL */
export function toolResource(name, args) {
  const a = args || {};
  if (name === 'shell') return String(a.command || '');
  if (name === 'web_fetch') return String(a.url || '');
  // computer_use：资源是「哪块屏幕」，按目标应用区分，方便「总是允许」只放行某个应用
  if (name === 'computer_use') return `screen:${a.app || '前台界面'}`;
  return String(a.path || '');
}
