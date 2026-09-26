---
name: test-writing
description: 为本仓库改动补测试的规约：e2e mock 上游、数据隔离、中文测试名、mock 触发词、前端契约测试
---

# 测试编写技能

为 AuroraAgent 的改动补测试时遵循本规约。测试是提交的前置条件：`npm test` 全绿才准提交。

## 规则

- 新路由 / 新行为 / 新错误映射必须带中文测试名进入 `test/run-tests.mjs`。
- 数据隔离：测试以临时目录作 `AURORAAGENT_DATA_DIR`，绝不许写真实数据目录。
- 不许 `skip`，不许放宽断言迁就失败；基线只增不减。
- mock 上游在 `127.0.0.1:18901`（复刻真实 SSE 帧与 401 / 402 错误），web 服务在 `127.0.0.1:18787`；mock 行为改 `test/mock-longcat.mjs`。
- 纯函数优先直接单测（如公式分段、TUI 渲染、技能解析）；需要服务的行为走 e2e。

## 词表

- mock 触发词：消息含 `USE_TOOL` → 模型发起 `read_file mock.txt`；含 `USE_TOOL_WRITE` → 发起 `write_file written_by_agent.txt`；`FLAKY` 断网重试；`SLOW` 慢速流。
- 前端契约测试守着构建产物与 `web-ui/` 的同步：改了 `web-ui/` 忘了 `build:web` 会红。
- 守卫测试（`test/guards.mjs`）：产品零 emoji、TUI 颜色单一真值源、色板对比度、新模块行数预算。

## 工作流

1. 先写失败测试：描述期望行为（中文名），确认它红在旧代码上。
2. 做最小实现让测试转绿；不顺手改无关代码。
3. 跑全量 `npm test`；触及上游行为的改动额外跑 `npm run check`（花少量钱）。
4. 测试随改动同一次提交；提交信息说清「改了什么、为什么」。

## 禁止

- 禁止为凑覆盖率写无断言的空测试。
- 禁止在测试里写死真实数据目录或真实 Key。
- 禁止用 `sleep` 拉长等时间替代事件等待（用流结束 / 回调）。
