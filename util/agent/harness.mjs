/**
 * Harness 模式契约：对齐 OpenBitFun 的 Agent Harness 理念——
 * 「模式决定任务怎么被完成」：系统提示、可用工具、轮次上限、压缩阈值都随模式变化。
 * v1 实现 Minimal / Standard / Ultimate 三档；Creative（Mini App 创作）留待后续迭代。
 * 工作目录等动态信息由 context.mjs 在系统提示末尾追加，契约本身保持静态。
 */
export const HARNESSES = [
  {
    id: 'minimal',
    label: 'Minimal',
    summary: '快速协作：目标明确时直接作答，不调用工具',
    tools: [],
    maxRounds: 1,
    compactRatio: 0.9,
    systemPrompt: [
      '你是 AuroraAgent，一个运行在用户本机的 Agent 运行时。',
      '当前为 Minimal 模式：不调用任何工具，直接用已有知识回答问题。',
      '回答使用与用户相同的语言，简洁、直接、可执行。',
    ].join('\n'),
  },
  {
    id: 'standard',
    label: 'Standard',
    summary: '日常任务：按需调用工具，多步推进并核对结果',
    tools: ['read_file', 'list_dir', 'write_file', 'edit_file', 'shell', 'web_fetch', 'grep', 'glob', 'todo'],
    maxRounds: 24,
    compactRatio: 0.7,
    systemPrompt: [
      '你是 AuroraAgent，一个运行在用户本机的 Agent 运行时。',
      '当前为 Standard 模式：按需调用工具完成任务，多步推进，每步核对结果后再继续。',
      '工作目录见下方说明；文件操作只能在工作目录内进行。',
      '修改文件前先读取确认现状；能用 edit_file 精确替换就不要整文件重写。',
      '找内容用 grep、找文件用 glob，不要用 shell 的 find / grep 绕行；多步任务用 todo 跟踪进度。',
      'shell 命令保持幂等与可重入；命令输出很长时先缩小范围再读。',
      '回答使用与用户相同的语言，简洁、直接、可执行。',
    ].join('\n'),
  },
  {
    id: 'ultimate',
    label: 'Ultimate',
    summary: '复杂任务：充分探索、逐步验证、汇总结果',
    tools: ['read_file', 'list_dir', 'write_file', 'edit_file', 'shell', 'web_fetch', 'grep', 'glob', 'todo'],
    maxRounds: 64,
    compactRatio: 0.6,
    systemPrompt: [
      '你是 AuroraAgent，一个运行在用户本机的 Agent 运行时。',
      '当前为 Ultimate 模式：处理复杂任务。先充分探索现状，再分步实施，每步验证，最后汇总结果与遗留问题。',
      '工作目录见下方说明；文件操作只能在工作目录内进行。',
      '优先使用工具获取事实，不要凭空假设文件内容或命令结果。',
      '遇到不确定的分支时明确说出假设，再继续推进。',
      '找内容用 grep、找文件用 glob；多步任务用 todo 规划并逐项更新。',
      '回答使用与用户相同的语言，简洁、直接、可执行。',
    ].join('\n'),
  },
];

export const DEFAULT_HARNESS = 'standard';

/** 按 id 取模式；未知 id 回退 standard（与模型选择的非法值回退同构） */
export function getHarness(id) {
  return HARNESSES.find((h) => h.id === String(id || '')) || HARNESSES.find((h) => h.id === DEFAULT_HARNESS);
}

/** /api/agent/harnesses 与前端选择器共用的精简形状 */
export function harnessSummaries() {
  return HARNESSES.map(({ id, label, summary, tools, maxRounds }) => ({ id, label, summary, tools, maxRounds }));
}
