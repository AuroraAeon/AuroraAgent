/**
 * 跨进程文件锁（零依赖，仅 Node 内置模块；迁移 pi packages/coding-agent/src/core/auth-storage.ts
 * 用 proper-lockfile 做的事——那是个 npm 依赖，这点互斥语义自实现更轻，不必引依赖）。
 *
 * 为什么需要：数据目录里的几个 JSON（config / providers / queue / mcp-oauth）都是「读—改—整篇写回」。
 * 两个进程同时这么干（web 服务 + 终端 + LaunchAgent 重启期的旧实例）就是经典的 lost update：
 * 各写各的完整快照，后落的那个把前一个的改动整篇抹掉。原子落盘（util/atomic.mjs）只保证
 * 「不出现半截文件」，保证不了「不丢对方那次写入」——那需要互斥。
 *
 * 实现口径（与 util/jobs/schedule.mjs 的 jobs.lock 同源，这里做成通用异步版）：
 *  - 锁文件 = <目标>.lock，O_EXCL 创建（原子抢锁），内容 { pid, at }；
 *  - 抢不到就读锁文件判活性：解析失败 / 超 staleMs / pid 已不存在（process.kill(pid,0) ESRCH）
 *    → 判定上一个持有者死了，强抢；同进程内持锁视为可重入（不走文件锁，见下）；
 *  - 进程内先过内存串行队列：同一路径的任务在进程内已经按调用顺序排队，天然不会和本进程的
 *    另一次持锁互相抢（否则 withFileLock(a) 里再调 withFileLock(a) 会自杀）；
 *  - await 里的时序由这条内存队列保证，退避重试只对付别的进程。
 */
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';

/** 进程内串行队列：同一个锁路径的任务排成一条链，await 之间不交错 */
const chains = new Map();
function enqueue(path, task) {
  const prev = chains.get(path) || Promise.resolve();
  const next = prev.then(task, task); // 前一个失败也要继续排（锁照常释放）
  chains.set(path, next.then(() => {}, () => {}));
  return next;
}

/**
 * 重入判定：同一把锁已经在「当前这条异步上下文」手里时直接放行。
 *
 * 为什么不能用进程级 Map：持锁者 await 期间，别的任务也会来抢同一把锁——那不是重入，
 * 必须照常排队，否则互斥就漏了。AsyncLocalStorage 恰好按异步上下文传播：只有真的嵌套在
 * 某个持锁回调里（含它 await 之后恢复执行的续体）才看得到深度 > 0。
 *
 * 没有这道门会怎样：嵌套拿同一把锁 = 自己等自己，同步版 5s / 异步版 10s 后抛超时。
 * 调用方现在没有嵌套（config / providers / queue 三处各锁各的文件），但「在锁里再存一次
 * 同一份配置」是很自然的下一步，届时不该以一场 10 秒挂起的形式炸出来。
 */
const lockCtx = new AsyncLocalStorage();
function reentrantDepth(lockPath) {
  const store = lockCtx.getStore();
  return store ? (store.get(lockPath) || 0) : 0;
}
/** 在标记了持锁深度的上下文里执行 fn（fn 同步或异步都行，上下文随 await 续传） */
function runInLockCtx(lockPath, depth, fn) {
  const outer = lockCtx.getStore() || new Map();
  const next = new Map(outer);
  next.set(lockPath, depth + 1);
  return lockCtx.run(next, fn);
}

/** 进程还活着吗（ESRCH = 没了；EPERM = 是别人的进程但确实在，别误判成死） */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/** 抢一次：成功返回 true；抢不到但可强抢（持有者已死）时先删再试一次 */
function tryAcquire(lockPath, staleMs) {
  let fd = null;
  try {
    fd = openSync(lockPath, 'wx'); // O_EXCL：已存在即失败，这是整个互斥的地基
  } catch {
    // 抢不到：看看是不是上一个持有者死了
    let info = null;
    try { info = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { info = null; }
    const at = Number(info?.at) || 0;
    const stale = !info || !pidAlive(info.pid) || (at > 0 && Date.now() - at > staleMs);
    if (!stale) return false;
    try { unlinkSync(lockPath); } catch { return false; }
    try { fd = openSync(lockPath, 'wx'); } catch { return false; }
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), boot: process.env.AURORAAGENT_BOOT || '' }));
  } catch { /* 内容写失败不影响互斥（读侧按 stale 兜底） */ }
  finally { closeSync(fd); }
  return true;
}

function release(lockPath) {
  try {
    const info = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null;
    // 只删自己的锁：强抢场景下旧的持有者可能只是卡住没死，删错会让两个进程同时持锁
    if (!info || Number(info.pid) === process.pid) unlinkSync(lockPath);
  } catch { /* 删不掉留给 stale 判定兜底 */ }
}

/** 等下一次重试的退避：线性 + 抖动，避免多进程同时醒来互相踩 */
function backoff(attempt) {
  const base = 15 * (attempt + 1);
  return base + Math.floor(Math.random() * 10);
}

/**
 * 持锁执行。fn 的返回值原样透出；fn 抛错时锁照常释放（错误不被吞）。
 * timeoutMs = 一直抢不到就抛错（不无限等：调用方是按「写一次 JSON」设计的，卡死比失败更糟）。
 */
export async function withFileLock(path, fn, { staleMs = 30000, timeoutMs = 10000 } = {}) {
  if (typeof fn !== 'function') throw new TypeError('withFileLock 需要回调');
  const lockPath = `${String(path)}.lock`;
  // 重入短路必须在入队之前：排队等的是「本进程前一个持锁者」，而那个持锁者正是当前调用方的
  // 外层——等它释放等于等自己。所以嵌套调用绕过队列直接执行
  const outerDepth = reentrantDepth(lockPath);
  if (outerDepth > 0) return runInLockCtx(lockPath, outerDepth, fn);
  return enqueue(lockPath, async () => {
    const depth = reentrantDepth(lockPath);
    if (depth > 0) return runInLockCtx(lockPath, depth, fn); // 排队期间外层已持锁（本进程嵌套）
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    let attempt = 0;
    for (;;) {
      if (tryAcquire(lockPath, staleMs)) break;
      if (Date.now() >= deadline) throw new Error(`等待文件锁超时：${lockPath}`);
      await new Promise((r) => setTimeout(r, backoff(attempt++)));
    }
    try {
      return await runInLockCtx(lockPath, 0, fn);
    } finally {
      release(lockPath);
    }
  });
}

/** 同步版（配置读写这类没有异步步骤的窄临界区用） */
export function withFileLockSync(path, fn, { staleMs = 30000, timeoutMs = 5000 } = {}) {
  if (typeof fn !== 'function') throw new TypeError('withFileLockSync 需要回调');
  const lockPath = `${String(path)}.lock`;
  const outerDepth = reentrantDepth(lockPath);
  if (outerDepth > 0) return runInLockCtx(lockPath, outerDepth, fn);
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  let attempt = 0;
  for (;;) {
    if (tryAcquire(lockPath, staleMs)) break;
    if (Date.now() >= deadline) throw new Error(`等待文件锁超时：${lockPath}`);
    const until = Date.now() + backoff(attempt++);
    while (Date.now() < until) { /* 忙等：同步 API 没有别的选择，窗口只有毫秒级 */ }
  }
  try {
    return runInLockCtx(lockPath, 0, fn);
  } finally {
    release(lockPath);
  }
}
