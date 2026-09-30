/** 定时任务变更流（GET /api/jobs/events）：cron 工具 / REST / 到期记账都经 util/jobs/bus.mjs 推一帧
 *  jobs_changed，客户端据此重读列表——对齐 OpenBitFun v1.0.2 的 change signal，
 *  修掉「建了任务但界面不重读」这类同一份数据两处各画一套的毛病。
 *  与 goal-events.ts 同构：EventSource 自动重连，卸载时必须 close（泄漏的连接会随会话累积）。 */
export function connectJobEvents(onChange: () => void): () => void {
  const es = new EventSource('/api/jobs/events');
  es.addEventListener('jobs_changed', () => onChange());
  return () => es.close();
}
