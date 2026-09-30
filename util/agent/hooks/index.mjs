/**
 * Hook 门面：目录发现 + 子进程执行 + 控制合并，对外只暴露一个 fire()。
 * 实验门控 AURORAAGENT_EXPERIMENTAL_HOOKS=1（与 MCP 同一套 EXPERIMENTAL_FLAGS 纪律）：
 * 关闭时 discoverHooks 直接给空清单，fire() 恒返回「无控制」——接入点因此不需要到处判开关。
 *
 * fire() 返回的合并结果：
 *   { fired: number, cancel, review, context, overrideInput, systemPrompt, logs: [] }
 * 调用方（loop.mjs）只认这几个字段，不需要知道背后跑了几个脚本、脚本说什么语言。
 */
import { experimentalEnabled } from '../../config.mjs';
import { discoverHooks } from './config.mjs';
import { runHook } from './runner.mjs';
import { mergeHookControls } from './control.mjs';
import { buildPayload } from './events.mjs';

/**
 * @param {{ workspace?: string, dataDir?: string, log?: Function }} opts
 * @returns {{ enabled, hooks, fire(event, base, extra) => Promise<object>, close() }}
 */
export function createHookRunner({ workspace = '', dataDir = '', log = () => {} } = {}) {
  const enabled = experimentalEnabled('HOOKS');
  const { hooks, warnings } = enabled ? discoverHooks({ workspace, dataDir }) : { hooks: [], warnings: [] };
  for (const w of warnings) log('warn', 'hook 加载告警', { detail: w });
  const byEvent = new Map();
  for (const h of hooks) byEvent.set(h.event, [...(byEvent.get(h.event) || []), h]);

  /**
   * 触发一个事件：把 payload 送给该事件下的所有 hook，合并控制指令。
   * 单个 hook 失败 / 超时只记日志，不影响其它 hook，也不影响 turn（fail-open）。
   */
  const fire = async (event, base = {}, extra = {}, opts = {}) => {
    const list = byEvent.get(event) || [];
    if (!list.length) return { fired: 0, cancel: false, review: false, context: '', overrideInput: undefined, systemPrompt: '', logs: [] };
    const payload = buildPayload(event, base, extra);
    const logs = [];
    const controls = [];
    await Promise.all(list.map(async (hook) => {
      const r = await runHook(hook, payload, { timeoutMs: opts.timeoutMs, signal: opts.signal, log });
      logs.push({ event, path: hook.path, ok: r.ok, ms: r.ms, error: r.error || '' });
      if (r.ok && r.control) controls.push(r.control);
    }));
    const merged = mergeHookControls(controls);
    return { fired: list.length, ...merged, logs };
  };

  return {
    enabled,
    hooks,
    /** 已注册事件的清单（供 GET /api/agent/hooks 与终端 /hooks 展示） */
    describe() {
      return hooks.map((h) => ({ event: h.event, path: h.path, source: h.source, interpreter: h.interpreter || '（可执行文件）' }));
    },
    fire,
    close() { byEvent.clear(); },
  };
}

/** 未注入 runner 时的空实现：直连 Loop 的旧调用方（测试 / 终端单次提问）不传 hooks 即用这份，
 *  fire() 恒回「无控制」——接入点因此不需要到处判空，也不必判实验门控 */
export const nullHooks = Object.freeze({
  enabled: false,
  hooks: Object.freeze([]),
  describe: () => [],
  fire: async () => ({ fired: 0, cancel: false, review: false, context: '', overrideInput: undefined, systemPrompt: '', logs: [] }),
  close: () => {},
});
