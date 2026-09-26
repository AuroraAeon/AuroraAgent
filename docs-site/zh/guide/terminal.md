# 终端 TUI

终端客户端 `npm run chat`：与网页共用同一套 Loop / 会话 / 账本，交互按 [终端设计规范](../reference/tui-design) 执行。

## 斜杠命令

| 命令 | 作用 |
| --- | --- |
| `/new` | 新建会话 |
| `/sessions` | 会话列表（光标选择、搜索、翻页） |
| `/model` | 模型选择器（按提供方分组、搜索、当前项标记） |
| `/harness` | 模式切换（minimal / standard / ultimate） |
| `/think` | 思考流展示开关 |
| `/temp` | 温度 |
| `/max` | 最大 tokens |
| `/key` | 更新 API Key 并保存 |
| `/plan` | 计划模式开关 |
| `/mcp` | MCP 服务器状态（实验特性） |
| `/help` | 帮助 |
| `/quit` | 退出 |
| `-p "问题"` | 单次提问（`npm run chat -- -p "..."`） |

## 技能命令

每个技能自动生成 `/<技能名>` 命令，参数跟在名称后，技能正文作为任务规范注入当轮。

## 交互细节

- 列表型对话框：`❯` 指针 + `← current` 当前项标记 + hint 行（`↑↓ navigate · Enter select · Esc cancel`）
- 搜索：直接打字，`Backspace clear`，Esc 两段式（先清空搜索再取消）
- 思考流暗色输出、工具单行状态刷新、权限询问 `y` / `n` / `a`（允许 / 拒绝 / 总是允许）
- footer 状态条：模型 · 模式 · 思考 · cwd · tokens / 费用
- 字符比较一律经 `printableChar()`（Kitty CSI-u 解码），功能键用 `matchesKey`
