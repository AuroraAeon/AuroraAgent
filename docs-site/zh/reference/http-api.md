# HTTP API

同源 `/api/*`，全部 JSON；SSE 帧统一 `event:` + `data:` 两行。

## 对话底座

| 方法与路径 | 说明 |
| --- | --- |
| `POST /api/chat` | 速测底座：`{ messages, model?, provider?, thinking?, imagePath? }`，SSE 逐帧透传 / 翻译 |
| `GET /api/models` | 模型目录（内置 + 自定义提供方） |
| `GET /api/providers` · `POST /api/providers` · `PUT/DELETE /api/providers/:id` | 提供方 CRUD |
| `POST /api/providers/discover` | 拉取上游模型目录（只读） |

## Agent 运行时

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/agent/harnesses` | 三档模式清单 |
| `GET/POST /api/agent/sessions` | 会话列表 / 新建（titleMode 缺省继承全局配置） |
| `GET/PATCH/DELETE /api/agent/sessions/:id` | 详情（`{ meta, records }`）/ 改名换模型换模式换标题生成方式 / 删除 |
| `POST /api/agent/sessions/:id/fork` | 派生会话：复制 meta 与全部转录到新会话（新 id / 新时间戳 / 名字加「副本」后缀），goal 不随复制 |
| `POST /api/agent/turn` | 跑一个 turn（SSE 事件流）；单活跃 turn（409）；会话仍是默认名时，首轮总结标题并推送 `session_renamed`（titleMode 按请求体 > 会话 meta > 全局配置解析） |
| `POST /api/agent/abort` | 中止 turn（保留已生成内容） |
| `POST /api/agent/permission` | 权限决策 `{ requestId, decision: allow/deny/always }` |
| `POST /api/agent/plan` | 计划决策 `{ sessionId, decision: approve/reject }` |
| `GET /api/agent/skills` | 技能目录 |
| `GET /api/files/search?sessionId=&q=` | 会话工作目录内只读文件搜索（路径禁锢，跳过依赖目录）；会话不存在 404 |

## Goal（目标模式）

| 方法与路径 | 说明 |
| --- | --- |
| `GET /api/agent/goal/:id` | 读会话目标（无目标回 `{ goal: null }`） |
| `POST /api/agent/goal` | 创建目标 `{ sessionId, objective, tokenBudget? }`；存在未完成目标 409 `GOAL_STATUS_CONFLICT`，空白目标 400，会话不存在 404 |
| `POST /api/agent/goal/pause` · `/resume` · `/stop` | 用户面迁移；对 `complete` / `budget_limited` 恢复 active 拒绝 409 |
| `POST /api/agent/goal/budget` | 改 token 预算 `{ sessionId, tokenBudget, expectedUpdatedAt }`；纪元不符 409 `GOAL_STALE`，预算非法 400 |

## 设置

| 方法与路径 | 说明 |
| --- | --- |
| `GET/POST /api/settings` | 读设置 / 开机自启开关 |
| `GET/POST /api/settings/tui` | 终端偏好读写（`terminalTitle` 项序 + `notifications` 三档）；坏值 400，其他方法 405 |

## MCP（实验特性，未开启时 404）

| 方法与路径 | 说明 |
| --- | --- |
| `GET/POST /api/mcp/servers` | 列表 / 新增或更新 |
| `POST /api/mcp/servers/:id/probe` | 试连并列举工具 |
| `DELETE /api/mcp/servers/:id` | 删除 |
