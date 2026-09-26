# MCP 服务器（实验特性）

AuroraAgent 内置 [Model Context Protocol](https://modelcontextprotocol.io) 客户端（`util/mcp/`，纯 Node 实现，JSON-RPC 2.0）。连接外部 MCP 服务器后，其工具以 `mcp__<服务器>__<工具>` 之名进入 Agent 工具箱，与其他工具一样经权限门控（默认询问）。

## 开启

```bash
AURORAAGENT_EXPERIMENTAL_MCP=1 npm run web
```

（实验特性目录：`AURORAAGENT_EXPERIMENTAL_<NAME>` 单开，`AURORAAGENT_EXPERIMENTAL_FLAG` 全开，缺省关。）

## 管理

- **网页**：设置 → MCP 服务器：新增（stdio 命令 + 参数，或 HTTP + SSE 端点）、测试连接、查看工具数与连接状态、删除
- **终端**：`/mcp` 状态命令
- 配置落 `<数据目录>/mcp.json`（原子落盘，不提交仓库）

单个服务器连接失败不阻塞其他服务器，错误随状态透出。

## 请求格式细节

`deferred` 标记的工具不进请求顶层 `tools[]`（保持字节稳定以命中提示缓存），但 Loop 侧仍可解析执行——模型凭记忆发起调用时不会 400。
