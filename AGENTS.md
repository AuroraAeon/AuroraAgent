# AGENTS.md — AuroraAgent 项目宪法

> 本文件是写给 AI 编码 agent 的项目规约。人类用户文档见 `README.md`；两者冲突时，以真实代码行为为准，并顺手修正文档。
> 优先级：用户当前对话指令 > 本文件 > agent 的默认习惯。本文件是活文档——每次踩坑后，把教训补进来。

---

## 0. 第一铁律：小改动，快提交，勤推送

**每做出一个通过测试的小改动，必须立即 `git commit` 并 `git push`。不要攒批、不要等用户提醒、不要留在本地。**

执行顺序永远是：

1. 改代码（一个可独立验证的小改动，例如「修复一个错误映射」「新增一个厂商标识」）
2. `npm test` 全绿（基线 213 个测试；不绿不准提交）
3. `git add <具体文件>` → `git commit -m "中文描述"` → `git push`

规约：

- 粒度：一次提交只做一件事；大任务拆成多次提交，每次提交后仓库都必须处于可运行、测试全绿的状态
- 提交信息：中文，一句话说清「改了什么、为什么」，如 `fix(chat): 401 错误映射补充额度不足分支`
- 身份与远端：`user.name=AuroraAeon` / `user.email=auroraaeon@users.noreply.github.com`；`origin` = https://github.com/AuroraAeon/AuroraAgent（private，master 分支）
- 凡触及真实上游行为的改动（请求格式、错误映射、模型目录解析、tools 拼装），提交前额外跑一次 `npm run check`
- 推送失败先诊断（网络 / 权限），不得 `--force` 绕过，不得改写已推送的历史
- 改了 `web-ui/` 源码必须同步 `npm run build:web` 并提交 `public/app/` 产物（运行时零构建的保证）

---

## 1. 项目是什么

AuroraAgent 是「本地 Agent 运行时」：终端 + 网页双客户端共用同一套 Agent Loop（会话 / 轮次 / 工具 / 权限 / 上下文压缩），对标 OpenBitFun 的本地化实现；「全球厂商最新大模型速测」能力完整保留为底座（`/api/chat`、自定义提供方、用量账本）。

产品形态与技术底线：

- 单用户本地工具，**仅支持 macOS**（依赖 LaunchAgent 与 `~/Library` 目录约定）
- **后端零依赖**：只用 Node 18+ 内置模块；ESM `.mjs`；无构建步骤
- **前端依赖例外**：`web-ui/` 用 React 19 + Vite 7 + TypeScript + KaTeX，依赖（react / react-dom / katex / vite / typescript / @vitejs/plugin-react / @types/*）**仅限 `web-ui/`**；构建产物随仓库提交在 `public/app/`，后端与 Bundle 运行时不接触 node_modules
- **文档站依赖例外**：`docs-site/` 用 VitePress（唯一依赖）搭建中英双语文档站；`docs-site/node_modules` 与构建产物**不提交**，仅开发期使用，后端与运行时零接触
- 双客户端：终端（`chat.mjs` → `util/agent/terminal.mjs`）+ 网页（`web.mjs` 服务 `public/app/` React 产物），共享同一套配置、会话、账本数据目录
- 可打包为独立 macOS Application（`~/Applications/AuroraAgent.app`，显示名 AuroraAgent），由 LaunchAgent `com.auroraagent.app` 常驻
- 当前接入厂商：美团 LongCat-2.5-Preview。Base URL / 模型目录 / Key 全部是配置项——**代码不绑定厂商**，接入新厂商不改架构
- 自定义 Provider：设置页可加任意 OpenAI 兼容 / Anthropic Messages 上游（存储、校验、发现、路由在 `util/providers.mjs` + `util/wire.mjs`，前端在 `web-ui/src/components/ProviderEditor.tsx`）；内置提供方只读，请求载荷保持历史形态
- Agent 能力面（6.0.0 起对齐 kimi-code 能力模型，全部零依赖自实现）：技能（`skills/` 内置 + `<数据目录>/skills/` 用户，frontmatter 目录常驻系统提示，`/<技能名>` 斜杠命令与 `skill` 工具按需加载正文）、子代理（`task` 工具派发受限子 turn）、计划模式（先出计划、批准才执行）、权限三档（`always_ask` / `ask_when_needed` / `never_ask`）、MCP 客户端（stdio / HTTP 双传输，`AURORAAGENT_EXPERIMENTAL_MCP=1` 门控，默认关）

## 2. 架构地图

| 文件 | 职责 |
| --- | --- |
| `web.mjs` | 网页服务核心：`/api/*` 路由平铺、SSE 代理、停止中断、模型目录（单飞加载 + 60s 缓存）、`/app/` 静态服务（React 产物 + SPA 回退 + 防目录穿越）；Provider / LaunchAgent / SSE 泵 / 账本 / Agent HTTP 面已拆到 `util/`，静态资源走 `STATIC_ASSETS` 白名单 |
| `chat.mjs` | 终端客户端入口：main 委派 `runTerminal`；保留旧对话通道 `streamChat` 与配置导出（`tools/color-test.mjs` 依赖） |
| `check.mjs` | 连接自检：Key 校验 → 模型列表 → 一条最小真实请求（会花少量钱） |
| `util/config.mjs` | 数据目录三级回退 + 配置读写 + `PRICE`（chat / check / web / color-test 共用） |
| `util/sse.mjs` | SSE 解析器 `SseParser` + token 估算（测试与后端共享） |
| `util/providers.mjs` | 自定义 Provider：存储（`providers.json` 原子落盘）、ID/端点/协议/模型目录/单价/API 密钥格式校验（与 dsh 同规约）、上游模型发现、`/api/providers` 路由处理 |
| `util/wire.mjs` | 协议适配：OpenAI 兼容与 Anthropic Messages 的 URL 拼接、请求拼装（含 `tools` / `tool_choice`）、Anthropic SSE 帧翻译成 OpenAI 帧（含 `tool_use` / `input_json_delta`） |
| `util/stream.mjs` | SSE 透传 / 翻译泵（逐帧转发 + 用量累计，供 `/api/chat`）；`consumeAgentStream` 增量累积 `tool_calls` delta 供 Loop 使用 |
| `util/usage.mjs` | 用量账本：逐行追加 + 汇总出口 |
| `util/service.mjs` | LaunchAgent 生命周期：plist 生成 / 安装 / 卸载 / 状态 |
| `util/agent/events.mjs` | AgentEvent 协议（OpenBitFun AgenticEvent 精简子集）+ SSE 帧封装；`session_renamed` 供两端实时刷新自动总结出的标题 |
| `util/agent/harness.mjs` | 三档模式契约 minimal / standard / ultimate：系统提示、工具集、轮次上限（1 / 24 / 64）、压缩阈值；Creative 留待后续 |
| `util/agent/session.mjs` | 会话存储：`sessions/<id>.meta.json` 原子落盘 + `.jsonl` 追加式转录；投影重建容错误行；create / list / get / patch / delete |
| `util/agent/title.mjs` | 会话标题自动总结：首条用户消息本地推导简短标题（零成本纯函数，不调模型）——首行提取 / markdown 噪声剥离 / 技能注入取用户原话 / 斜杠命令取参数 / emoji 与控制符清洗 / CJK 宽度截断（≤24 列）；仅会话仍是 `DEFAULT_SESSION_NAME` 时套用 |
| `util/agent/title-model.mjs` | 模型总结标题：titleMode=model 时一次无工具低温请求（≤64 token，参考首条消息与终稿）生成标题，失败回退本地推导；成本记 `purpose:'title'` 账本与会话汇总，不进转录与轮次脚注 |
| `util/tui/` | 终端 TUI 工具包（零依赖）：`theme.mjs` 语义色板暗/亮双调 + 对比度守卫（全仓库唯一允许原始 SGR 的文件）；`render.mjs` CJK/ANSI 感知宽度截断；`printable-key.mjs` Kitty CSI-u 解码；`searchable-list.mjs` 光标/搜索/翻页状态机；`select.mjs`+`pick.mjs` 单选对话框（TTY 原始模式读键 + 非 TTY 退化）；`footer.mjs` 状态条；`commands.mjs` 声明式斜杠命令；`screen.mjs` 增量重绘；规范单一真值源 `docs-site/zh/reference/tui-design.md` |
| `util/llm/` | LLM 抽象：`tool.mjs` kosong 风格 Tool 归一化与 OpenAI/Anthropic 双协议转换（`tools.mjs` 共用，`deferred` 标记的工具不进请求顶层 `tools[]` 以保字节稳定）；`errors.mjs` 状态码 → 中文错误分类（额度措辞先于 400）；`provider.mjs` `openChatStream` 统一开流入口（`/api/chat` 与 Loop 共用，非 2xx 抛带 kind/status 的 Error）；`message.mjs` OpenAI ↔ Anthropic 消息序列纯函数 |
| `util/agent/tools.mjs` | 十一个内置工具（read_file / list_dir / write_file / edit_file / shell / web_fetch / grep / glob / todo / skill / task）：JSON Schema、`resolveInside` 路径禁锢（拒绝穿越）、输出截断、shell 超时（默认 30s 上限 120s）；MCP 与技能工具经 `util/llm/tool.mjs` 归一化后同形态入列 |
| `util/agent/policy.mjs` | 权限策略：`{action, resource, effect}` 规则集，层内后匹配赢、多层取最严（deny > ask > allow）；`permissionMode` 三档（always_ask / ask_when_needed / never_ask）设定 ask 类动作默认效应，不推翻 deny 与会话级「总是允许」；action 支持 `mcp__*` 前缀通配 |
| `util/agent/context.mjs` | 上下文组装（系统提示 + 历史 + 工具定义；thinking/usage 不回填、summary 转系统消息）与压缩规划（超窗口 70% 触发，保留最近 4 个用户轮原文） |
| `util/agent/loop.mjs` | turn 运行器：轮次循环至无 tool_calls 或触顶；计划 / 执行两阶段（`plan.mjs`）；权限经 pending map 挂起等前端决策；`AbortController` 中断保留已生成内容（子代理级联中止）；SSE 断开即中止；MCP 等额外工具经 `extraTools` 进请求；每轮经 `usage.mjs` 记账 |
| `util/agent/http.mjs` | `/api/agent/*` 与 `/api/mcp/*` HTTP 面（web.mjs 前缀委派）：会话 CRUD + PATCH、turn SSE、abort、permission、harnesses、skills 目录、plan 决策通道、MCP 服务器 CRUD + probe（实验门控）；单活跃 turn（409） |
| `util/agent/terminal.mjs` | 终端 REPL 协调器：readline + 声明式斜杠命令表（`defineCommands`）+ footer 状态条 + 可搜索选择器；`-p` 单次提问；行数预算内拆出下面两个模块 |
| `util/agent/terminal-turn.mjs` | 终端 turn 渲染器：AgentEvent → 思考流 / 工具单行 / 权限 y/n/a / 用量脚注；Ctrl+C 经 rl 'SIGINT' 事件中转中断（raw mode 下无真信号） |
| `util/agent/terminal-format.mjs` | 终端渲染纯助手：工具标签、截断、费用格式化、输出缩进（coordinator 与 turn 渲染器共用；标签与费用已转置到 `transcript.mjs` 同源） |
| `util/agent/skills.mjs` | 技能系统：frontmatter（name + description）解析、内置 + 用户双目录、目录清单注入系统提示、`/<技能名>` 斜杠命令与 `skill` 工具按需加载正文 |
| `util/agent/plan.mjs` | 计划模式：计划轮只读 / 检索 / 待办工具白名单（单点定义）、批准后作为既定契约注入执行轮、驳回以 `plan_rejected` 收尾 |
| `util/agent/swarm.mjs` | 子代理：`task` 工具派发受限子 turn（真实子会话透明可查、嵌套深度封顶 2 层、单次上限 4 个、父中止级联），终稿经工具结果聚合回父模型 |
| `util/agent/transcript.mjs` | 转录投影层：工具标签 / 图标键 / 资源摘要 / 费用格式化的单一真值源 + `projectTurns` 记录分组规则（终端与 Web 共用；配套 `transcript.d.mts` 供 TS 取类型） |
| `util/mcp/` | MCP 客户端（实验，`AURORAAGENT_EXPERIMENTAL_MCP` 门控）：`client.mjs` JSON-RPC 2.0（stdio spawn 行读写 / HTTP POST + SSE 复用 `sse.mjs`，initialize / tools-list / tools-call）；`registry.mjs` 服务器配置（`mcp.json` 原子落盘）与工具发现注册（`mcp__<服务器>__<工具>`），单服务器失败不阻塞其他 |
| `web-ui/` | React + Vite + TS 工作台：`src/App.tsx` + `components/{Sidebar,ChatView,Message,ToolCard,Composer(+SkillPalette 斜杠调色板),ProviderEditor,SettingsDialog(+McpPanel+SkillsPanel),PlanCard,Todo}.tsx` + 手写 Markdown 子集渲染器 + `highlight.ts` 零依赖语法高亮 + `projection.ts`（委托 `transcript.mjs` 同源投影）+ 内联 SVG 图标 + `tokens.css` 设计令牌（`app.css` 引用） |
| `web-ui/src/latex.tsx` | LaTeX 渲染：KaTeX 自托管（`trust: false`，`\href` / `\includegraphics` / HTML 扩展一律拒绝），`htmlAndMathml` 输出；解析失败回退展示原始源码而非红色错误墙 |
| `web-ui/src/math-split.mjs` | 公式分段纯函数（零依赖，Node 测试直接 import 同一份）：识别 `$...$` / `\(...\)` / `$$...$$` / `\[...\]` / 裸 `\begin{env}`，代码段与货币区间假阳性防护；`.d.mts` 供 TS 取类型 |
| `public/app/` | web-ui 构建产物（随仓库提交）：`/` 与 `/app/` 同一份 index.html，哈希资产长缓存 |
| `public/icon.svg` `public/vendors/` | 品牌标识 / 各接入厂商标识（`/vendor/` 白名单路由） |
| `test/` | e2e 测试：mock 上游 + 真实 socket（见第 8 节）；子套件（llm / tui / highlight / config / pick / skills / guards）经 import 聚合；`guards.mjs` 仓库守卫入套 |
| `tools/install-service.mjs` | LaunchAgent 安装 / 卸载 / 状态（plist 生成规则与 `web.mjs` 内置逻辑保持一致） |
| `tools/build-app.mjs` | 打包 `.app`（含自保护，见第 6 节） |
| `tools/color-test.mjs` | 纯色识别回归测试工具（结论沉淀在 `docs/`） |
| `tools/gen-release-notes.mjs` | 发布笔记生成：git 历史按 feat/fix/... 分组，幂等注入文档站发布笔记页标记区（`npm run docs:notes`） |
| `docs/` | 测试结论与学术图表（PNG / SVG / PDF + CSV；**TIFF 永不再进仓库**）；终端设计规范已迁入文档站 `docs-site/zh/reference/tui-design.md`（单一真值源） |
| `docs-site/` | VitePress 文档站（中文为主 + 英文镜像）：`zh/` `en/` 的 guides / reference / release-notes；写作规约见 `docs-site/AGENTS.md`；发布笔记由 `tools/gen-release-notes.mjs` 从 git 历史生成 |

数据流（Agent）：浏览器 `POST /api/agent/turn` → `loop.mjs` 按 harness 组装上下文（`context.mjs`）→ `wire.mjs` 按提供方协议请求上游（带 tools）→ `stream.mjs` 增量读取（文本 / 思考 / tool_calls）→ 工具经 `policy.mjs` 门控执行（ask 挂起等 `POST /api/agent/permission`）→ 结果回填进入下一轮 → 无 tool_calls 或触顶即 `turn_completed`；每轮经 `usage.mjs` 按提供方单价记账。客户端断开即 `AbortController` 中止 turn。

数据流（速测底座）：浏览器 `POST /api/chat` → `web.mjs` 按模型所属提供方选协议请求上游 → SSE 逐帧透传或翻译 → 结束按提供方单价结算用量账本。

## 3. 常用命令

| 命令 | 用途 | 注意 |
| --- | --- | --- |
| `npm test` | e2e 测试（mock 上游） | **每次提交前必跑**；不花真钱、不碰真实数据 |
| `npm run check` | 真实 API 连通自检 | 会花少量钱；改了上游相关逻辑时跑 |
| `PORT=8788 npm run web` | 开发态网页服务 | 避开 8787 正式端口 |
| `npm run dev:web` | 前端开发态（vite 5173，`/api` 代理 8787） | 只动 `web-ui/` 时用 |
| `npm run docs:dev` / `docs:build` / `docs:notes` | 文档站开发 / 构建 / 生成发布笔记 | 依赖例外仅 `docs-site/`，产物不提交 |
| `npm run build:web` | 构建前端产物到 `public/app/` | 改了 `web-ui/` 源码后必跑并提交产物 |
| `npm run chat` | 终端 Agent 会话 | 与网页共用 Loop / 会话 / 账本；斜杠命令含 `/plan` `/mcp` 与技能派生的 `/<技能名>` |
| `npm run color` | 纯色识别测试 | 真实调用，按需 |
| `npm run service` / `service:status` / `service:remove` | 安装 / 查看 / 卸载 LaunchAgent | — |
| `npm run publish` | 构建前端 + 打 `.app` + 重启服务 | **只能在 Bundle 外的源码目录执行** |
| `npm run app:build` | 构建前端 + 只构建不重启 | 同上 |

调试：`LOG_LEVEL=debug npm run web`；常驻服务日志在 `~/Library/Logs/com.auroraagent.app.log`。

## 4. 数据目录与配置

三级回退（`util/config.mjs` 单一实现，`web.mjs` / `chat.mjs` / `check.mjs` / `tools/install-service.mjs` 共用；5.0.0 起旧命名一次性迁移：旧数据目录整体搬迁含 Key 保留、旧 config 就地改名）：

1. `AURORAAGENT_DATA_DIR` 环境变量（LaunchAgent 显式指定）
2. 同目录已存在 `auroraagent.config.json` → 用当前目录（源码开发态）
3. 否则 `~/Library/Application Support/AuroraAgent`（App 态，数据与 Bundle 解耦）

配置字段：`apiKey` / `model` / `thinking` / `temperature` / `maxTokens` / `permissionMode` / `planMode` / `titleMode`（标题生成方式：local 本地推导零成本 / model 调模型总结，缺省 local，非法值回退缺省）；用量账本 `usage.jsonl` 逐行追加；会话在 `sessions/<id>.meta.json` + `.jsonl`；新建会话默认名 `新会话`（`session.mjs` 的 `DEFAULT_SESSION_NAME` 单一常量），首条消息自动总结出标题后替换，用户改名不被覆盖；titleMode 可全局配置，也可会话级热切换（网页输入区「本地总结 / 模型总结」选择器 PATCH 落 meta / 终端 `/title local|model`，新建会话继承当前选择）。环境变量 `AURORAAGENT_API_KEY`、`AURORAAGENT_BASE_URL` 优先级高于配置文件。实验特性开关：`AURORAAGENT_EXPERIMENTAL_<NAME>`（如 `AURORAAGENT_EXPERIMENTAL_MCP`）单开、`AURORAAGENT_EXPERIMENTAL_FLAG` 全开，缺省关（`util/config.mjs` 单一实现）。

**`auroraagent.config.json`、`usage.jsonl`、`providers.json`、`mcp.json`、`sessions/` 已在 `.gitignore`，永远不许提交**——Key 泄露即安全事故。自定义提供方（含 API 密钥、单价）存 `providers.json`，内置 LongCat 提供方在内存里合成（`builtin: true`，只读）。用户技能放 `<数据目录>/skills/<名称>/SKILL.md`（与内置 `skills/` 合并展示）；MCP 服务器配置存 `mcp.json`（含连接信息，同级不提交）。

## 5. 代码风格铁律

- 后端只用 Node 内置模块
- 2 空格缩进、单引号、行尾分号，与现有文件保持一致
- 注释与面向用户的文案一律中文；错误消息必须「说清原因 + 给出下一步动作」（参考 401 / 402 的友好映射）
- **产品内零 emoji**：网页 UI、错误消息、终端 banner 都不允许 emoji；图标一律内联 SVG 或 `public/vendors/*.svg`。终端 CLI 的 `✓` / `✗` 属命令行惯例，允许保留
- 前端不引 CDN、不引 Markdown / 状态管理等第三方库；动画用原生 CSS（`@starting-style`、top-layer 过渡）
- 服务路由集中在 `web.mjs` 单个 `createServer` 处理器内按「方法 + 路径」平铺，不引路由库；Agent HTTP 面已拆 `util/agent/http.mjs`
- 单文件控制在约 500 行内；`web.mjs` 已接近上限，新功能优先拆到 `util/` 等模块

## 6. 服务生命周期（macOS LaunchAgent）

- Label `com.auroraagent.app`（5.0.0 起；旧 label `com.modeltester.app` 在安装/卸载时自动清理）；plist 位于 `~/Library/LaunchAgents/`；`RunAtLoad` + `KeepAlive`
- 日志**必须**落 `~/Library/Logs/com.auroraagent.app.log`：launchd 无权重定向到 `~/Documents` 等 TCC 保护目录，否则 job 以 exit 78 反复失败
- LaunchAgent 场景 `NO_OPEN=1` 不弹浏览器；只有用户手动开 App 才 `open`
- 端口冲突时 `web.mjs` 按 1 秒间隔重试最多 60 次——这是设置页切换自启时新旧实例平滑交接（约 1 秒不可用窗口）的基石，**不要改**
- 设置页开关语义：`autostart` = plist 是否存在；`managed` = 当前进程是否正被 LaunchAgent 托管
- **禁止在 Bundle 内执行 `npm run app:build`**：构建会先删掉整个 `.app`，`tools/build-app.mjs` 的自保护会直接报错；正确做法是把 `Resources/app` 拷到 Bundle 之外的目录再构建
- `publish` / `app:build` 已前置 `build:web`：Bundle 内置 `public/app/` 产物，运行时不依赖 node_modules

## 7. 接入新厂商 checklist

1. `public/vendors/<name>.svg` 放厂商标识；`web.mjs` 的 `/vendor/` 白名单路由自动放行（正则防目录穿越，勿放宽）
2. `web-ui/src/components/Composer.tsx` 的厂商标识前缀匹配加一行（模型 id → 图标）；终端不需要（无图标渲染）
3. 配置 `AURORAAGENT_BASE_URL`；模型目录来自上游 `GET /openai/v1/models`，代码不硬编码厂商模型清单
4. `README.md`「当前接入厂商」段同步更新；协议差异（如思考开关字段、Messages 线路、tools 字段形态）在 `util/wire.mjs` 处理并补测试；更常见的路径是让用户直接在设置页加自定义提供方，无需改代码
5. 全程遵守第 0 节：每完成一步且 `npm test` 通过，就提交推送一次

## 8. 测试规约

- e2e 模式：mock 上游（`127.0.0.1:18901`，复刻真实 SSE 帧与 401 / 402 错误、`tool_calls` 帧与 tool 结果回执）+ 真实 socket 拉起 `web.mjs`（`127.0.0.1:18787`）
- **数据隔离**：测试以临时目录作 `AURORAAGENT_DATA_DIR`，绝不许写真实数据目录
- 新路由 / 新行为 / 新错误映射必须带中文测试名进入 `test/run-tests.mjs`；mock 需要新行为时改 `test/mock-longcat.mjs`
- mock 触发词：消息含 `USE_TOOL` → 模型发起 `read_file mock.txt`；含 `USE_TOOL_WRITE` → 发起 `write_file written_by_agent.txt`；`FLAKY` 断网重试；`SLOW` 慢速；`USE_SKILL` / `USE_TODO` / `USE_EDIT` / `USE_PLAN` / `USE_SWARM` / `USE_MCP` 分别触发技能加载 / 待办维护 / diff 回传 / 计划两阶段 / 子代理派发 / MCP 工具调用；系统提示带 `【会话标题生成】` 标记即标题生成轮（titleMode=model），回固定标题 `README 安装章节改写`
- 前端契约测试（`/app` 服务、哈希资产、令牌 CSS 在场、零 emoji、旧路由 404、ProviderEditor 源码校验规则）守着构建产物与 `web-ui/` 的同步；改了 `web-ui/` 忘了 `build:web` 会红
- 仓库守卫（`test/guards.mjs`，已入 `npm test`）：产品源码零 emoji、TUI 颜色单一真值源（仅 `theme.mjs` 出 SGR）、色板对比度达标、新模块 ≤500 行、文档站结构契约（中英页面一一对应 / 发布笔记标记在场 / 依赖例外登记）
- 基线 213/213 通过。提交前 `npm test` 必须全绿；不许 `skip`，不许放宽断言迁就失败
- `npm run check` 走真实上游，只在改上游集成时跑（花少量钱）
- 跑 `npm test` 前确认 18901 无常驻 mock 占用（`pkill -f mock-longcat`）；exec 沙箱会杀后台进程，常驻服务 / mock 用 exec_command 前台会话跑

## 9. 反模式（NEVER）

- **NEVER** 攒一批改动才提交；**NEVER** 在测试红着时提交
- **NEVER** 提交 `auroraagent.config.json` / `usage.jsonl` / `providers.json` / `sessions/` / 任何日志
- **NEVER** 在产品 UI 里加 emoji
- **NEVER** 在 Bundle 内执行 `npm run app:build`
- **NEVER** 改动厂商事实层：模型 ID、显示名映射规则、价格常量 `PRICE`、纯色测试结论——除非上游本身变了
- **NEVER** 修改 `web.mjs` 的 EADDRINUSE 重试逻辑与 plist 日志路径约定（见第 6 节）
- **NEVER** 触碰 `~/Documents/cc-switch`（其他项目的仓库）
- **NEVER** 用 `rm -rf` 删目录；用 Node `fs.rmSync` 并二次确认路径

## 10. 验证基线（改动后自查）

- `npm test` → 213/213
- `curl -s localhost:8787/api/health` → `{"ok":true,...}`；`/api/settings` → `version` / `managed` / `dataDir` 符合预期
- 浏览器打开 http://localhost:8787 ：无 emoji、模型选择器按提供方分组、完整 turn（工具卡 / 权限卡 / 用量脚注）正常、设置弹层可开关开机自启
- 终端 `npm run chat`：`/help`、权限 y/n/a、`/sessions` 切换正常
- 改了启动 / 打包逻辑：`npm run publish` 后 `launchctl print gui/$(id -u)/com.auroraagent.app` 确认 `state = running`

## 11. 文档同步

- 行为发生变化时，同一次提交里更新 `README.md`（人类文档）与本文件（agent 规约）
- 版本号只改 `package.json` 一处（Info.plist 与 `/api/settings` 都读它）；品牌名 AuroraAgent 仅作品牌与文档名，包名 / Bundle ID / LaunchAgent label / 数据目录约定不变
- `docs/figures/` 只放 PNG / SVG / PDF + CSV；**TIFF 永不再进仓库**（历史上有过 112MB 教训）
- 图表脚本 `docs/figure-work/make_figures.py` 本机只能 `py_compile` 验证（环境无 numpy / matplotlib）；图标管线用 `npx sharp-cli`
