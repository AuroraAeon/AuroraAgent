# Agent Loop 架构

一个 turn = 若干「模型轮」：流式读取 → 有工具调用就经权限门控执行并回填结果 → 继续，直到模型不再要求工具或触顶模式轮次上限。核心实现在 `util/agent/loop.mjs`。

## 数据流

```text
POST /api/agent/turn
  → loop.mjs 按 harness 组装上下文（context.mjs）
  → wire.mjs 按提供方协议请求上游（带 tools）
  → stream.mjs 增量读取（文本 / 思考 / tool_calls）
  → 工具经 policy.mjs 门控执行（ask 挂起等 POST /api/agent/permission）
  → 结果回填进入下一轮
  → 无 tool_calls 或触顶即 turn_completed
```

每轮经 `util/usage.mjs` 按提供方单价记账；客户端断开即 `AbortController` 中止 turn，已生成内容保留。

## 三档 Harness 模式

| 模式 | 定位 | 工具 | 轮次上限 | 压缩阈值 |
| --- | --- | --- | --- | --- |
| Minimal | 快速协作：目标明确时直接作答 | 无 | 1 | 90% |
| Standard | 日常任务：按需调用工具，多步推进并核对结果 | 全部 | 24 | 70% |
| Ultimate | 复杂任务：充分探索、逐步验证、汇总结果 | 全部 | 64 | 60% |

## 工具集

| 工具 | 作用 | 默认权限 |
| --- | --- | --- |
| `read_file` | 读工作目录内文本文件（带行号，offset/limit 分段） | 放行 |
| `list_dir` | 列目录直接子项 | 放行 |
| `grep` | 正则检索内容（预算截断） | 放行 |
| `glob` | 按模式查找文件 | 放行 |
| `web_fetch` | 抓取网页（带响应大小上限） | 放行 |
| `write_file` | 覆盖写文件（自动建父目录） | 需确认 |
| `edit_file` | 精确字符串替换（回传 diff 结构化负载） | 需确认 |
| `shell` | 工作目录内执行 shell 命令（超时默认 30s、上限 120s） | 需确认 |
| `todo` | 规划清单维护（随会话持久化） | 放行 |
| `skill` | 按需加载技能正文 | 放行 |
| `task` | 派发子代理（Standard / Ultimate） | 放行 |

## 权限三档与计划模式

两个独立维度，叠加在 harness 能力档之上：

- **权限三档**（`permissionMode`）：`always_ask`（一律询问）/ `ask_when_needed`（默认，等价历史行为）/ `never_ask`（ask 类默认放行；deny 规则与会话规则仍优先）
- **计划模式**（`planMode`）：计划轮只用只读 / 检索 / 待办工具产出计划，你批准后才以完整工具集执行

## 上下文压缩

token 估算超过窗口阈值时，把早期对话经一轮模型调用总结为 `summary` 记录，保留近期尾部原文；压缩失败不阻塞主流程。

## 事件协议

`turn_started` / `model_round_started` / `text_chunk` / `thinking_chunk` / `tool_event` / `plan_proposed|approved|rejected` / `provider_switched` / `token_usage_updated` / `context_compression_*` / `turn_completed|cancelled|failed`，统一 SSE 帧封装（`util/agent/events.mjs`），终端与网页共用。`provider_switched` 在主提供方 429 / 5xx / 网络失败并切换到提供同模型的其它提供方时推送（详见[自定义提供方](/zh/guide/providers)的故障转移一节）。

## 子代理（swarm）

`task` 工具以受限 harness 派生子 turn：真实子会话落盘（透明可查）、继承工作目录与会话权限规则、嵌套深度封顶 2 层、单次上限 4 个、父中止级联中止子代理。终稿经 task 工具结果聚合回父模型。

## 技能与 MCP

- **技能**：目录清单常驻系统提示，正文在被调用（斜杠命令 `/<技能名>` 或 `skill` 工具）时按需加载，详见[技能系统](./skills)
- **MCP**：实验特性（`AURORAAGENT_EXPERIMENTAL_MCP=1`），连接外部 MCP 服务器并把工具并入工具箱，详见 [MCP 服务器](./mcp)
