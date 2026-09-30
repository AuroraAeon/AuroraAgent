/**
 * Agent 工具集：十一个内置工具，全部经 JSON Schema 描述参数。
 * 安全边界（文档如实说明）：写类文件工具经 resolveInside 禁锢在会话工作目录；读类工具
 * 额外放开「已加载技能目录」这一只读白名单根，供模型读取技能附属的 references / scripts / assets；
 * shell 以工作目录为 cwd 执行、带超时与输出截断，但无 OS 级沙箱——
 * 真正的门控是 policy.mjs 的权限决策与前端确认流。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, sep, dirname, join, relative } from 'node:path';
import { toOpenAIFunction, toAnthropicTool } from '../llm/tool.mjs';
import { proxyFetch } from '../proxy.mjs';
import { findSkill, renderSkillContent, skillDirs, SKILL_FOLLOWUP } from './skills.mjs';

const MAX_OUTPUT = 32 * 1024;   // 单次工具回给模型的文本上限
const MAX_FETCH = 64 * 1024;    // web_fetch 正文上限
const MAX_ENTRIES = 500;        // list_dir 条数上限
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

function walkFiles(root, onFile) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const abs = join(root, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) walkFiles(abs, onFile);
    } else if (ent.isFile()) {
      onFile(abs);
    }
  }
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

export const TOOLS = [
  {
    name: 'read_file',
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
      let st;
      try { st = statSync(abs); } catch { throw new ToolError(`文件不存在：${args.path}`, 'not_found'); }
      if (st.isDirectory()) throw new ToolError(`${args.path} 是目录，请改用 list_dir`, 'is_dir');
      const raw = readFileSync(abs, 'utf8');
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
    description: '列出工作目录内某个目录的直接子项（目录带 / 后缀）',
    action: 'list_dir',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '相对工作目录的目录路径，省略则为工作目录根' } },
    },
    run(args, ctx) {
      const abs = resolveInside(ctx.workspace, args.path || '.', readRoots(ctx));
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
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, String(args.content ?? ''));
      return `已写入 ${args.path}（${String(args.content ?? '').length} 字符）`;
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
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) throw new ToolError('old_string 不能为空', 'bad_args');
      let text;
      try { text = readFileSync(abs, 'utf8'); } catch { throw new ToolError(`文件不存在：${args.path}`, 'not_found'); }
      const parts = text.split(oldStr);
      const count = parts.length - 1;
      if (count === 0) throw new ToolError(`未找到要替换的文本：请先 read_file 确认 ${args.path} 的当前内容`, 'no_match');
      if (count > 1 && !args.replace_all) {
        throw new ToolError(`要替换的文本在 ${args.path} 中出现 ${count} 次：请提供更多上下文以精确定位，或设 replace_all=true`, 'not_unique');
      }
      const next = args.replace_all ? parts.join(newStr) : text.replace(oldStr, newStr);
      writeFileSync(abs, next);
      const diff = lineDiff(text, next);
      return {
        output: `已替换 ${args.path} 中 ${args.replace_all ? count : 1} 处\n${diffToText(diff)}`,
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
      return new Promise((done, fail) => {
        const child = spawn('/bin/zsh', ['-lc', cmd], { cwd: ctx.workspace, env: process.env });
        let out = '';
        let err = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill('SIGKILL'); } catch {}
        }, timeout);
        child.stdout.on('data', (d) => { out += d; if (out.length > MAX_OUTPUT * 2) out = out.slice(0, MAX_OUTPUT * 2); });
        child.stderr.on('data', (d) => { err += d; if (err.length > MAX_OUTPUT * 2) err = err.slice(0, MAX_OUTPUT * 2); });
        child.on('error', (e) => { clearTimeout(timer); fail(new ToolError(`命令启动失败：${e.message}`, 'spawn_error')); });
        child.on('close', (code) => {
          clearTimeout(timer);
          const head = `$ ${cmd}\n(cwd: 工作目录, 退出码: ${code ?? 'null'}${timedOut ? ', 已超时终止' : ''})`;
          const body = [out ? `stdout:\n${out}` : '', err ? `stderr:\n${err}` : ''].filter(Boolean).join('\n') || '（无输出）';
          done(truncate(`${head}\n${body}`));
        });
      });
    },
  },
  {
    name: 'web_fetch',
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
    run(args, ctx) {
      let re;
      try { re = new RegExp(String(args.pattern || '')); } catch (e) { throw new ToolError(`正则无效：${e.message}`, 'bad_args'); }
      const root = resolveInside(ctx.workspace, args.path || '.', readRoots(ctx));
      const nameRe = args.glob ? fileGlobRe(args.glob) : null;
      const cap = Math.min(200, Math.max(1, Number(args.max_results) || 50));
      const hits = [];
      let scanned = 0;
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
      });
      if (!hits.length) return `未匹配到 /${args.pattern}/（扫描 ${scanned} 个文本文件）`;
      const more = hits.length >= cap ? `\n[已达上限 ${cap} 条，缩小 pattern 或 path 后重试]` : '';
      return truncate(`匹配 ${hits.length} 条（扫描 ${scanned} 个文本文件）：\n${hits.join('\n')}${more}`);
    },
  },
  {
    name: 'glob',
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
    run(args, ctx) {
      const pattern = String(args.pattern || '').trim();
      if (!pattern) throw new ToolError('pattern 不能为空', 'bad_args');
      const root = resolveInside(ctx.workspace, args.path || '.', readRoots(ctx));
      const hasSlash = pattern.includes('/');
      const re = globToRegExp(pattern);
      const out = [];
      walkFiles(root, (abs) => {
        if (out.length >= 500) return;
        const rel = relative(root, abs).split(sep).join('/');
        const target = hasSlash ? rel : rel.split('/').pop();
        if (re.test(target)) out.push(displayPath(ctx, abs));
      });
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
  const key = `openai|${names.join(',')}|${extraTools.map(objId).join(',')}`;
  let hit = schemaCache.get(key);
  if (!hit) { hit = pickTools(names, extraTools).map((t) => converted(t).openai); schemaCache.set(key, hit); }
  return hit;
}

/** Anthropic Messages 形状（input_schema 而非 parameters） */
export function anthropicToolSchemas(names, extraTools = []) {
  const key = `anthropic|${names.join(',')}|${extraTools.map(objId).join(',')}`;
  let hit = schemaCache.get(key);
  if (!hit) { hit = pickTools(names, extraTools).map((t) => converted(t).anthropic); schemaCache.set(key, hit); }
  return hit;
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
