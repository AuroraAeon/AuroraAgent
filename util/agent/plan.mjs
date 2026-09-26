/**
 * 计划模式（对齐 kimi Plan Mode，作为独立维度叠加在 harness 能力档之上）：
 * 计划轮只用只读 / 检索 / 待办工具摸清现状并产出计划，用户批准后才以完整工具集执行。
 * 计划阶段不写盘、不执行命令——这是计划模式的安全内核，工具白名单在此单点定义。
 */

/** 计划轮可用工具：只读 / 检索 / 待办（skill 只读，由 loop 按需并入） */
export const PLAN_TOOLS = ['read_file', 'list_dir', 'grep', 'glob', 'web_fetch', 'todo'];

/** 计划轮系统提示附加块（拼在 harness 系统提示之后） */
export const PLAN_MODE_PROMPT = [
  '当前为计划模式：本轮只产出计划，不做任何修改。',
  '只能用只读 / 检索 / 待办工具了解现状；禁止写文件、改文件、执行命令。',
  '计划用 Markdown 输出，包含：目标、步骤（每步说明动作与预期结果）、风险与回滚、需要用户确认的点。',
  '想清楚后停止调用工具，直接输出计划全文——用户会批准或驳回，批准后才进入执行。',
].join('\n');

/** 计划轮次上限：探索够用即可，防止计划阶段无限打转 */
export const PLAN_MAX_ROUNDS = 8;

/** 批准后的执行注入：计划作为既定契约进入执行轮 */
export function planExecutionNote(plan) {
  return [
    '用户已批准以下计划。执行阶段请严格执行，按步骤推进并汇报进度；',
    '如发现计划与事实不符，先说明差异再继续，不要静默偏离。',
    '',
    '【已批准的计划】',
    String(plan || '').trim(),
  ].join('\n');
}

/** 计划轮的工具名：harness 工具与计划白名单取交集（harness 收缩优先） */
export function planToolNames(harnessTools, skills = []) {
  const base = (harnessTools || []).filter((n) => PLAN_TOOLS.includes(n));
  return skills.length ? [...new Set([...base, 'skill'])] : base;
}
