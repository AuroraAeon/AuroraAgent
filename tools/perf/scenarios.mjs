/**
 * 性能场景定义（方法论对齐 MiniMax-code docs/performance-ci.md 的场景化基准）：
 *   startup      启动与关闭：起服务 → 健康检查就绪 → 关闭
 *   upstream-100 100 次速测底座请求（/api/chat，SSE 透传全链路）
 *   history-300  300 个 agent 工具轮（跨多个 turn 累积历史，压上下文组装 / 转录增长 / 压缩路径）
 * 每个场景声明自己的 mock 参数与驱动方式；runner 只认这个形状，新增场景不改 runner。
 */

export const SCENARIOS = {
  startup: {
    id: 'startup',
    summary: '服务启动到健康检查就绪的耗时（最小请求体）',
    mock: { chunkChars: 64, payloadChars: 512, agentRounds: 0 },
    drive: 'startup',
  },
  'upstream-100': {
    id: 'upstream-100',
    summary: '100 次 /api/chat 流式请求（每次约 4 KiB，64 字符分片，零延迟）',
    requests: 100,
    mock: { chunkChars: 64, payloadChars: 4096, agentRounds: 0 },
    drive: 'chat',
  },
  'history-300': {
    id: 'history-300',
    summary: '300 个 agent 工具轮（跨 turn 累积约 2.4 MiB 历史，压上下文组装与压缩）',
    rounds: 300,
    roundsPerTurn: 60,
    mock: { chunkChars: 64, payloadChars: 8192, agentRounds: 300 },
    drive: 'agent',
  },
};

export const SUITES = {
  smoke: ['startup'],
  basic: ['startup', 'upstream-100'],
  full: ['startup', 'upstream-100', 'history-300'],
};

export function scenariosOfSuite(suite) {
  const ids = SUITES[suite];
  if (!ids) throw new Error(`未知套件: ${suite}（可选: ${Object.keys(SUITES).join(' / ')}）`);
  return ids.map((id) => SCENARIOS[id]);
}
