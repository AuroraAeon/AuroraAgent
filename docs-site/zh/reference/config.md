# 配置与环境变量

## 数据目录三级回退

1. `AURORAAGENT_DATA_DIR` 环境变量（LaunchAgent 显式指定）
2. 同目录已存在 `auroraagent.config.json` → 用当前目录（源码开发态）
3. 否则 `~/Library/Application Support/AuroraAgent`（App 态）

## 配置文件字段

`apiKey` / `model` / `thinking` / `temperature` / `maxTokens` / `permissionMode` / `planMode` / `titleMode` / `goal` / `tui`。

### goal 段（目标模式）

单叶损坏独立回退 + 钳制 + 启动告警；完整语义见 [Goal 模式指南](/zh/guide/goal-mode)。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `verification` | `none` | 验证档位：`none` / `evaluator` / `subagent` |
| `evaluatorModel` | 空 | evaluator 档必填；填了即隐含启用 evaluator |
| `evidence` | `brief` | 验证证据形态：`brief` / `transcript` |
| `repeatedReplyLimit` | 3 | 双熔断共享阈值 |
| `repeatedNotMetLimit` | 5 | `not_met` 连续次数转 `blocked(verifier_impossible)` |
| `graceSteps` | 1 | 轮次 / 时长触顶后的宽限轮数（0–3） |
| `mainTurns` | 0 | 续跑轮次上限，0 = 不限 |
| `activeSeconds` | 0 | 轮内活跃秒数上限，0 = 不限 |
| `evaluatorMaxTokens` | 4096 | evaluator 单次请求 token 上限 |
| `evaluatorTimeoutSeconds` | 60 | evaluator 超时（秒） |
| `evaluatorMaxRetries` | 1 | evaluator 重试封顶 |

### tui 段（终端偏好）

经 `GET/POST /api/settings/tui` 读写（设置页「终端」面板）；终端启动时读取一次，下一次启动生效。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `terminalTitle` | `['state','session','app']` | OSC 终端标题项序（保序去重）；`[]` = 显式关闭 |
| `notifications.when` | `unfocused` | 通知时机：`unfocused` / `always` / `never` |
| `notifications.method` | `auto` | 通知通道：`auto` / `osc9` / `osc777` / `bel` |
| `notifications.events` | 四类全开 | 事件集合：`turn-complete` / `turn-failed` / `permission-required` / `question-required` |

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
