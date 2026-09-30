/**
 * 定时任务事件总线：把 jobs.json 的变更（cron 工具增删改 / REST 增删改 / 到期运行记账）
 * 扇出给全部订阅者——对齐 OpenBitFun v1.0.2 的 change signal：修掉「建了任务但界面不重读」
 * 这类同一份数据两处各画一套的毛病。
 *
 * 订阅方两类：
 *  - GET /api/jobs/events 的 SSE 长连接（设置面板 / 终端常驻）；
 *  - 进行中的 turn SSE（模型本轮刚用 cron 工具改了任务，客户端要即时看到）。
 *
 * 进程内极简实现：零依赖、无队列。单个订阅写失败（连接已断）不影响其他订阅。
 * 任务按 sessionId 归属，但任务列表是全量的——订阅不带过滤，由前端自己筛当前会话。
 */
import { sseFrame } from '../agent/events.mjs';

/** Set<write>（write: (frame: string) => void） */
const channels = new Set();

/**
 * 订阅任务变更流。回调签名 (frame, payload)：frame 是可直接写出的 SSE 帧，
 * payload 是同一份负载——turn SSE 只需要「变了」这个信号，自己按 EVENT_TYPES 重新封帧。
 * @returns 取消订阅函数（幂等，SSE 关闭时必须调用防泄漏）
 */
export function subscribeJobEvents(write) {
  channels.add(write);
  return () => { channels.delete(write); };
}

/** 广播一帧 jobs_changed；无订阅者时静默丢弃（本地工具无常驻连接也正确） */
export function publishJobEvent(payload = {}) {
  if (channels.size === 0) return;
  let frame;
  try { frame = sseFrame('jobs_changed', payload); }
  catch { return; } // 未知事件类型：绝不让总线拖垮调用方
  for (const write of [...channels]) {
    try { write(frame, payload); } catch { /* 单订阅写失败不影响其他订阅 */ }
  }
}

/** 当前订阅连接数（测试与诊断用） */
export function jobEventSubscriberCount() { return channels.size; }
