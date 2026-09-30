/**
 * Hook 事件词表与 payload 构造（源头 Cline 的 hooks/events.ts，按本地单用户场景精简）：
 * 十个事件覆盖「用户提交 → turn 生命周期 → 模型轮 → 工具前后 → 压缩 → 收尾」全链路，
 * 每个事件的 payload 都是可 JSON 序列化的纯数据（子进程经 stdin 收它、经 stdout 回 HookControl）。
 */

/** 十个 hook 事件名（文件名即事件名，大小写与下划线不敏感：PreToolUse.sh 与 pre_tool_use.mjs 等价） */
export const HOOK_EVENTS = [
  'prompt_submit',    // 用户提交（可改写输入 / 追加上下文）
  'turn_start',       // turn 开始
  'round_start',      // 模型轮开始
  'pre_tool_use',     // 工具执行前（可 cancel / review / 改写参数）
  'post_tool_use',    // 工具执行后（可追加上下文）
  'pre_compact',      // 上下文压缩前（可取消本轮压缩）
  'turn_end',         // turn 正常结束
  'turn_error',       // turn 失败
  'turn_abort',       // 用户中止
  'session_shutdown', // 进程退出
];

/** 事件名归一：小写 + 去掉所有非字母数字（PreToolUse / pre_tool_use / pre-tool-use → pretooluse） */
export function normalizeEventName(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

const EVENT_LOOKUP = new Map(HOOK_EVENTS.map((e) => [normalizeEventName(e), e]));

/** 文件名（去扩展名）→ 事件名；不是已知事件给 null */
export function eventFromFileName(fileName) {
  const base = String(fileName || '').replace(/\.[^./]+$/, '');
  return EVENT_LOOKUP.get(normalizeEventName(base)) || null;
}

/**
 * 造一份事件 payload。公共字段（会话 / 轮次 / 工作目录 / 时间）所有事件都有，
 * 事件专属数据按名挂在固定键上——hook 脚本按 `hookName` 分流即可，不必猜结构。
 */
export function buildPayload(event, base = {}, extra = {}) {
  return {
    hookName: event,
    timestamp: new Date().toISOString(),
    sessionId: String(base.sessionId || ''),
    turnId: String(base.turnId || ''),
    round: Number(base.round || 0),
    workspace: String(base.workspace || ''),
    agentId: String(base.agentId || ''),
    parentAgentId: base.parentAgentId ? String(base.parentAgentId) : null,
    ...extra,
  };
}
