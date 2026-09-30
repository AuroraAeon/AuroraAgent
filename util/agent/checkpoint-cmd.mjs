/**
 * 终端 /checkpoint 家族命令的纯函数层（与网页「回滚到此」同源同语义）：
 * 解析子命令、把检查点格式化成可读行、造回滚前的 diff 预览。
 * 终端 REPL 与测试直接 import 同一份，颜色由调用方按需上色
 * （util/tui/theme.mjs 是唯一允许原始 SGR 的文件）。
 *
 * 子命令：
 *   /checkpoint                        列出当前会话的检查点
 *   /checkpoint restore <轮次> [chat]  回滚工作区到那一轮；带 chat 连对话一起裁
 *   /checkpoint diff <轮次>            预览那一轮之后动过哪些文件
 *   /checkpoint clean                  清掉当前会话的全部检查点
 *
 * restore 默认只动工作区不动对话：对话往往正是最有价值的产物，代码回滚后可以换个
 * 思路重来，把历史一起删掉通常是误操作。
 */
import { filesTouchedAfter, trimRecordsToTurn } from './checkpoint-restore.mjs';

/**
 * 解析 /checkpoint 参数。
 * @returns {{ action:'list' } | { action:'restore', turnIndex, withChat }
 *          | { action:'diff', turnIndex } | { action:'clean' }
 *          | { action:'error', message: string }}
 */
export function parseCheckpointArg(raw) {
  const text = String(raw || '').trim();
  if (!text) return { action: 'list' };
  const m = /^(\S+)(?:\s+(.*))?$/.exec(text);
  const sub = (m?.[1] || '').toLowerCase();
  const rest = String(m?.[2] || '').trim();
  if (sub === 'list' || sub === 'ls') return { action: 'list' };
  if (sub === 'clean' || sub === 'clear') return { action: 'clean' };
  if (sub === 'restore' || sub === 'diff') {
    const parts = rest.split(/\s+/).filter(Boolean);
    const n = Number(parts[0]);
    if (!parts.length || !Number.isInteger(n) || n < 1) {
      return { action: 'error', message: `用法: /checkpoint ${sub} <轮次>${sub === 'restore' ? ' [chat]' : ''}（轮次是正整数）` };
    }
    if (sub === 'diff') return { action: 'diff', turnIndex: n };
    return { action: 'restore', turnIndex: n, withChat: parts.slice(1).some((w) => w.toLowerCase() === 'chat') };
  }
  return { action: 'error', message: `未知子命令「${sub}」：/checkpoint [list|restore <轮次> [chat]|diff <轮次>|clean]` };
}

/** 单个检查点 → 单行展示（轮次 + 方式 + 时间 + 说明） */
export function formatCheckpointLine(entry, now = Date.now()) {
  const when = entry.at ? new Date(entry.at).toLocaleString('zh-CN', { hour12: false }) : '—';
  const how = entry.kind === 'git' ? 'git' : '内容镜像';
  const note = entry.note ? ` · ${entry.note}` : '';
  return `第 ${entry.turnIndex} 轮 · ${how} · ${when}${note}`;
}

/** 检查点清单 → 展示行（按轮次倒序，新的在前）；空清单给可操作提示 */
export function formatCheckpointLines(entries, now = Date.now()) {
  const list = (entries || []).slice().sort((a, b) => b.turnIndex - a.turnIndex);
  if (!list.length) return ['当前会话还没有检查点：每一轮用户发言开始时自动拍一张'];
  return list.map((e) => formatCheckpointLine(e, now));
}

/** diff 预览：某一轮之后动过的文件清单（回滚前先让用户看见会动什么） */
export function formatCheckpointDiffLines(records, turnIndex, entries) {
  const hit = (entries || []).some((e) => e.turnIndex === turnIndex);
  if (!hit) return [`第 ${turnIndex} 轮没有检查点，无从预览`];
  const files = filesTouchedAfter(records, turnIndex);
  const { trimmed } = trimRecordsToTurn(records, turnIndex);
  const lines = [`回滚到第 ${turnIndex} 轮会动这些文件：`];
  if (files.length) lines.push(...files.map((f) => `  ${f}`));
  else lines.push('  （这一轮之后没有文件被改动）');
  lines.push(`对话记录将保留（裁掉 ${trimmed} 条之后的记录需显式带 chat）`);
  return lines;
}
