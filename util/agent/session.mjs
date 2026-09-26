/**
 * Agent 会话存储：每个会话两个文件，放在 <数据目录>/sessions/ 下：
 *   <id>.meta.json   元信息（模型 / 模式 / 工作目录 / 用量汇总），临时文件 + rename 原子落盘
 *   <id>.jsonl       追加式转录（user / assistant / thinking / tool_call / tool_result / summary / usage）
 * 投影（可见历史）由 jsonl 逐行重建，坏行跳过——与 usage.mjs 的容错读取同构。
 */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_HARNESS } from './harness.mjs';

const META_SUFFIX = '.meta.json';

export class SessionStore {
  constructor(dataDir, { warn = () => {} } = {}) {
    this.dir = join(dataDir, 'sessions');
    this.defaultWorkspace = join(dataDir, 'workspace');
    this.warn = warn;
    try { mkdirSync(this.dir, { recursive: true }); } catch (e) { this.warn('sessions 目录创建失败', { error: String(e) }); }
  }

  /** 新建会话；workspace 缺省为 <数据目录>/workspace，允许指定其他绝对路径 */
  create({ name = '', model = '', provider = '', harness = DEFAULT_HARNESS, workspace = '' } = {}) {
    const id = randomUUID();
    const now = new Date().toISOString();
    const meta = {
      id,
      name: name || '新会话',
      model,
      provider,
      harness,
      workspace: workspace ? resolve(workspace) : this.defaultWorkspace,
      createdAt: now,
      updatedAt: now,
      turns: 0,
      rules: [],
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
    };
    this.#writeMeta(meta);
    return meta;
  }

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

  /** 逐行读转录，坏行跳过 */
  records(id) {
    try {
      return readFileSync(join(this.dir, `${id}.jsonl`), 'utf8').split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  /** 追加一条转录记录；写失败只告警不打断（与 usage.mjs 同策略） */
  append(id, record) {
    try {
      appendFileSync(join(this.dir, `${id}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
    } catch (e) { this.warn('会话转录写入失败', { id, error: String(e) }); }
  }

  /** 整体重写转录（上下文压缩后：早期记录折叠为一条 summary），临时文件 + rename 原子落盘 */
  replaceRecords(id, records) {
    const sid = String(id || '');
    try {
      const p = join(this.dir, `${sid}.jsonl`);
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
      renameSync(tmp, p);
      return true;
    } catch (e) { this.warn('会话转录重写失败', { id: sid, error: String(e) }); return false; }
  }

  /** 合并更新元信息（用量累计 / 改名 / 切模型 / 权限规则），原子落盘 */
  patch(id, changes) {
    const meta = this.#readMeta(String(id || ''));
    if (!meta) return null;
    const next = { ...meta, ...changes, id: meta.id, updatedAt: new Date().toISOString() };
    this.#writeMeta(next);
    return next;
  }

  remove(id) {
    const sid = String(id || '');
    let ok = false;
    for (const f of [`${sid}.jsonl`, `${sid}${META_SUFFIX}`]) {
      const p = join(this.dir, f);
      if (existsSync(p)) { try { rmSync(p, { force: true }); ok = true; } catch (e) { this.warn('会话删除失败', { id: sid, error: String(e) }); } }
    }
    return ok;
  }

  #metaPath(id) { return join(this.dir, `${id}${META_SUFFIX}`); }

  #readMeta(id) {
    try { return JSON.parse(readFileSync(this.#metaPath(id), 'utf8')); } catch { return null; }
  }

  #writeMeta(meta) {
    try {
      const tmp = `${this.#metaPath(meta.id)}.tmp`;
      writeFileSync(tmp, JSON.stringify(meta, null, 2));
      renameSync(tmp, this.#metaPath(meta.id));
    } catch (e) { this.warn('会话元信息写入失败', { id: meta.id, error: String(e) }); }
  }
}
