/**
 * Goal 事件总线：把 REST 面的目标变更（create / edit / clear / pause·resume·stop / budget）
 * 扇出给订阅了同一会话的 SSE 客户端——对齐 MiniMax 的全局事件投影（thread_goal.updated），
 * 让「另一客户端（终端 / 另一标签页）刚改过目标」即时可见，而非等到下次切会话才刷新。
 *
 * 进程内极简实现：零依赖、无队列、无守护进程。订阅按 sessionId 过滤；单个订阅写失败
 * （连接已断）不影响其他订阅。turn 内的 goal 事件仍走 turn SSE，不经此处。
 */
import { sseFrame } from '../events.mjs';

/** sessionId -> Set<write>（write: (frame: string) => void） */
const channels = new Map();

/**
 * 订阅某会话的 goal 事件流。
 * @returns 取消订阅函数（幂等；SSE 连接关闭时必须调用，防止泄漏）
 */
export function subscribeGoalEvents(sessionId, write) {
  const key = String(sessionId || '');
  let set = channels.get(key);
  if (!set) { set = new Set(); channels.set(key, set); }
  set.add(write);
  return () => {
    const cur = channels.get(key);
    if (!cur) return;
    cur.delete(write);
    if (cur.size === 0) channels.delete(key);
  };
}

/** 向订阅了该会话的客户端发布一帧；无订阅者时静默丢弃（本地工具无常驻连接也正确） */
export function publishGoalEvent(sessionId, type, payload = {}) {
  const set = channels.get(String(sessionId || ''));
  if (!set || set.size === 0) return;
  let frame;
  try {
    frame = sseFrame(type, { sessionId, ...payload });
  } catch { return; } // 未知事件类型：绝不让总线拖垮调用方（REST 路由）
  for (const write of set) {
    try { write(frame); } catch { /* 单订阅写失败不影响其他订阅 */ }
  }
}

/** 当前订阅连接数（测试与诊断用） */
export function goalEventSubscriberCount(sessionId) {
  const set = channels.get(String(sessionId || ''));
  return set ? set.size : 0;
}
