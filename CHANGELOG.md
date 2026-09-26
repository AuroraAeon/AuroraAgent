# 变更日志

本文件记里程碑版本（Keep a Changelog 格式，中文）。逐提交的发布笔记由 `npm run docs:notes` 从 git 历史生成，进文档站 `release-notes` 页。

## [6.0.0] - 2026-09-27

对标 kimi-code 能力模型的全面升级。后端仍为零依赖 Node 内置模块，macOS 单用户定位、LaunchAgent 常驻、厂商事实层（模型 ID / `PRICE` / 纯色结论）均不变；缺省行为与 5.x 一致，新能力全部可选开启。

### 终端 TUI 规范化

- 新增零依赖工具包 `util/tui/`：语义色板（暗 / 亮双调 + 对比度守卫，全仓唯一允许原始 SGR 的文件）、Kitty CSI-u 键位解码、CJK 宽度感知截断、SearchableList 状态机、单选对话框（TTY 原始模式读键，非 TTY 退化为编号列表）、增量重绘、footer 状态条、声明式斜杠命令表
- `terminal.mjs` 重构为协调器，流式渲染与纯助手拆出 `terminal-turn.mjs` / `terminal-format.mjs`；`/sessions` `/harness` `/theme` 无参数弹出可搜索选择器（指针 / 当前项标记 / 输入即过滤）
- 设计规范单一真值源落文档站 `zh/reference/tui-design.md`
- 修复 raw mode 下 Ctrl+C 不中断生成的缺陷（readline `SIGINT` 事件中转）

### Agent 能力面

- **技能系统**（`util/agent/skills.mjs`）：`skills/` 内置 4 个（auroraagent-ops / code-review / systematic-debugging / test-writing）+ `<数据目录>/skills/` 用户目录；frontmatter 目录常驻系统提示，正文按需加载；`/<技能名>` 斜杠命令终端与网页同源（服务端单点解析），设置弹层可浏览目录
- **检索与待办工具**：`grep`（正则 + glob 文件名过滤 + 预算截断）、`glob`（跨目录路径匹配）、`todo`（规划清单随会话持久化）；工具新增 `extra` 契约——`diff` / `todos` 结构化负载进转录与事件供两端渲染，不进模型消息
- **子代理**（`util/agent/swarm.mjs`）：`task` 工具派发受限子 turn（真实子会话透明可查、继承 workspace 与会话权限规则、嵌套深度封顶 2 层、单次上限 4 个、父中止级联），终稿经工具结果聚合回父模型；网页嵌套工具卡 + 终端一级缩进呈现
- **MCP 客户端**（实验，`AURORAAGENT_EXPERIMENTAL_MCP=1` 门控，默认关）：`util/mcp/` 实现 JSON-RPC 2.0，stdio（spawn 行读写）与 HTTP（POST + SSE 复用）双传输；`mcp.json` 注册表原子落盘；外部工具以 `mcp__<服务器>__<工具>` 经同一套 kosong 接口入列（单服务器失败不阻塞其他）；`/api/mcp/servers` CRUD + probe；设置弹层管理面板 + 终端 `/mcp` 状态

### 权限与计划交互模型

- **权限三档** `permissionMode`（`always_ask` / `ask_when_needed` / `never_ask`，会话级）：设定 ask 类动作默认效应，不推翻 deny 与用户「总是允许」沉淀的会话规则；网页输入区下拉切换
- **计划模式** `planMode`（默认关）：计划轮只用只读 / 检索 / 待办工具产出计划，`plan_proposed` 等用户批准，批准后计划作为既定契约注入执行轮，驳回以 `plan_rejected` 收尾；网页计划卡（批准执行 / 驳回）+ 终端 `/plan` 与 y/n
- 三档与计划模式正交叠加在 harness（minimal / standard / ultimate）能力档之上，不替换它

### Web UI/UX

- 新增：技能斜杠调色板（`/` 浮现，↑↓ / Enter / Tab / Esc）、技能目录面板、MCP 管理面板、计划卡、会话级待办面板、`edit_file` 行级 diff 视图、零依赖语法高亮器（js/ts/python/json/sh/sql/go/rust/c 等语言族）、流式活动状态行（第 N 轮 · M 工具 · 走秒）
- 转录投影层 `util/agent/transcript.mjs`：工具标签 / 图标键 / 资源摘要 / 费用格式化的单一真值源 + `projectTurns` 分组规则，终端与网页共用（修复两端标签表漂移）

### 文档系统

- 新增 `docs-site/` VitePress 中英双语文档站（`npm run docs:dev`）：指南（快速开始 / Agent Loop / 网页 / 终端 / 技能 / MCP / 提供方）、速查（命令 / HTTP API / 配置 / 终端设计规范）、发布笔记三类结构；写作规约见 `docs-site/AGENTS.md`
- `tools/gen-release-notes.mjs` 从 git 历史生成发布笔记（幂等注入标记区）；文档站为开发期依赖例外，产物不提交

### 工程与质量

- `util/llm/` 抽象层：`tool.mjs` kosong 风格工具归一化与双协议转换、`errors.mjs` 状态码 → 中文错误分类、`message.mjs` 消息序列纯函数、`provider.mjs` `openChatStream` 统一开流入口（`/api/chat` 与 Agent Loop 共用同一套请求构造 / 连接期重试 / 错误话术 / 帧翻译选择）；`deferred` 标记工具不进请求顶层 `tools[]`，保持字节稳定命中提示缓存
- 实验特性框架：`AURORAAGENT_EXPERIMENTAL_<NAME>` 单开 / `AURORAAGENT_EXPERIMENTAL_FLAG` 全开，缺省关（`util/config.mjs` 单一实现）
- 仓库守卫入 `npm test`：产品源码零 emoji、TUI 颜色单一真值源、色板对比度、新模块 ≤500 行预算、文档站结构契约（中英页面一一对应）
- 测试基线 192/192（mock 上游 + 真实 socket，覆盖技能 / 计划两阶段 / 子代理 / MCP 全链路）

### 修复

- Agent Loop 从未透传 `extraTools`——MCP 工具 schema 不进请求，模型此前看不见外部工具
- MCP 路由只挂在 `/api/agent` 前缀下导致 404
- Anthropic 线路上下文压缩不翻译 SSE 帧
- Ultimate 模式系统提示要求 `task` 派发但工具集缺失
- 发布笔记生成重复追加闭合标记（注入非幂等）
- raw mode 下 Ctrl+C 不中断生成

### 升级注意

- 版本号 6.0.0（仅 `package.json` 一处，Info.plist 与 `/api/settings` 同源读取）
- 新增环境变量 `AURORAAGENT_EXPERIMENTAL_MCP`（默认关，不开时行为与 5.x 一致）
- 数据目录新增 `skills/`（用户技能）与 `mcp.json`（MCP 服务器配置，已在 `.gitignore`，不提交）
- 权限默认档 `ask_when_needed`、计划模式默认关——缺省行为与 5.x 一致

## [5.0.0] - 2026-09-26

- ModelTester → AuroraAgent 全套更名：环境变量（`AURORAAGENT_*`）、数据目录、config 文件名、LaunchAgent label、`.app` 名与日志名；一次性迁移保留 Key，旧 label 自动清理
- 数据目录三级回退与 `loadConfig` 从三处内联收敛到 `util/config.mjs` 单一实现（顺带修复 `web.mjs` 硬编码版本号与 `package.json` 脱节）
- README 重写为「本地 Agent 运行时」定位（Loop / 工具 / 权限 / 压缩 / 三档模式 / 双端接口 / 打包管线），速测底座完整保留
- 正文支持 LaTeX 公式渲染（KaTeX 自托管，`trust: false`）
