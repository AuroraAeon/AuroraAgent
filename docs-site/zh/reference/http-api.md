# HTTP API

同源 `/api/*`，全部 JSON；SSE 帧统一 `event:` + `data:` 两行。

## 对话底座

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/chat` | 速测底座：`{ messages, model?, provider?, thinking?, imagePath? }`，SSE 逐帧透传 / 翻译 |
| `GET /api/models` | 模型目录（内置 + 自定义提供方） |
| `GET /api/providers` · `POST /api/providers` · `PUT/DELETE /api/providers/:id` | 提供方 CRUD |
| `POST /api/providers/discover` | 拉取上游模型目录（只读） |
| `GET /api/providers/catalog` | 提供方预设目录（14 家厂商的端点与预置模型 ID，`gemini` / `responses` 格式端点入数据不激活） |

## Agent 运行时

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/agent/harnesses` | 三档模式清单 |
| `GET/POST /api/agent/sessions` | 会话列表 / 新建（titleMode 缺省继承全局配置） |
| `GET/PATCH/DELETE /api/agent/sessions/:id` | 详情（`{ meta, records }`）/ 改名换模型换模式换标题生成方式 / 思考开关 / 删除 |
| `POST /api/agent/sessions/:id/fork` | 派生会话：复制 meta 与全部转录到新会话（新 id / 新时间戳 / 名字加「副本」后缀），goal 不随复制 |
| `POST /api/agent/turn` | 跑一个 turn（SSE 事件流）；单活跃 turn（409）；`side:true` 跑侧边对话（`/btw`，内存门面、不落盘、不接管 goal、不派发子代理，与主对话互斥）；会话仍是默认名时，首轮总结标题并推送 `session_renamed`（titleMode 按请求体 > 会话 meta > 全局配置解析） |
| `POST /api/agent/abort` | 中止 turn（保留已生成内容） |
| `POST /api/agent/permission` | 权限决策 `{ requestId, decision: allow/deny/always }` |
| `GET /api/agent/queue/:id` | 查某会话的消息队列（`queued` / `running` / `held`，按入队序）；会话不存在 404 |
| `POST /api/agent/queue/promote` | 把选中项挪到队首立即发送 `{ sessionId, opId }`；队列里没有这一条 404 |
| `POST /api/agent/queue/remove` | 移除等待中的项 `{ sessionId, opId }`；已在执行的那条 409（请改用停止），不存在 404 |
| `GET /api/shots/:sessionId/:file` | `computer_use` 截图静态路由（仅 `.png` / `.jpg` / `.jpeg`，正则白名单 + 目录禁锢；删除会话即清目录） |
| `POST /api/agent/plan` | 计划决策 `{ sessionId, decision: approve/reject }` |
| `GET /api/agent/skills` | 技能目录 |
| `GET /api/files/search?sessionId=&q=` | 会话工作目录内只读文件搜索（路径禁锢，跳过依赖目录）；会话不存在 404 |
| `GET /api/agent/checkpoints?sessionId=` | 检查点（快照）列表，含快照路径类型；会话不存在 400 |
| `GET /api/agent/checkpoints/preview?sessionId=&turnIndex=` | 回滚预览：该轮之后动过的文件；无此检查点 404 |
| `POST /api/agent/checkpoints/restore` | 回滚到某一轮 `{ sessionId, turnIndex, restoreFiles?, restoreChat? }`（默认只回滚工作区不动对话）；恢复失败 409 |
| `DELETE /api/agent/checkpoints` | 清理本会话检查点（清 git 私有 ref 与镜像备份） |
| `GET /api/agent/hooks?workspace=` | 事件钩子清单与实验门控状态（未开门控也 200，`enabled:false`） |
| `GET /api/agent/observations?kind=&sessionId=&limit=` | 提及时可引用的「观察」：`kind=problems` 读错误日志、`kind=terminal` 扫本会话跑过的命令；未知 kind / 缺 sessionId 400 |
| `GET /api/sessions/search?q=` | 会话全文检索（标题 + 转录，BM25 排序）；`/api/agent/sessions/search` 同义；缺 q 400 |

turn SSE 事件里与队列 / 定时任务相关的两帧：`turn_queued`（提交已入队，带 `position` 与 `duplicate`）与 `jobs_changed`（turn 内改了定时任务）。

## Goal（目标模式）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/agent/goal/:id` | 读会话目标（无目标回 `{ goal: null }`） |
| `POST /api/agent/goal` | 创建目标 `{ sessionId, objective, tokenBudget? }`；存在未完成目标 409 `GOAL_STATUS_CONFLICT`，空白目标 400，会话不存在 404 |
| `POST /api/agent/goal/edit` | 改写未完成目标文本 `{ sessionId, objective }`；可随文带 `tokenBudget` 一并改预算（此时需 `expectedGoalId` + `expectedUpdatedAt` 新鲜快照，不符 409 `GOAL_STALE`）；空白 400 `GOAL_BAD_OBJECTIVE`，已完成 409，无目标 404 |
| `POST /api/agent/goal/clear` | 幂等移除目标，回 `{ cleared }`（无目标也 200） |
| `POST /api/agent/goal/pause` · `/resume` · `/stop` | 用户面迁移；对 `complete` / `budget_limited` 恢复 active 拒绝 409 |
| `POST /api/agent/goal/budget` | 改 token 预算 `{ sessionId, tokenBudget, expectedUpdatedAt }`；纪元不符 409 `GOAL_STALE`，预算非法 400 |
| `GET /api/agent/side/:sessionId` | 查询侧边对话（`/btw`）转录；没有侧边对话 404 |
| `POST /api/agent/side/discard` | 丢弃侧边对话（幂等，回 `discarded`） |
| `GET /api/agent/events?sessionId=` | 跨客户端 goal 事件流（SSE）：另一客户端（终端 / 另一标签页）经 REST 改动目标时即时推送 `goal_created` / `goal_status_changed` / `goal_cleared`（turn 内的 goal 事件仍走 turn SSE）；订阅即写 SSE 注释帧冲掉响应头，连接关闭自动退订；未知会话 404 |

## 设置

| 方法与路径 | 说明 |
| --- | --- |
| `GET/POST /api/settings` | 读设置 / 开机自启开关 |
| `GET/POST /api/settings/tui` | 终端偏好读写（`terminalTitle` 项序 + `notifications` 三档）；坏值 400，其他方法 405 |
| `GET/POST /api/settings/proxy` | Agent 沙箱出站代理读写（`agentProxy`：`http://主机:端口`，空 = 直连）；socks5 等坏值 400，其他方法 405 |
| `GET/POST /api/settings/failover` | 多提供方故障转移偏好读写（`providerFailover` 布尔 + `providerFailoverMaxAttempts` 1–5）；非布尔 / 越界 400，其他方法 405 |
| `GET/POST /api/settings/generation` | 生成参数读写（`temperature` 0–1、`maxTokens` 正整数 ≤1000000，局部合并）；越界 / 非整数 400，空体 400，其他方法 405 |
| `GET/POST /api/settings/key` | API Key 写入（`apiKey` 非空、无空白、≤200 字符）与「有没有 Key」查询；GET 只回 `hasKey`，绝不回传 Key 本身；环境变量 Key 生效时写盘无效，返回 409 |
| `GET/POST /api/settings/rules` | 规则开关表读写：GET 回报发现到的规则（来源 / 条件 / 是否激活）与开关值，POST 整表替换 |

## 定时任务

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/jobs` | 任务列表；带 `?sessionId=` 只读该会话的 |
| `POST /api/jobs` | 新建任务 `{ name, sessionId, prompt, schedule, enabled? }`；校验失败 400（间隔下限 60 秒、上限 366 天，单会话上限 200 个） |
| `DELETE /api/jobs/:id` | 删除任务（幂等，回 `{ removed }`） |
| `POST /api/jobs/:id/run` | 立即跑一次（目标会话忙则入队）；执行失败 500 |
| `POST /api/jobs/:id/toggle` | 启停 `{ enabled }`；非布尔 400 |
| `GET /api/jobs/events` | 任务变更长连接（SSE）：`jobs_changed` 帧，连接关闭自动退订 |

## MCP（实验特性，未开启时 404）

| 方法与路径 | 说明 |
| --- | --- |
| `GET/POST /api/mcp/servers` | 列表 / 新增或更新 |
| `POST /api/mcp/servers/:id/probe` | 试连并列举工具 |
| `DELETE /api/mcp/servers/:id` | 删除 |
