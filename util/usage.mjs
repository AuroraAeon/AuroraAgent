/**
 * 用量账本：逐行追加 usage.jsonl，并提供汇总。
 * 账本文件含请求明细，已在 .gitignore；数据目录由调用方（web.mjs）按三级回退解析后传入。
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export class UsageLedger {
  constructor(dataDir, { warn = () => {} } = {}) {
    this.path = join(dataDir, 'usage.jsonl');
    this.warn = warn;
  }

  /** 追加一条记录；写失败只告警，不打断对话 */
  record(rec) {
    try {
      appendFileSync(this.path, `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`);
    } catch (e) { this.warn('usage 写入失败', { error: String(e) }); }
  }

  /** 读全部记录（坏行跳过） */
  read() {
    try {
      return readFileSync(this.path, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  }

  /** 汇总 + 最近 20 条（前端用量面板直接吃这个形状） */
  summary() {
    const rows = this.read();
    const totals = rows.reduce((a, r) => {
      a.requests += 1;
      a.inputTokens += r.inputTokens || 0;
      a.outputTokens += r.outputTokens || 0;
      a.cost += r.cost || 0;
      return a;
    }, { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0 });
    return { totals, recent: rows.slice(-20).reverse() };
  }
}
