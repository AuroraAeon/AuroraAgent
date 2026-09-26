/**
 * Agent 工具集：六个内置工具，全部经 JSON Schema 描述参数。
 * 安全边界（v1，文档如实说明）：文件工具经 resolveInside 禁锢在会话工作目录；
 * shell 以工作目录为 cwd 执行、带超时与输出截断，但无 OS 级沙箱——
 * 真正的门控是 policy.mjs 的权限决策与前端确认流。
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, sep, dirname } from 'node:path';
import { toOpenAIFunction, toAnthropicTool } from '../llm/tool.mjs';
import { findSkill } from './skills.mjs';

const MAX_OUTPUT = 32 * 1024;   // 单次工具回给模型的文本上限
const MAX_FETCH = 64 * 1024;    // web_fetch 正文上限
const MAX_ENTRIES = 500;        // list_dir 条数上限

export class ToolError extends Error {
  constructor(message, code = 'tool_error') {
    super(message);
    this.code = code;
  }
}

/** 把用户/模型给的路径解析到工作目录内，越界即拒（防 .. 穿越与绝对路径逃逸） */
export function resolveInside(root, p) {
  const abs = resolve(root, String(p || ''));
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new ToolError(`路径越界：${p} 不在工作目录内（文件工具只能访问工作目录）`, 'path_escape');
  }
  return abs;
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
      const abs = resolveInside(ctx.workspace, args.path);
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
      const abs = resolveInside(ctx.workspace, args.path || '.');
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
      return `已替换 ${args.path} 中 ${args.replace_all ? count : 1} 处`;
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
    async run(args) {
      const url = String(args.url ?? '');
      if (!/^https?:\/\//i.test(url)) throw new ToolError('只支持 http/https URL', 'bad_args');
      let resp;
      try {
        resp = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'follow' });
      } catch (e) { throw new ToolError(`抓取失败：${e.message}`, 'fetch_error'); }
      const text = await resp.text();
      return truncate(`HTTP ${resp.status} ${url}\n${text}`, MAX_FETCH);
    },
  },

  {
    name: 'skill',
    description: '加载一个技能的完整指令。当用户请求与系统提示技能目录里某个技能的描述匹配时调用；返回的文本是本次任务必须遵循的规范',
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
      return `[技能：${skill.name}]\n${skill.body}\n[技能结束]\n请按照上述技能规范处理用户请求。`;
    },
  },
];
export function getTool(name) {
  return TOOLS.find((t) => t.name === String(name || '')) || null;
}

/** OpenAI function calling 形状的 tools 参数 */
export function toolSchemas(names) {
  const picked = names.length ? TOOLS.filter((t) => names.includes(t.name)) : [];
  return picked.map((t) => toOpenAIFunction(t));
}

/** Anthropic Messages 形状（input_schema 而非 parameters） */
export function anthropicToolSchemas(names) {
  const picked = names.length ? TOOLS.filter((t) => names.includes(t.name)) : [];
  return picked.map((t) => toAnthropicTool(t));
}

/** 权限判定的资源标识：文件类取路径，shell 取命令，web_fetch 取 URL */
export function toolResource(name, args) {
  const a = args || {};
  if (name === 'shell') return String(a.command || '');
  if (name === 'web_fetch') return String(a.url || '');
  return String(a.path || '');
}
