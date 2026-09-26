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
| `GET/POST /api/agent/sessions` | 会话列表 / 新建 |
| `GET/PATCH/DELETE /api/agent/sessions/:id` | 详情（`{ meta, records }`）/ 改名换模型换模式 / 删除 |
| `POST /api/agent/turn` | 跑一个 turn（SSE 事件流）；单活跃 turn（409） |
| `POST /api/agent/abort` | 中止 turn（保留已生成内容） |
| `POST /api/agent/permission` | 权限决策 `{ requestId, decision: allow/deny/always }` |
| `POST /api/agent/plan` | 计划决策 `{ sessionId, decision: approve/reject }` |
| `GET /api/agent/skills` | 技能目录 |

## MCP（实验特性，未开启时 404）

| 方法与路径 | 说明 |
| --- | --- |
| `GET/POST /api/mcp/servers` | 列表 / 新增或更新 |
| `POST /api/mcp/servers/:id/probe` | 试连并列举工具 |
| `DELETE /api/mcp/servers/:id` | 删除 |
