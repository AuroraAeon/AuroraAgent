/**
 * HookControl 合并（源头 Cline 的 contracts.ts）：hook 脚本经 stdout 回一段 JSON，
 * 这里把它归一成运行时认得的控制指令。多个 hook 命中同一事件时按「后者覆盖前者」合并，
 * 但 cancel 是粘性的——任何一个 hook 说 cancel，这件事就不做（安全默认）。
 *
 * 字段语义：
 *   cancel          取消这次动作（工具不执行 / 压缩跳过 / turn 中止）
 *   review          转交权限通道（复用既有的 pending permission，用户显式确认后才继续）
 *   context         追加进上下文的文本（合计有上限，超了按时间先后裁剪）
 *   overrideInput   改写入参（工具参数 / 用户输入）
 *   systemPrompt    追加进系统提示
 */

/** 单个 hook 回给运行时的 context 总上限（50KB）：context 是持久驻留的，无限追加会撑爆窗口 */
export const HOOK_CONTEXT_LIMIT = 50 * 1024;

/** 从 hook 的 stdout 解析出 HookControl。解析失败给 null（坏脚本不该让用户的 turn 崩掉） */
export function parseHookControl(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  let obj = null;
  try { obj = JSON.parse(raw); } catch {
    // 容错：脚本可能在 JSON 前后打了日志，取最后一段能解析的
    for (const line of raw.split('\n').reverse()) {
      const t = line.trim();
      if (!t.startsWith('{')) continue;
      try { obj = JSON.parse(t); break; } catch { /* 继续找上一行 */ }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const out = {};
  if (obj.cancel === true) out.cancel = true;
  if (obj.review === true) out.review = true;
  if (typeof obj.context === 'string' && obj.context.trim()) out.context = obj.context;
  if (obj.overrideInput !== undefined && obj.overrideInput !== null) out.overrideInput = obj.overrideInput;
  if (typeof obj.systemPrompt === 'string' && obj.systemPrompt.trim()) out.systemPrompt = obj.systemPrompt;
  return Object.keys(out).length ? out : null;
}

/**
 * 合并多个 hook 的控制指令。
 * @param {Array<object|null>} controls 按执行顺序排列的单个控制指令
 * @returns {{ cancel, review, context, overrideInput, systemPrompt, applied }}
 */
export function mergeHookControls(controls = []) {
  const out = { cancel: false, review: false, context: '', overrideInput: undefined, systemPrompt: '', applied: 0 };
  const contexts = [];
  for (const c of controls) {
    if (!c) continue;
    out.applied += 1;
    if (c.cancel) out.cancel = true;
    if (c.review) out.review = true;
    if (c.context) contexts.push(c.context);
    if (c.overrideInput !== undefined) out.overrideInput = c.overrideInput; // 后者覆盖前者
    if (c.systemPrompt) out.systemPrompt = out.systemPrompt ? `${out.systemPrompt}\n\n${c.systemPrompt}` : c.systemPrompt;
  }
  // context 合计超限时从最旧的开始砍：新钩子的信息通常更贴近当前这次动作。
  // 裁剪提示自身也占额度，一起算进上限里——否则「上限 50KB」会变成 50KB + 提示长度
  let joined = contexts.join('\n\n');
  if (joined.length > HOOK_CONTEXT_LIMIT) {
    const note = '…（早期 hook 上下文超限已裁剪）\n';
    joined = note + joined.slice(-(HOOK_CONTEXT_LIMIT - note.length));
  }
  out.context = joined;
  return out;
}
