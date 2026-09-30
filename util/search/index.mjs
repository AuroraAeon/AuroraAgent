/**
 * 会话全文检索：纯 JS 倒排索引 + BM25（本地化 Cline 的会话搜索）。
 *
 * 设计取舍——为什么不落盘 search-index.json：
 *   转录动辄数百 KB，把词频表序列化会得到一个几十 MB 的 JSON，每次追加都全量重写，
 *   比搜索本身更贵。改成「内存倒排索引 + 按 (mtimeMs, size) 指纹增量比对」：
 *   只有指纹变了的会话才重新分词，未变的会话零成本。5 分钟一次的 reconcile 兜底
 *   （fork / 外部改写 / 删除都靠它发现）——语义上仍是增量 + 定期对账，但不产生大文件。
 *
 * 分词与排序在 tokenize.mjs / bm25.mjs：CJK 二元 gram + 拉丁词小写，Okapi BM25。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { termFreq } from './tokenize.mjs';
import { bm25Rank } from './bm25.mjs';

export const SEARCH_INDEX_VERSION = 1;
/** reconcile 周期：5 分钟。搜索时顺带检查，过期才对全量目录做一次指纹比对 */
export const RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
/** 摘要片段长度 */
export const SNIPPET_MAX = 160;
/** 工具结果截断：那是给模型看的，不是给人搜的 */
const RESULT_CAP = 4000;

/** 转录记录里可检索的文本 */
export function recordTextOf(r) {
  if (!r || typeof r !== 'object') return '';
  switch (r.t) {
    case 'tool_call': {
      let args = '';
      try { args = typeof r.args === 'string' ? r.args : JSON.stringify(r.args || {}); } catch { args = ''; }
      return `${r.name || ''} ${args}`.trim();
    }
    case 'tool_result':
      return String(r.output || r.error || '').slice(0, RESULT_CAP);
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'summary':
    case 'system':
      return String(r.text || '');
    default:
      return '';
  }
}

/** 一条会话的完整可检索文本：标题权重最高，故放在最前 */
export function sessionTextOf(meta, records) {
  const parts = [String(meta?.name || '')];
  for (const r of records || []) {
    const s = recordTextOf(r);
    if (s) parts.push(s);
  }
  return parts.join('\n');
}

export class SessionSearchIndex {
  #dir;
  #warn;
  /** id -> { stamp, len, title } */
  #docs = new Map();
  /** 词 -> (id -> tf) */
  #postings = new Map();
  // -Infinity = 「从未对账」：首次搜索必须全量扫一遍，否则进程启动前就存在的会话搜不到。
  // 若初值为 0， now - 0 < 周期 会让首检直接空转，之后某次搜索才补上——行为依赖时钟大小，不可接受
  #lastReconcile = Number.NEGATIVE_INFINITY;

  constructor(sessionsDir, { warn = () => {} } = {}) {
    this.#dir = String(sessionsDir || '');
    this.#warn = warn;
  }

  get size() { return this.#docs.size; }

  #stamp(id) {
    try {
      const st = statSync(join(this.#dir, `${id}.jsonl`));
      return `${st.mtimeMs}:${st.size}`;
    } catch { return null; }
  }

  /** 摘掉某文档在倒排索引里的全部贡献 */
  #evict(id) {
    for (const [term, hit] of this.#postings) {
      if (hit.delete(id) && hit.size === 0) this.#postings.delete(term);
    }
  }

  /** 用整段文本重建一个文档 */
  #rebuild(id, title, text) {
    this.#evict(id);
    const { len, tf } = termFreq(text);
    for (const [term, n] of Object.entries(tf)) {
      let hit = this.#postings.get(term);
      if (!hit) { hit = new Map(); this.#postings.set(term, hit); }
      hit.set(id, n);
    }
    this.#docs.set(id, { stamp: this.#stamp(id), len, title: String(title || '') });
  }

  /** 增量追加一段转录文本（轮次边界调用，不重读整个转录）。title 仅首建时生效 */
  add(id, text, title) {
    const sid = String(id || '');
    if (!sid) return;
    let doc = this.#docs.get(sid);
    if (!doc) {
      const t = String(title || '');
      doc = { stamp: this.#stamp(sid), len: 0, title: t };
      this.#docs.set(sid, doc);
      if (t) { const seed = termFreq(t); this.#merge(sid, seed.tf); doc.len += seed.len; }
    }
    if (!text) return;
    const { len, tf } = termFreq(text);
    if (!len) return;
    this.#merge(sid, tf);
    doc.len += len;
    doc.stamp = this.#stamp(sid);
  }

  /** 把一段词频并进倒排索引 */
  #merge(sid, tf) {
    for (const [term, n] of Object.entries(tf)) {
      let hit = this.#postings.get(term);
      if (!hit) { hit = new Map(); this.#postings.set(term, hit); }
      hit.set(sid, (hit.get(sid) || 0) + n);
    }
  }

  /** 按转录文件重建（首建 / replaceRecords / fork / reconcile）。title 省略时读 meta 里的会话名 */
  reindexFromFile(id, title) {
    const sid = String(id || '');
    if (!sid) return;
    const records = this.#readRecords(sid);
    if (records === null) { this.remove(sid); return; }
    const t = title === undefined ? this.#readTitle(sid) : String(title || '');
    this.#rebuild(sid, t, sessionTextOf({ name: t }, records));
  }

  /** 会话名（meta 里，不在转录里）；读不到回退已缓存的标题 */
  #readTitle(id) {
    try {
      const meta = JSON.parse(readFileSync(join(this.#dir, `${id}.meta.json`), 'utf8'));
      if (meta && typeof meta.name === 'string' && meta.name) return meta.name;
    } catch { /* 没有 meta 或读不懂：用缓存值 */ }
    return this.#docs.get(id)?.title || '';
  }

  /** 读并解析转录；文件不存在返回 null（坏行跳过，与 SessionStore 同策略） */
  #readRecords(id) {
    let raw;
    try { raw = readFileSync(join(this.#dir, `${id}.jsonl`), 'utf8'); } catch { return null; }
    const out = [];
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try { const r = JSON.parse(line); if (r && typeof r === 'object') out.push(r); } catch { /* 坏行跳过 */ }
    }
    return out;
  }

  remove(id) {
    const sid = String(id || '');
    if (!this.#docs.has(sid)) return;
    this.#evict(sid);
    this.#docs.delete(sid);
  }

  /**
   * 全量对账：删掉已注销的会话、重建指纹变了的会话。
   * 5 分钟一次（搜索时顺带触发），force=true 跳过时间门（测试与首屏用）。
   * @returns {{ added: number, updated: number, dropped: number }}
   */
  reconcile({ now = Date.now(), force = false } = {}) {
    if (!force && now - this.#lastReconcile < RECONCILE_INTERVAL_MS) return { added: 0, updated: 0, dropped: 0 };
    this.#lastReconcile = now;
    let files = [];
    try { files = readdirSync(this.#dir); } catch { return { added: 0, updated: 0, dropped: 0 }; }
    let added = 0;
    let updated = 0;
    const live = new Set();
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -'.jsonl'.length);
      live.add(id);
      const stamp = this.#stamp(id);
      const doc = this.#docs.get(id);
      if (!doc || doc.stamp !== stamp) { this.reindexFromFile(id); if (doc) updated += 1; else added += 1; }
    }
    let dropped = 0;
    for (const id of [...this.#docs.keys()]) {
      if (!live.has(id)) { this.remove(id); dropped += 1; }
    }
    return { added, updated, dropped };
  }

  /**
   * 搜索。
   * @param {string} q 查询串
   * @param {{ limit?: number, now?: number }} opts
   * @returns {Array<{ id: string, score: number, title: string, snippet: string }>}
   */
  search(q, { limit = 20, now = Date.now() } = {}) {
    const query = String(q || '').trim();
    if (!query) return [];
    this.reconcile({ now });
    const tf = termFreq(query).tf;
    const terms = Object.keys(tf);
    if (!terms.length) return [];
    const lens = new Map();
    for (const [id, d] of this.#docs) lens.set(id, d.len);
    const ranked = bm25Rank({ terms, postings: this.#postings, lens, docCount: this.#docs.size });
    const out = [];
    for (const { id, score } of ranked.slice(0, Math.max(1, limit))) {
      out.push({
        id,
        score: Math.round(score * 1000) / 1000,
        title: this.#docs.get(id)?.title || '',
        snippet: this.#snippet(id, terms),
      });
    }
    return out;
  }

  /** 取第一个命中词附近的原文片段（按需读文件，不在内存里常驻转录） */
  #snippet(id, terms) {
    const records = this.#readRecords(id);
    if (records === null) return '';
    const body = sessionTextOf({ name: this.#docs.get(id)?.title || '' }, records);
    let at = -1;
    for (const t of terms) {
      const i = body.toLowerCase().indexOf(t);
      if (i >= 0 && (at < 0 || i < at)) at = i;
    }
    if (at < 0) return body.slice(0, SNIPPET_MAX);
    const from = Math.max(0, at - Math.floor(SNIPPET_MAX / 3));
    const slice = body.slice(from, from + SNIPPET_MAX).replace(/\s+/g, ' ').trim();
    return `${from > 0 ? '…' : ''}${slice}${from + SNIPPET_MAX < body.length ? '…' : ''}`;
  }
}
