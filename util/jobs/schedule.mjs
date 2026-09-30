/**
 * 定时任务调度器：进程内 1s ticker + 单实例 owner 锁。
 * 迁移 OpenBitFun v1.0.2 #3149 的 cron 能力本地化落地。
 *
 * 为什么需要 owner 锁：端口交接期可能出现两个实例短暂共存（旧实例还没退、
 * 新实例已经监听）。没有锁时两边都会认为自己是调度者，同一任务会被跑两遍——
 * 定时任务重复执行的代价是真金白银的 token。故用 <数据目录>/jobs.lock：
 *   - O_EXCL 创建成功者即 owner，文件里写 PID；
 *   - 持锁方周期性刷新（重写文件，mtime 即心跳）；
 *   - 抢锁方读到 PID 后探活（signal 0），进程已死则接管；
 *   - 进程退出（含异常路径）必须 release，否则要等下一次探活失败才有人接手。
 *
 * 停机期间的到期任务：启动扫描时距计划时刻超过 MISSED_GRACE_MS 的先记一次
 * missed 再补跑，补跑本身仍受单飞保护（同一时刻只跑一个任务）。
 */
import { openSync, writeSync, closeSync, readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** 距计划时刻超过这个间隔视为「停机期间错过」，先记 missed 再补跑 */
export const MISSED_GRACE_MS = 6 * 60 * 60 * 1000;
const HEARTBEAT_MS = 5000;

/**
 * 本进程已持有的锁路径。为什么需要它：锁文件里写的是 PID，而同一进程里的两个调度器
 * （理论上不该有，但测试与误用要防）会写出同一个 PID。没有这份登记时，
 * 「自己写的锁」会被当成别人遗留的陈旧锁而反复接管，两个调度器就都跑起来了。
 */
const heldPaths = new Set();

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; }
  catch (e) { return e && e.code === 'EPERM'; }
}

/**
 * 抢调度 owner 锁。
 * @returns {{ acquired: boolean, release: () => void, refresh: () => void }}
 */
export function acquireOwnerLock(dataDir, { log = () => {} } = {}) {
  const file = join(dataDir, 'jobs.lock');
  const beat = () => {
    try {
      const fd = openSync(file, 'w');
      writeSync(fd, String(process.pid));
      closeSync(fd);
    } catch { /* 心跳失败不致命：下一次仍会尝试，最坏是别人接管 */ }
  };
  const release = () => {
    heldPaths.delete(file);
    try { unlinkSync(file); } catch {}
  };
  try {
    const fd = openSync(file, 'wx'); // O_EXCL | O_CREAT：已存在则抢锁失败
    writeSync(fd, String(process.pid));
    closeSync(fd);
    heldPaths.add(file);
    return { acquired: true, release, refresh: beat };
  } catch { /* 锁已存在：看看持有者还活着吗 */ }
  let ownerPid = 0;
  try { ownerPid = Number(readFileSync(file, 'utf8').trim()); } catch { ownerPid = 0; }
  // 持有者是活着的别的进程，或本进程里另一份已经拿着的锁 → 不抢
  if (ownerPid && pidAlive(ownerPid) && (ownerPid !== process.pid || heldPaths.has(file))) {
    log('info', '另一个实例持有定时任务调度锁，本实例不参与调度', { ownerPid });
    return { acquired: false, release: () => {}, refresh: () => {} };
  }
  // 持有者已死（或写坏了）：接管
  log('warn', '定时任务调度锁的持有者已退出，本实例接管', { ownerPid });
  beat();
  heldPaths.add(file);
  return { acquired: true, release, refresh: beat };
}

export class JobScheduler {
  /**
   * @param jobs JobStore 实例
   * @param onDue (job) => Promise<void> 到期执行器（由 web.mjs 注入：在目标会话跑注入式 turn）
   * @param opts { dataDir, log, intervalMs, now }
   */
  constructor(jobs, onDue, { dataDir, log = () => {}, intervalMs = 1000, now = () => Date.now() } = {}) {
    this.jobs = jobs;
    this.onDue = onDue;
    this.log = log;
    this.intervalMs = Math.max(50, Number(intervalMs) || 1000);
    this.now = now;
    this.timer = null;
    this.owner = null;
    this.running = false; // 单飞：同一时刻只跑一个任务，避免并发把上游打满
    this.started = false;
    this.lockFile = dataDir ? join(dataDir, 'jobs.lock') : null;
  }

  /** 是否持有调度权（测试与 /api/jobs 状态展示用） */
  get isOwner() { return Boolean(this.owner && this.owner.acquired); }

  start() {
    if (this.started) return;
    this.started = true;
    this.#tryAcquire();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.owner) this.owner.release();
    this.owner = null;
    this.started = false;
  }

  /**
   * 抢锁；抢不到就按退避间隔重试。
   * 为什么必须重试：端口交接期两个实例短暂共存（旧实例还没退、新实例已 listen）。
   * 只在启动时试一次的话，新实例会永久认为自己不该调度——旧实例一退就再没人跑任务了。
   */
  #tryAcquire() {
    if (!this.started) return;
    this.owner = acquireOwnerLock(this.lockFile ? join(this.lockFile, '..') : process.cwd(), { log: this.log });
    if (this.isOwner) {
      // 停机补跑：启动时先把停机期间到期的任务扫一遍（超过宽限期的先记 missed）
      void this.#sweep();
      this.timer = setInterval(() => { void this.#sweep(); }, this.intervalMs);
      if (this.timer.unref) this.timer.unref();
      this.log('info', '定时任务调度器已启动', { jobs: this.jobs.list().length });
      return;
    }
    this.timer = setInterval(() => this.#tryAcquire(), Math.max(this.intervalMs * 5, 5000));
    if (this.timer.unref) this.timer.unref();
  }

  async #sweep() {
    if (!this.isOwner || this.running) return;
    this.running = true;
    try {
      if (this.owner.refresh) this.owner.refresh();
      for (const job of this.jobs.due(this.now())) {
        const missed = this.now() - job.nextRunAt > MISSED_GRACE_MS;
        if (missed) {
          this.jobs.recordRun(job.id, { status: 'missed', error: '服务停机期间错过，本次为补跑', ranAt: this.now() });
          this.log('warn', '定时任务停机期间错过，补跑一次', { jobId: job.id, name: job.name });
        }
        // 记账由调度器单点负责：onDue 只管执行，执行完立刻推进 nextRunAt，
        // 否则下一次 sweep 还会把它当到期任务重复跑（重复执行的代价是真金白银的 token）
        const live = this.jobs.get(job.id) || job;
        // 停机错过优先标记 missed：用户要能一眼看出「这条不是按时跑的」
        const base = missed ? { status: 'missed', error: '服务停机期间错过，本次为补跑' } : { status: 'ok', error: '' };
        try {
          await this.onDue(live);
          this.jobs.recordRun(job.id, { ...base, ranAt: this.now() });
        } catch (e) {
          this.jobs.recordRun(job.id, { status: missed ? 'missed' : 'failed', error: String(e), ranAt: this.now() });
          this.log('error', '定时任务执行失败', { jobId: job.id, error: String(e) });
        }
      }
    } finally { this.running = false; }
  }
}
