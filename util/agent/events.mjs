/**
 * Agent 事件协议：运行时与客户端（网页 SSE / 终端 / 测试）之间的唯一事实通道。
 * 事件集是 OpenBitFun AgenticEvent 的精简子集：一个事件一个类型，平铺 JSON 形状。
 * SSE 帧格式：`event: <type>\ndata: <json>\n\n`；终端与测试直接消费事件对象。
 */

/** 全部事件类型（前端 switch 与测试断言共享这份清单） */
export const EVENT_TYPES = [
  'session_created',
  'session_renamed',
  'turn_started',
  'model_round_started',
  'text_chunk',
  'thinking_chunk',
  'tool_event',
  'plan_proposed',
  'plan_approved',
  'plan_rejected',
  'provider_switched',
  'token_usage_updated',
  'context_compression_started',
  'context_compression_completed',
  'context_compression_failed',
  'goal_created',
  'goal_status_changed',
  'goal_usage_updated',
  'goal_wait_changed',
  'goal_cleared',
  'turn_completed',
  'turn_cancelled',
  'turn_failed',
];

/** 工具事件阶段：权限确认走 tool_event(confirmation_needed)，决策经 POST /api/agent/permission 回传 */
export const TOOL_EVENT_PHASES = [
  'started',
  'confirmation_needed',
  'confirmed',
  'rejected',
  'completed',
  'failed',
];

/** 构造一个事件对象（type 字段打头，负载平铺） */
export function agentEvent(type, payload = {}) {
  if (!EVENT_TYPES.includes(type)) throw new Error(`未知事件类型: ${type}`);
  return { type, ...payload };
}

/** 序列化为 SSE 帧 */
export function sseFrame(type, payload = {}) {
  return `event: ${type}\ndata: ${JSON.stringify(agentEvent(type, payload))}\n\n`;
}
