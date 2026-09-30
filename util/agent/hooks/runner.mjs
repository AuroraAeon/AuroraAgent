/**
 * Hook 执行器（源头 Cline 的 subprocess-runner.ts）：把事件 payload 经 stdin 送给 hook 脚本，
 * 收 stdout 解析成 HookControl。零依赖 spawn，绝不用 shell 字符串拼命令（用户脚本路径含空格
 * 或怪字符时 shell 注入是真的会出事）。
 *
 * 退出码语义：
 *   0        正常，按解析出的 HookControl 行事
 *   2        显式取消（等价 cancel: true），原因取 stderr 首行
 *   其它     脚本自己失败了：记日志、按「无控制」继续（fail-open——用户的 hook 写错了
 *            不该让整条 Agent turn 崩掉，那是比不执行 hook 更糟的体验）
 * 超时默认 10s、封顶 60s：hook 是锦上添花，没有资格把用户挂死。
 */
import { spawn } from 'node:child_process';
import { parseHookControl } from './control.mjs';

export const HOOK_TIMEOUT_DEFAULT_MS = 10000;
export const HOOK_TIMEOUT_MAX_MS = 60000;

/**
 * 跑一个 hook 脚本。
 * @param {{ path: string, interpreter: string }} hook
 * @param {object} payload 事件 payload（JSON 序列化后经 stdin 送入）
 * @param {{ timeoutMs?: number, log?: Function, signal?: AbortSignal }} opts
 * @returns {Promise<{ ok: boolean, control: object|null, error?: string, ms: number }>}
 */
export function runHook(hook, payload, opts = {}) {
  const timeoutMs = Math.min(HOOK_TIMEOUT_MAX_MS, Math.max(1000, Number(opts.timeoutMs) || HOOK_TIMEOUT_DEFAULT_MS));
  const log = opts.log || (() => {});
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      const argv = hook.interpreter ? [hook.interpreter, hook.path] : [hook.path];
      child = spawn(argv[0], argv.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: String(payload?.workspace || process.cwd()),
        env: { ...process.env, AURORAAGENT_HOOK_EVENT: String(payload?.hookName || '') },
      });
    } catch (e) {
      resolve({ ok: false, control: null, error: `hook 启动失败：${String(e)}`, ms: Date.now() - started });
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener?.('abort', onAbort);
      try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      resolve({ ...result, ms: Date.now() - started });
    };
    const onAbort = () => finish({ ok: false, control: null, error: 'hook 被中止（turn 已中断）' });
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => finish({ ok: false, control: null, error: `hook 超时（${timeoutMs}ms）` }), timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > 1024 * 1024) finish({ ok: false, control: null, error: 'hook 输出超过 1MB' }); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 256 * 1024) err = err.slice(-256 * 1024); });
    child.on('error', (e) => finish({ ok: false, control: null, error: `hook 执行失败：${String(e)}` }));
    child.on('close', (code) => {
      if (code === 0) {
        const control = parseHookControl(out);
        finish({ ok: true, control });
        return;
      }
      if (code === 2) {
        finish({ ok: true, control: { cancel: true }, error: err.split('\n')[0] || 'hook 要求取消' });
        return;
      }
      const reason = err.split('\n').find((l) => l.trim()) || `退出码 ${code}`;
      log('warn', 'hook 脚本执行失败，按无控制继续', { path: hook.path, code, reason: reason.slice(0, 200) });
      finish({ ok: false, control: null, error: reason.slice(0, 200) });
    });
    try {
      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    } catch (e) {
      finish({ ok: false, control: null, error: `hook stdin 写入失败：${String(e)}` });
    }
  });
}
