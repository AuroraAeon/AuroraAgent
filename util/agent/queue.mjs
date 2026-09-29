/**
 * 会话消息队列（本地化 OpenBitFun v1.0.2 #3212 / #3220）：
 * 一个会话同时只有一个活跃 turn；活跃期间客户端仍可继续提交，提交进 FIFO 队列等待，
 * 前一条结算后由泵自动接力下一条——不再回 409 把用户挡在门外，也不丢消息。
 *
 * 形态：
 *  - 每会话一条 FIFO；项 = { opId, text, state, at, body }，body 是原始 turn 请求
 *    （泵接力时原样重放，用户当时选的模型 / 权限档 / 思考开关都还在）。
 *  - opId 由客户端生成（提交幂等键）：重复 opId 返回同一条回执，不重复入队、不开第二条流。
 *  - 落盘 <数据目录>/queue.json（临时文件 + rename 原子写）；损坏按空队列处理并告警，
 *    永不因为队列文件坏掉挡住用户发言。
 *  - 重启恢复：running（进程被杀在半路）回落 queued 由泵重跑，held（用户显式挂起）原样保留。
 *  - 只持久化 queued / running / held 三态；done / failed 是内存里的终态，落盘前剪掉。
 *
 * 侧边对话（/btw）不入队：它不落盘、不接管 goal，与主对话的互斥语义保持 409 原样。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const QUEUE_STATES = ['queued', 'running', 'held', 'done', 'failed'];
const LIVE_STATES = ['queued', 'running', 'held'];
const MAX_ITEMS = 200;

/** 生成 opId：客户端可自带（幂等键），没带则服务端补一个 */
export function newOpId() { return randomUUID(); }

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const opId = String(raw.opId || '').trim();
  const text = String(raw.text || '').trim();
  if (!opId || !text) return null;
  const state = LIVE_STATES.includes(raw.state) ? raw.state : 'queued';
  return {
    opId,
    sessionId: String(raw.sessionId || '').trim(),
    text,
    state,
    at: Number.isFinite(raw.at) ? Number(raw.at) : Date.now(),
    body: raw.body && typeof raw.body === 'object' ? raw.body : {},
  };
}

export class TurnQueue {
  constructor(dataDir, { warn = () => {} } = {}) {
    this.file = join(dataDir, 'queue.json');
    this.warn = warn;
    /** sessionId -> item[]（内存为权威视图，落盘只是崩溃恢复用） */
    this.bySession = new Map();
    this.#load();
  }

  #load() {
    let rows = [];
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      rows = Array.isArray(j.items) ? j.items : [];
    } catch { rows = []; }
    for (const raw of rows) {
      const item = normalizeItem(raw);
      if (!item) continue;
      // 进程被杀在半路：running 回落 queued 由泵重跑；held 是用户显式挂起，原样保留
      if (item.state === 'running') item.state = 'queued';
      const list = this.bySession.get(item.sessionId) || [];
      list.push(item);
      this.bySession.set(item.sessionId, list);
    }
  }

  #flush() {
    const items = [];
    for (const list of this.bySession.values()) {
      for (const item of list) if (LIVE_STATES.includes(item.state)) items.push(item);
    }
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2));
      renameSync(tmp, this.file);
    } catch (e) {
      this.warn('queue 落盘失败（不影响本次入队）', { error: String(e) });
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    }
  }

  #raw(sessionId) { return this.bySession.get(String(sessionId || '')) || []; }

  /** 某会话队列（queued / running / held，按入队序）；终态项不出现——跑完即从视图清空 */
  list(sessionId) {
    return this.#raw(sessionId).filter((i) => LIVE_STATES.includes(i.state));
  }

  /** 有没有待跑的项（queued；held 不算——它要用户显式 promote） */
  hasPending(sessionId) {
    return this.list(sessionId).some((i) => i.state === 'queued');
  }

  find(sessionId, opId) {
    return this.#raw(sessionId).find((i) => i.opId === String(opId || '')) || null;
  }

  /**
   * 入队。opId 已存在时返回既有项（幂等：不重复执行、不开第二条流）。
   * @returns {{ item, position, duplicate: boolean }}
   */
  enqueue(sessionId, { opId, text, body }) {
    const sid = String(sessionId || '');
    const list = this.#raw(sid);
    const exist = list.find((i) => i.opId === String(opId || ''));
    if (exist) return { item: exist, position: list.indexOf(exist) + 1, duplicate: true };
    const item = normalizeItem({ opId: opId || newOpId(), sessionId: sid, text, state: 'queued', at: Date.now(), body });
    if (!item) return null;
    list.push(item);
    // 队列封顶：挤掉最旧的已终态项，仍超限则拒绝（本地单用户工具，正常远到不了）
    while (list.length > MAX_ITEMS) list.shift();
    this.bySession.set(sid, list);
    this.#flush();
    return { item, position: list.length, duplicate: false };
  }

  /** 摘牌下一条 queued 项并标记 running；没有返回 null */
  shift(sessionId) {
    const sid = String(sessionId || '');
    const list = this.#raw(sid);
    const next = list.find((i) => i.state === 'queued');
    if (!next) return null;
    next.state = 'running';
    this.#flush();
    return next;
  }

  /** 结算：终态项从持久视图里剪掉（done / failed 只活在内存，供回执查询） */
  finish(sessionId, opId, state = 'done') {
    const sid = String(sessionId || '');
    const list = this.#raw(sid);
    const item = list.find((i) => i.opId === String(opId || ''));
    if (item) item.state = QUEUE_STATES.includes(state) ? state : 'done';
    this.#flush();
    return item || null;
  }

  /** 移出一项（客户端取消等待中的消息） */
  remove(sessionId, opId) {
    const sid = String(sessionId || '');
    const list = this.#raw(sid);
    const idx = list.findIndex((i) => i.opId === String(opId || ''));
    if (idx < 0) return false;
    list.splice(idx, 1);
    this.#flush();
    return true;
  }

  /** 立即发送：把选中项挪到队首（下一个就被泵接走） */
  promote(sessionId, opId) {
    const sid = String(sessionId || '');
    const list = this.bySession.get(sid) || [];
    const idx = list.findIndex((i) => i.opId === String(opId || ''));
    if (idx < 0) return null;
    const [item] = list.splice(idx, 1);
    item.state = 'queued';
    list.unshift(item);
    this.#flush();
    return item;
  }

  /** 显式挂起 / 恢复 */
  setState(sessionId, opId, state) {
    const sid = String(sessionId || '');
    const list = this.bySession.get(sid) || [];
    const item = list.find((i) => i.opId === String(opId || ''));
    if (!item || !QUEUE_STATES.includes(state)) return null;
    item.state = state;
    this.#flush();
    return item;
  }
}
