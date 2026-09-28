/**
 * 故障转移运行时状态（<数据目录>/failover-state.json）：熔断快照 + 热切换偏好。
 * 与 providers.json 里的 failoverQueue 分工明确——队列是「用户意图」（人编排的顺序），
 * 本文件是「运行时观测」（哪家不健康、哪家最近真正接通过了哪个模型）。
 *
 * 写盘纪律（对齐 session / providers 的原子落盘）：先写 .tmp 再 rename，节流 1s 合并
 * 连续变更，损坏文件静默回退空态（绝不因一个坏状态文件挡住服务启动）。
 * 本模块持有 CircuitRegistry 实例：loop.mjs / web.mjs 共用同一份，跨请求记忆才有意义。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CircuitRegistry, normalizeCircuitConfig, CIRCUIT_DEFAULTS } from './circuit.mjs';

/** 落盘节流窗口：一次 turn 里可能连续换路几次，合并成一次写 */
const FLUSH_DELAY_MS = 1000;
/** 热切换偏好有效期：超时后回退默认顺序，避免永久钉在一家（用户无感恢复） */
export const DEFAULT_PREF_TTL_HOURS = 24;
const MAX_PREFS = 200;

export class FailoverState {
  /**
   * @param dataDir 数据目录（与 config / providers 同级）
   * @param opts { warn, config: { circuit }, now, prefTtlMs }
   */
  constructor(dataDir, { warn = () => {}, config = {}, now = () => Date.now(), prefTtlMs } = {}) {
    this.path = join(dataDir, 'failover-state.json');
    this.warn = warn;
    this.now = now;
    this.prefTtlMs = Number.isFinite(Number(prefTtlMs)) && Number(prefTtlMs) > 0
      ? Number(prefTtlMs) : DEFAULT_PREF_TTL_HOURS * 3600_000;
    this.prefs = new Map(); // modelId -> { providerId, at }
    this.timer = null;
    this.circuits = new CircuitRegistry({
      config: normalizeCircuitConfig(config.circuit || CIRCUIT_DEFAULTS),
      now,
      persist: () => this.#dirty(),
    });
  }

  /** 启动时读一次：熔断快照进注册表，过期偏好直接剪掉 */
  load() {
    let raw = null;
    try {
      if (existsSync(this.path)) raw = JSON.parse(readFileSync(this.path, 'utf8'));
    } catch (e) {
      this.warn('故障转移状态文件损坏，已按空态处理', { error: String(e) });
      raw = null;
    }
    if (!raw || typeof raw !== 'object') return this;
    this.circuits.restore(raw.circuits);
    const prefs = raw.prefs && typeof raw.prefs === 'object' ? raw.prefs : {};
    const now = this.now();
    for (const [model, value] of Object.entries(prefs)) {
      if (!value || typeof value !== 'object') continue;
      const at = Number(value.at);
      if (!Number.isFinite(at) || now - at > this.prefTtlMs) continue; // 过期即弃
      const providerId = String(value.providerId || '');
      if (providerId) this.prefs.set(model, { providerId, at });
    }
    return this;
  }

  /** 热切换偏好：转移成功后调用，providerForModel 据此优先选这家 */
  setPref(model, providerId) {
    const key = String(model || '');
    const id = String(providerId || '');
    if (!key || !id) return;
    this.prefs.set(key, { providerId: id, at: this.now() });
    // 偏好按模型累积，封顶防止无限增长（最早的先淘汰）
    while (this.prefs.size > MAX_PREFS) {
      const oldest = this.prefs.keys().next().value;
      this.prefs.delete(oldest);
    }
    this.#dirty();
  }

  /** 读偏好；过期返回 null（调用方回退默认顺序） */
  prefFor(model) {
    const hit = this.prefs.get(String(model || ''));
    if (!hit) return null;
    if (this.now() - hit.at > this.prefTtlMs) { this.prefs.delete(String(model || '')); return null; }
    return hit.providerId;
  }

  clearPref(model) {
    if (this.prefs.delete(String(model || ''))) this.#dirty();
  }

  /** 手动恢复：providerId 缺省重置全部熔断器并清空偏好 */
  reset(providerId) {
    if (providerId) this.circuits.reset(providerId);
    else { this.circuits.resetAll(); this.prefs.clear(); }
    this.flush();
  }

  /** 立即落盘（reset / 进程退出用） */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.#write();
  }

  #dirty() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.#write(); }, FLUSH_DELAY_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref(); // 不拖住进程退出
  }

  #write() {
    const payload = JSON.stringify({ version: 1, circuits: this.circuits.snapshot(), prefs: Object.fromEntries(this.prefs) }, null, 2);
    const tmp = `${this.path}.tmp`;
    try {
      mkdirSync(join(this.path, '..'), { recursive: true });
      writeFileSync(tmp, payload);
      renameSync(tmp, this.path);
    } catch (e) {
      this.warn('故障转移状态写入失败', { error: String(e) });
    }
  }
}
