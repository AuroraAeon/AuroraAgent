/**
 * 终端 /hooks 家族命令的纯函数层（与网页 GET /api/agent/hooks 同源同语义）：
 * 解析子命令、把已发现的钩子格式化成可读行。终端 REPL 与测试直接 import 同一份，
 * 颜色由调用方按需上色（util/tui/theme.mjs 是唯一允许原始 SGR 的文件）。
 *
 * 子命令：
 *   /hooks                      列出当前工作目录下已发现的钩子与门控状态
 *   /hooks test <事件名>        手动触发一次该事件（验证脚本写得对不对，不跑真 turn）
 *   /hooks events               列出全部十个事件名
 *
 * 钩子是实验特性（AURORAAGENT_EXPERIMENTAL_HOOKS=1）：门控关闭时列表给一句开启指引，
 * 而不是空列表——用户分不清「没配钩子」和「钩子被关掉了」。
 */
import { HOOK_EVENTS } from './hooks/events.mjs';

/**
 * 解析 /hooks 参数。
 * @returns {{ action:'list' } | { action:'events' } | { action:'test', event: string }
 *          | { action:'error', message: string }}
 */
export function parseHooksArg(raw) {
  const text = String(raw || '').trim();
  if (!text) return { action: 'list' };
  const m = /^(\S+)(?:\s+(.*))?$/.exec(text);
  const sub = (m?.[1] || '').toLowerCase();
  if (sub === 'list' || sub === 'ls') return { action: 'list' };
  if (sub === 'events') return { action: 'events' };
  if (sub === 'test') {
    const want = String(m?.[2] || '').trim();
    if (!want) return { action: 'error', message: '用法: /hooks test <事件名>（如 /hooks test pre_tool_use）' };
    const norm = want.toLowerCase().replace(/[^a-z0-9]/g, '');
    const hit = HOOK_EVENTS.find((e) => e.replace(/_/g, '') === norm);
    if (!hit) return { action: 'error', message: `未知事件「${want}」：可用 ${HOOK_EVENTS.join(' / ')}` };
    return { action: 'test', event: hit };
  }
  return { action: 'error', message: `未知子命令「${sub}」：/hooks [list|events|test <事件名>]` };
}

/** 单个钩子 → 单行展示（事件 + 来源 + 路径） */
export function formatHookLine(hook) {
  const src = hook.source === 'workspace' ? '项目' : '个人';
  return `${hook.event} · ${src} · ${hook.path}`;
}

/**
 * 钩子清单 → 展示行。门控关闭时给开启指引（区别于「没配钩子」）。
 * @param {{ enabled: boolean, hooks: Array<{event, path, source}> }} state
 */
export function formatHookLines(state) {
  if (!state?.enabled) return ['钩子未开启：设置 AURORAAGENT_EXPERIMENTAL_HOOKS=1 后重启（钩子目录：<数据目录>/hooks/ 与 <工作目录>/.auroraagent/hooks/）'];
  if (!state.hooks?.length) return ['尚未发现钩子：把脚本命名为 <事件名>.sh 或 <事件名>.mjs 放进 <数据目录>/hooks/ 或 <工作目录>/.auroraagent/hooks/ 即生效'];
  return state.hooks.map(formatHookLine);
}

/** 全部事件名 → 展示行（含一句话语义） */
export function formatHookEventLines() {
  const notes = {
    prompt_submit: '用户提交（可改写输入 / 取消这个 turn）',
    turn_start: 'turn 开始',
    round_start: '模型轮开始（可跳过本轮）',
    pre_tool_use: '工具执行前（可取消 / 转人工复核 / 改参数）',
    post_tool_use: '工具执行后（只追加上下文）',
    pre_compact: '上下文压缩前（可取消本轮压缩）',
    turn_end: 'turn 正常结束',
    turn_error: 'turn 失败',
    turn_abort: '用户中止',
    session_shutdown: '进程退出（无自动接入点，仅供手动触发）',
  };
  return HOOK_EVENTS.map((e) => `${e} — ${notes[e] || ''}`);
}

/** 手动触发的结果 → 展示行（合并后的控制 + 每个脚本的执行情况） */
export function formatHookTestLines(event, outcome) {
  const lines = [`触发 ${event}：${outcome.fired} 个钩子`];
  const flags = [];
  if (outcome.cancel) flags.push('cancel');
  if (outcome.review) flags.push('review');
  if (outcome.overrideInput !== undefined) flags.push('overrideInput');
  if (outcome.context) flags.push(`context ${outcome.context.length} 字`);
  if (outcome.systemPrompt) flags.push(`systemPrompt ${outcome.systemPrompt.length} 字`);
  lines.push(`  合并控制：${flags.length ? flags.join(' / ') : '（无）'}`);
  for (const l of outcome.logs || []) {
    lines.push(`  ${l.ok ? '✓' : '✗'} ${l.path}${l.error ? ` — ${l.error}` : ''}（${l.ms}ms）`);
  }
  return lines;
}
