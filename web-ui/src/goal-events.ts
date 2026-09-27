/**
 * 跨客户端 goal 事件流：另一客户端（终端 / 另一标签页）经 REST 改动目标时，本地横幅与状态
 * 即时校正，而非等到下次切会话才刷新（对齐 MiniMax goal-flow.project 的全局事件投影）。
 * turn 内的 goal 事件仍走 turn SSE，不经此处——两条通道载荷同源、消费等价。
 */
import type { AgentEvent } from './types';

/** 事件流覆盖的五类 goal 事件（与 util/agent/events.mjs 白名单一致） */
export type GoalStreamEvent = Extract<AgentEvent, { type: 'goal_created' | 'goal_status_changed' | 'goal_usage_updated' | 'goal_wait_changed' }>
  | Extract<AgentEvent, { type: 'goal_cleared' }>;

const GOAL_EVENT_TYPES = ['goal_created', 'goal_status_changed', 'goal_usage_updated', 'goal_wait_changed', 'goal_cleared'] as const;

/**
 * 订阅某会话的 goal 事件流。
 * @param onEvent 事件回调（已按会话归属过滤）
 * @returns 关闭连接的函数（切会话 / 组件卸载时必须调用，防止连接累积）
 */
export function connectGoalEvents(sessionId: string, onEvent: (ev: GoalStreamEvent) => void): () => void {
  const es = new EventSource(`/api/agent/events?sessionId=${encodeURIComponent(sessionId)}`);
  const handler = (ev: MessageEvent) => {
    try {
      const data = JSON.parse(ev.data) as GoalStreamEvent;
      // 服务端已按会话过滤，这里再防一道：迟到的帧不投射到已切走的会话
      if (data.sessionId && data.sessionId !== sessionId) return;
      onEvent(data);
    } catch { /* 坏帧跳过（含订阅时的注释帧） */ }
  };
  for (const t of GOAL_EVENT_TYPES) es.addEventListener(t, handler);
  return () => es.close();
}
