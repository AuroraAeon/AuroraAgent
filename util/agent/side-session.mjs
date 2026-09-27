/**
 * 侧边对话（/btw）：一问一答的临时会话——带着主会话的历史前缀开聊，但不落盘、不进 /sessions。
 * 形态是 SessionStore 的内存门面（append / patch / get / records / replaceRecords 同签名），
 * 直接喂给 loop.mjs；create 不存在——子代理派发在侧边对话里被禁用（见终端侧 goalStore/tools
 * 裁剪），避免临时会话派生真实子会话。侧边会话不接管 goal（goalStore 传 null），
 * 也不改主会话的 turns / 标题 / 用量汇总：主会话存储零污染。
 */
import { randomUUID } from 'node:crypto';

/**
 * 取「完整前缀」：截至最后一个「无悬空工具调用」的自洽点——tool_call 必须有配对
 * tool_result，否则它之后的记录整组剔除（中断轮次的残骸不进侧边上下文，也不以
 * 残缺形态进请求）。并行调用只完成其一时整轮都不自洽，从前序边界截断。
 */
export function completePrefix(records) {
  const list = Array.isArray(records) ? records : [];
  const open = new Set();
  let safeEnd = 0; // 空前缀始终合法（保守兜底）
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r && typeof r === 'object' && r.t === 'tool_call') open.add(r.id);
    else if (r && typeof r === 'object' && r.t === 'tool_result') open.delete(r.id);
    if (open.size === 0) safeEnd = i + 1;
  }
  return list.slice(0, safeEnd);
}

export class SideSession {
  /** @param main 主会话 meta（快照复制：模型 / 模式 / 工作目录 / 权限规则随之继承） */
  constructor(main, { prefix = [] } = {}) {
    this.id = `btw-${randomUUID()}`;
    this.meta = {
      ...main, id: this.id, name: '侧边对话', turns: 0,
      inputTokens: 0, outputTokens: 0, cost: 0, todos: [], preview: '',
    };
    this.items = completePrefix(prefix);
  }

  append(_id, rec) { this.items.push(rec); return rec; }
  patch(_id, fields) { Object.assign(this.meta, fields || {}); return this.meta; }
  get(_id) { return { meta: this.meta, records: this.items.slice() }; }
  records(_id) { return this.items.slice(); }
  replaceRecords(_id, next) { this.items = Array.isArray(next) ? next.slice() : []; }
  /** 侧边会话不进会话列表 */
  list() { return []; }
  /** 侧边对话不派发子代理（无真实子会话可查） */
  create() { throw new Error('侧边对话不派发子代理：请回到主对话再使用 task 工具'); }
}
