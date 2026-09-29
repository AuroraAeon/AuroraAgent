# e2e 约定

## 端口

- mock 上游：`127.0.0.1:18901`（复刻真实 SSE 帧与 401 / 402 错误）
- web 服务：`127.0.0.1:18787`
- mock 行为改 `test/mock-longcat.mjs`

## mock 触发词

| 触发词 | 行为 |
| --- | --- |
| `USE_TOOL` | 模型发起 `read_file mock.txt` |
| `USE_TOOL_WRITE` | 模型发起 `write_file written_by_agent.txt` |
| `FLAKY` | 断网重试 |
| `SLOW` | 慢速流 |

## 前端契约测试

守着构建产物与 `web-ui/` 的同步：改了 `web-ui/` 忘了 `build:web` 会红。本地改 `web-ui/` 后跑 `npm run typecheck:web` 与 `npm run build:web`。

## 守卫测试（`test/guards.mjs`）

产品源码零 emoji、TUI 颜色单一真值源（仅 `theme.mjs` 出 SGR）、色板与设计令牌对比度、新模块行数预算 ≤500、过渡动画禁 `transition:all`、文档站中英页面一一对应、架构地图登记、文档新鲜度。
