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
      a.cachedTokens += r.cachedTokens || 0;
      a.cacheWriteTokens += r.cacheWriteTokens || 0;
      return a;
    }, { requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, cachedTokens: 0, cacheWriteTokens: 0 });
    return { totals, recent: rows.slice(-20).reverse() };
  }

  /**
   * 统计视图：近 N 天逐日走势 + 按模型 / 提供方 / 用途 / 会话的构成（供设置页「用量」面板）。
   * 纯函数式聚合，空天补零（柱状图不断档）；金额统一保留 6 位，展示层再格式化。
   */
  stats({ days = 30, top = 8 } = {}) {
    const rows = this.read();
    const dayKeys = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * 86400000);
      dayKeys.push(d.toISOString().slice(0, 10));
    }
    const byDay = new Map(dayKeys.map((k) => [k, { day: k, requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, cachedTokens: 0, cacheWriteTokens: 0 }]));
    const byModel = new Map();
    const byProvider = new Map();
    const byPurpose = new Map();
    const bySession = new Map();

    const bump = (map, key, row) => {
      if (!key) return;
      const cur = map.get(key) || { key, requests: 0, inputTokens: 0, outputTokens: 0, cost: 0, cachedTokens: 0, cacheWriteTokens: 0 };
      cur.requests += 1;
      cur.inputTokens += row.inputTokens || 0;
      cur.outputTokens += row.outputTokens || 0;
      cur.cost += row.cost || 0;
      cur.cachedTokens += row.cachedTokens || 0;
      cur.cacheWriteTokens += row.cacheWriteTokens || 0;
      map.set(key, cur);
    };

    for (const r of rows) {
      const day = String(r.ts || '').slice(0, 10);
      const slot = byDay.get(day);
      if (slot) {
        slot.requests += 1;
        slot.inputTokens += r.inputTokens || 0;
        slot.outputTokens += r.outputTokens || 0;
        slot.cost += r.cost || 0;
        slot.cachedTokens += r.cachedTokens || 0;
        slot.cacheWriteTokens += r.cacheWriteTokens || 0;
      }
      bump(byModel, r.model, r);
      bump(byProvider, r.provider, r);
      bump(byPurpose, r.purpose || r.kind || 'chat', r);
      bump(bySession, r.kind === 'agent' ? r.sessionId : '', r);
    }

    const rank = (map) => [...map.values()]
      .map((x) => ({ ...x, cost: Number(x.cost.toFixed(6)) }))
      .sort((a, b) => b.cost - a.cost || b.requests - a.requests)
      .slice(0, top);

    return {
      days,
      byDay: dayKeys.map((k) => byDay.get(k)),
      byModel: rank(byModel),
      byProvider: rank(byProvider),
      byPurpose: rank(byPurpose),
      bySession: rank(bySession),
    };
  }
}
