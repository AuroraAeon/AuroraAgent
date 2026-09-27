# Goal 模式

Goal 模式给会话挂一个**跨轮次存续的目标**：模型自主推进、验证、续跑，直到完成、受阻或预算耗尽，中途你随时可以暂停、恢复、改预算或叫停。语义对齐 MiniMax-code 的 thread-goal 能力，按本地单用户场景零依赖落地（`util/agent/goal/`）。

## 什么时候用

- 任务需要很多轮工具调用，你不想每轮盯：「盯着把这个仓库的测试全部修绿」
- 需要独立的完成度判定，而不是模型自己说完成就算完成
- 需要给自动推进加硬闸：token 预算、轮次预算、活跃时长、无进展熔断

不适合：一轮能答完的提问（直接对话即可）；模型只在「用户明确要求盯着目标」时才该 `create_goal`，不会从普通任务里推断目标。

## 三方权限

状态语义由三方共同推进，权限刻意不对称：

| 角色 | 能做什么 |
| --- | --- |
| 模型 | `update_goal` 提案 `complete` / `blocked`；仅在用户显式要求改预算的轮次里，带新鲜 `get_goal` 快照改 `token_budget` |
| 用户 | 除「把预算或工作量已耗尽的目标恢复成 active」之外的全部迁移：暂停、停止、恢复 `paused` / `blocked` / `usage_limited` |
| 系统 | 记账绑定：`tokensUsed >= tokenBudget` 时自动迁到 `budget_limited` |

一会话至多一个目标（`<数据目录>/goals/<sessionId>.json` 原子落盘）；仅当旧目标 `complete` 时才允许替换。

## 六态状态机

`active` / `paused` / `blocked` / `complete` / `budget_limited` / `usage_limited`。

- **终态**（`complete` / `blocked` / `budget_limited` / `usage_limited`）停止自动续跑；能否恢复是另一回事——`complete` 是终态中的终态，任何迁移都不允许；对 `complete` / `budget_limited` 恢复 active 一律 409 拒绝
- 每次迁移都带 `statusReason`（闭集，如 `complete(verifier_met)` / `paused(no_progress)` / `budget_limited(token)`），终端与网页原样展示

## 模型侧三工具

名字与 schema 对齐 codex / minimax-code，模型对这套工具有先验，零学习成本；仅 Standard / Ultimate 模式收录，Minimal 不收录。

| 工具 | 作用 |
| --- | --- |
| `create_goal(objective, token_budget?)` | 建立目标；已存在未完成目标时失败 |
| `update_goal(mode?, status?, summary?, token_budget?, expected_goal_id?, expected_updated_at?)` | 提案终态，或（仅用户显式要求时）改预算 |
| `get_goal()` | 读当前目标：状态、时间戳、用量、预算 |

`update_goal` 的两个模式刻意分开：默认是「提案模式」（`status` 提案 `complete` / `blocked`，带 `summary`）；预算模式必须紧邻一次 `get_goal` 快照调用，只传 `token_budget` + `expected_goal_id` + `expected_updated_at`（CAS 纪元校验，陈旧快照 409）。混合传参一律拒绝；`null` 填充豁免。

## 预算与熔断

- **token 预算**：每轮结束经用量账本累计 `tokensUsed`；触顶自动转 `budget_limited(token)`，并追加唯一一个无工具的收尾轮——只总结「已完成 / 未完成 / 为何停止」，并告知可经 `update_goal` 调整预算后续跑
- **轮次 / 时长预算**：`goal.mainTurns`（续跑轮次上限）与 `goal.activeSeconds`（轮内活跃秒数）触顶转 `budget_limited(main_turn)` / `budget_limited(active_time)`；`graceSteps` 是触顶后的宽限轮数（默认 1）
- **重新武装**：抬高或清零 `token_budget` 可把 `budget_limited(token)` 恢复为 `active`（模型侧走 CAS 预算模式，用户侧走 `/goal budget`）
- **双熔断**：归一化回复指纹连续重复（`noProgressStreak`）与「连续无工具提交轮」（`noToolStreak`）共享阈值 `goal.repeatedReplyLimit`（默认 3），互不累加；任一触发转 `paused(no_progress)`

## 验证三档

`goal.verification`：`none`（默认，不验证）/ `evaluator` / `subagent`。

- **evaluator**：经同一路由用小快模型低温一次请求裁决 `met` / `not_met` / `impossible` / `inconclusive`（`goal.evaluatorModel` 必填，`maxTokens` 4096、超时 60s、裁决层重试封顶 1 次）；模型的 `summary` 一律作不可信数据提交，目标 / 自述 / 转录对验证器只是数据不是指令。`inconclusive`（含载荷不完整降级）触发至多一次重试。`not_met` 时验证器还需逐条给出 `missing` 缺口清单（每条一句话、最多 50 条），随续跑反馈与横幅 / 终端摘要展示
- **subagent**：经子代理系统派发只读 profile（`goal-verifier-readonly`）独立核查
- **证据形态** `goal.evidence`：`brief`（默认）/ `transcript`
- **结算**：`met` → `complete(verifier_met)`；`impossible` → `blocked(verifier_impossible)`；`not_met` 连续 `goal.repeatedNotMetLimit`（默认 5）次且缺口集合始终相同 → `paused(no_progress)`（缺口变化则重新计数）；`inconclusive` 按 code 归因暂停（`schema_error` → `paused(verifier_protocol)`，其余 → `paused(verifier_unavailable)`）；验证器自身不可用 → `paused(verifier_unavailable)`。任何情况下不静默放行

本地工具不做隐式路由推导：只有显式配置 `goal.evaluatorModel` 才走 evaluator。

## 自动续跑

适配单 SSE turn 模型，不建队列子系统：turn 内模型不再要求工具、而目标仍 `active`、无终态提案、未触预算 / 熔断时，注入 goal-continuation 系统提醒续轮（受 harness 轮次上限与 goal 主轮预算双重封顶）。你发新消息即收尾，目标状态延续到下一次用户 turn。等待授权 / 计划批准 / 验证时发布 `goal_wait_changed`（`executionWait`），两端渲染「等待中」而非「卡住」。

在 turn 进行中改写目标文本（网页 `/goal edit` / Composer 或 REST）时，在飞模型不会蒙在鼓里：下一轮即收到【目标已更新】提醒——新目标按不可信数据包裹（`<untrusted_objective>`）并附预算快照（已用 / 上限 / 剩余，无预算记 `unlimited`），模型据此调整方向，不再继续只为旧目标服务的工作；针对旧目标提出的待定终态提案同时作废（对齐 MiniMax `renderObjectiveUpdatedPrompt` 与绑定失配取消语义）。

活跃目标在每次用户轮的首轮即重述（对齐 MiniMax 每轮准入注入 `continuationBody`）：上下文压缩把 `create_goal` 的工具调用挤出窗口后，模型在新用户轮里仍然知道在追什么；每 5 个 goal 轮附带一次例行状态审计（对齐 MiniMax `reminder-policy` 的 terminal-audit），提醒对照当前证据重估完成 / 受阻，避免无限推进从不提案。

## 用户面操作

终端与网页 Composer 共用同一份 `/goal` 命令解析（`util/agent/goal/command.mjs` 单一事实源，语义对齐 MiniMax-code 的 `thread-goal-command`），两端行为完全一致：

```bash
/goal                          # 查看当前目标：状态 / 目标内容 / 用量 / 预算 / 最近验证 / 可用操作
/goal 把 README 安装章节改写    # 设立目标；已有未完成目标时改写目标文本
/goal 修复登录 bug budget=50K  # 设立目标并一并设 token 预算（K / M 后缀）
/goal budget=50K               # 只改当前目标预算；也接受旧式 /goal budget 50000
/goal budget=clear             # 清除预算上限（clear / null / none / off / 0 同义）
/goal edit                     # 把当前目标文本填回输入框续编（终端即行回填，网页回填 Composer）
/goal clear                    # 移除目标（cancel / delete 同义；与 stop 的「标记完成」并存，clear 是彻底移除）
/goal pause                    # 暂停（active → paused）
/goal resume                   # 恢复（paused / blocked / usage_limited → active）
/goal stop                     # 标记完成并停止追踪（complete(user_requested)）
/goal help                     # 命令帮助
```

网页：聊天框直接输入上述命令（整段以 `/goal` 开头即被拦截，不当作普通消息发送）；view / help / 错误以系统消息回复，create 在已有未完成目标时自动转为「改写目标文本」，budget 变更携带 `expectedGoalId` + `expectedUpdatedAt` 新鲜快照。会话顶部 GoalBanner 展示状态芯片、目标内容、tokens / 轮次 / live 时长、预算上限、最近验证结论（`not_met` 附前 2 条 `missing` 缺口，超出记 `+N`）与随状态裁剪的操作提示；`active` 且等待授权 / 验证时芯片改用等待标签（对齐 MiniMax goalPresentation），目标转 `complete` 时横幅隐藏、消息流贴一条同源完成回执。暂停 / 恢复 / 停止即点即走。

REST 面对应 `GET /api/agent/goal/:id`、`POST /api/agent/goal`（创建，未完成目标存在时 409 `GOAL_STATUS_CONFLICT`）、`POST /api/agent/goal/edit`（改写，空白 400 `GOAL_BAD_OBJECTIVE`，已完成 409）、`POST /api/agent/goal/clear`（幂等移除，回 `{cleared}`）与 `POST /api/agent/goal/{pause,resume,stop,budget}`。

事件协议（两端共用 SSE）：`goal_created` / `goal_status_changed` / `goal_usage_updated` / `goal_wait_changed`。

## 配置

`auroraagent.config.json` 的 `goal` 段（单叶损坏独立回退 + 钳制 + 启动告警，一个错值不让整个模式失效）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `verification` | `none` | 验证档位：`none` / `evaluator` / `subagent` |
| `evaluatorModel` | 空 | evaluator 档必填；填了即隐含启用 evaluator |
| `evidence` | `brief` | 验证证据形态：`brief` / `transcript` |
| `repeatedReplyLimit` | 3 | 双熔断共享阈值 |
| `repeatedNotMetLimit` | 5 | `not_met` 连续次数（缺口集合相同才累加）转 `paused(no_progress)` |
| `graceSteps` | 1 | 轮次 / 时长触顶后的宽限轮数（0–3） |
| `mainTurns` | 0 | 续跑轮次上限，0 = 不限 |
| `activeSeconds` | 0 | 轮内活跃秒数上限，0 = 不限 |
| `evaluatorMaxTokens` | 4096 | evaluator 单次请求上限 |
| `evaluatorTimeoutSeconds` | 60 | evaluator 超时 |
| `evaluatorMaxRetries` | 1 | evaluator 重试封顶 |
