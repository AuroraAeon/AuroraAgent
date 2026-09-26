# 配置与环境变量

## 数据目录三级回退

1. `AURORAAGENT_DATA_DIR` 环境变量（LaunchAgent 显式指定）
2. 同目录已存在 `auroraagent.config.json` → 用当前目录（源码开发态）
3. 否则 `~/Library/Application Support/AuroraAgent`（App 态）

## 配置文件字段

`apiKey` / `model` / `thinking` / `temperature` / `maxTokens` / `permissionMode` / `planMode`。

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `AURORAAGENT_API_KEY` | API Key（优先于配置文件） |
| `AURORAAGENT_BASE_URL` | 上游 Base URL（优先于配置文件） |
| `AURORAAGENT_THEME` | 终端主题 `dark` / `light` / `auto` |
| `AURORAAGENT_EXPERIMENTAL_MCP` | 开启 MCP 实验特性 |
| `AURORAAGENT_EXPERIMENTAL_FLAG` | 开启全部实验特性 |
| `PORT` / `NO_OPEN` | 网页端口 / 不自动开浏览器 |
| `LOG_LEVEL` | `debug` 时输出调试日志 |

## 不提交的机密文件

`auroraagent.config.json`、`usage.jsonl`、`providers.json`、`mcp.json`、`sessions/`——均在 `.gitignore`，Key 泄露即安全事故。
