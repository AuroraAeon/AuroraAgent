/**
 * Agent 会话存储：每个会话两个文件，放在 <数据目录>/sessions/ 下：
 *   <id>.meta.json   元信息（模型 / 模式 / 工作目录 / 用量汇总），临时文件 + rename 原子落盘
 *   <id>.jsonl       追加式转录（user / assistant / thinking / tool_call / tool_result / summary / usage）
 * 投影（可见历史）由 jsonl 逐行重建，坏行跳过——与 usage.mjs 的容错读取同构。
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { writeFileAtomic } from '../atomic.mjs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_HARNESS } from './harness.mjs';
import { DEFAULT_PERMISSION_MODE, PERMISSION_MODES, TITLE_MODES, DEFAULT_TITLE_MODE } from '../config.mjs';

const META_SUFFIX = '.meta.json';

/** 新建会话的默认名：仍是这个名字时，首条消息可自动总结出标题（title.mjs） */
export const DEFAULT_SESSION_NAME = '新会话';

export class SessionStore {
  #recordsCache = new Map();
  // 转录末条 id（tip）内存表：append 要给它挂 parent，又不能每次读全文件（O(n²)）。
  // 写入口全部在本进程内（web / 终端各写各的会话），内存态即真值；replaceRecords / fork / remove 同步维护（p1-1 会话树）
  #tips = new Map();

  constructor(dataDir, { warn = () => {}, onChange = null } = {}) {
    this.dir = join(dataDir, 'sessions');
    this.defaultWorkspace = join(dataDir, 'workspace');
    this.warn = warn;
    // 写入观察者：会话全文检索索引（util/search/index.mjs）借此增量更新，
    // 不必在每次搜索时重读全部转录。传 null 时零开销（终端客户端就是这么用的）
    this.onChange = typeof onChange === 'function' ? onChange : null;
    try { mkdirSync(this.dir, { recursive: true }); } catch (e) { this.warn('sessions 目录创建失败', { error: String(e) }); }
  }

  /** 新建会话；workspace 缺省为 <数据目录>/workspace，允许指定其他绝对路径 */
  create({ name = '', model = '', provider = '', harness = DEFAULT_HARNESS, workspace = '', permissionMode = '', planMode = false, titleMode = '', thinking = true } = {}) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const meta = {
      id,
      name: name || DEFAULT_SESSION_NAME,
      model,
      provider,
      harness,
      workspace: workspace ? resolve(workspace) : this.defaultWorkspace,
      createdAt: now,
      updatedAt: now,
      turns: 0,
      rules: [],
      permissionMode: PERMISSION_MODES.includes(permissionMode) ? permissionMode : DEFAULT_PERMISSION_MODE,
      planMode: planMode === true,
      titleMode: TITLE_MODES.includes(titleMode) ? titleMode : DEFAULT_TITLE_MODE,
      thinking: thinking !== false,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
    this.#writeMeta(meta);
    this.#notify('create', meta.id, meta);
    return meta;
  }

  #notify(type, id, payload) { if (this.onChange) this.onChange({ type, id, ...payload }); }

  /** 全部会话元信息，按更新时间倒序 */
  list() {
    let files = [];
    try { files = readdirSync(this.dir); } catch { return []; }
    const rows = [];
    for (const f of files) {
      if (!f.endsWith(META_SUFFIX)) continue;
      try { rows.push(JSON.parse(readFileSync(join(this.dir, f), 'utf8'))); } catch {}
    }
    return rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  get(id) {
    const meta = this.#readMeta(String(id || ''));
    if (!meta) return null;
    return { meta, records: this.records(id) };
  }

  /**
   * 逐行读转录，坏行跳过。
   * 缓存按 (mtimeMs, size) 失效：写路径（append / replaceRecords）必然改动 size，
   * 因此不会服务陈旧数据。命中时返回浅拷贝——调用方（loop.mjs）会 push 返回数组，
   * 直接给出缓存引用会把调用方的追加写回缓存里。
   */
  records(id) {
    const sid = String(id || '');
    const path = join(this.dir, `${sid}.jsonl`);
    let st;
    try { st = statSync(path); } catch { this.#recordsCache.delete(sid); return []; }
    const hit = this.#recordsCache.get(sid);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.records.slice();
    let records = [];
    try {
      records = readFileSync(path, 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
    this.#recordsCache.set(sid, { mtimeMs: st.mtimeMs, size: st.size, records });
    return records.slice();
  }

  /**
   * 追加一条转录记录；写失败只告警不打断（与 usage.mjs 同策略）。
   * p1-1 会话树：每条记录落稳定 id（rid）与 parent（上一条 rid，首条 / 老转录为 null）——缺省即成线性链，
   * 向后兼容旧文件。rid 不复用记录自身的 id 字段（tool_call 记录的 id 是模型调用 id，另有语义）。
   */
  append(id, record) {
    this.#recordsCache.delete(String(id || ''));
    try {
      const sid = String(id || '');
      const rid = randomUUID();
      const parent = this.#tipOf(sid);
      appendFileSync(join(this.dir, `${sid}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), rid, parent, ...record })}\n`);
      this.#tips.set(sid, rid);
      this.#notify('append', id, { record });
    } catch (e) { this.warn('会话转录写入失败', { id, error: String(e) }); }
  }

  /** 转录末条 rid：内存命中即返，否则读盘重建一次（老文件的记录没有 rid → null，之后新记录线性接续） */
  #tipOf(id) {
    const sid = String(id || '');
    if (this.#tips.has(sid)) return this.#tips.get(sid);
    const records = this.records(sid);
    const tip = records.length ? records[records.length - 1].rid || null : null;
    this.#tips.set(sid, tip);
    return tip;
  }

  /** 整体重写转录（上下文压缩后：早期记录折叠为一条 summary），临时文件 + rename 原子落盘 */
  replaceRecords(id, records) {
    const sid = String(id || '');
    this.#recordsCache.delete(sid);
    try {
      const p = join(this.dir, `${sid}.jsonl`);
      writeFileAtomic(p, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '')); // tmp + fsync + rename + 0600
      this.#tips.set(sid, records.length ? records[records.length - 1].rid || null : null);
      this.#notify('replace', sid, { records });
      return true;
    } catch (e) { this.warn('会话转录重写失败', { id: sid, error: String(e) }); return false; }
  }

  /** 合并更新元信息（用量累计 / 改名 / 切模型 / 权限规则），原子落盘 */
  patch(id, changes) {
    const meta = this.#readMeta(String(id || ''));
    if (!meta) return null;
    const next = { ...meta, ...changes, id: meta.id, updatedAt: new Date().toISOString() };
    this.#writeMeta(next);
    this.#notify('patch', next.id, { changes, meta: next });
    return next;
  }

  /**
   * 派生会话：把 meta 与全部转录复制到新会话（新 id、新时间戳、名字加「副本」后缀）。
   * 不复制 goal（目标按会话隔离，新会话从零开始）；用量汇总随转录一并保留——历史开销真实发生过。
   * 返回新 meta；源会话不存在返回 null。
   *
   * p1-1 会话树：传 { from } 时不再是整卷复制，而是「从任意条目拉分支」——只复制到该条为止的前缀
   * （from 是 1-based 序号或记录 rid），名字加「（分支）」后缀，meta 记 forkedFrom 出处。
   * 分支点前的 rid / parent 链原样保留（祖先可溯），分支点后的记录不与新村混合。from 越界 / 查无此条抛中文 Error。
   */
  fork(id, { from = '' } = {}) {
    const meta = this.#readMeta(String(id || ''));
    if (!meta) return null;
    const records = this.records(meta.id);
    const want = String(from ?? '').trim();
    let kept = records;
    let branch = null;
    if (want) {
      const pos = SessionStore.#branchPosition(records, want);
      kept = records.slice(0, pos + 1);
      branch = { sessionId: meta.id, from: want, position: pos + 1, recordId: kept[pos].rid || kept[pos].id || null, records: records.length };
    }
    const now = new Date().toISOString();
    const next = {
      ...meta,
      id: randomUUID(),
      name: `${meta.name || DEFAULT_SESSION_NAME}${branch ? '（分支）' : '（副本）'}`.slice(0, 60),
      createdAt: now,
      updatedAt: now,
      ...(branch ? { forkedFrom: branch } : {}),
    };
    this.#writeMeta(next);
    this.#notify('fork', next.id, { meta: next });
    if (kept.length) {
      try {
        writeFileSync(join(this.dir, `${next.id}.jsonl`), kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
      } catch (e) { this.warn('会话派生转录写入失败', { id: next.id, error: String(e) }); }
    }
    this.#tips.set(next.id, kept.length ? kept[kept.length - 1].rid || null : null);
    return next;
  }

  /** from 归一：纯 1..N 整数按序号，其余按 rid 匹配；都不中抛中文原因（HTTP 面转 400） */
  static #branchPosition(records, want) {
    if (/^[1-9][0-9]*$/.test(want)) {
      const n = Number(want);
      if (n >= 1 && n <= records.length) return n - 1;
      throw new Error(`分支位置越界：${want}（当前共 ${records.length} 条记录，可填 1..${records.length} 或某条记录 id）`);
    }
    const i = records.findIndex((r) => r.rid === want);
    if (i < 0) throw new Error(`分支位置无效：${want}（可填 1..${records.length} 的序号或某条记录 id）`);
    return i;
  }

  remove(id) {
    const sid = String(id || '');
    this.#recordsCache.delete(sid);
    let ok = false;
    for (const f of [`${sid}.jsonl`, `${sid}${META_SUFFIX}`]) {
      const p = join(this.dir, f);
      if (existsSync(p)) { try { rmSync(p, { force: true }); ok = true; } catch (e) { this.warn('会话删除失败', { id: sid, error: String(e) }); } }
    }
    this.#tips.delete(sid);
    this.#notify('remove', sid, {});
    return ok;
  }

  #metaPath(id) { return join(this.dir, `${id}${META_SUFFIX}`); }

  #readMeta(id) {
    try { return JSON.parse(readFileSync(this.#metaPath(id), 'utf8')); } catch { return null; }
  }

  #writeMeta(meta) {
    try {
      writeFileAtomic(this.#metaPath(meta.id), JSON.stringify(meta, null, 2)); // tmp + fsync + rename + 0600
    } catch (e) { this.warn('会话元信息写入失败', { id: meta.id, error: String(e) }); }
  }
}
