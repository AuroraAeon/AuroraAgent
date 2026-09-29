# AGENTS.md — AuroraAgent 项目宪法

> 本文件是写给 AI 编码 agent 的项目规约。人类用户文档见 `README.md`；两者冲突时，以真实代码行为为准，并顺手修正文档。
> 优先级：用户当前对话指令 > 本文件 > agent 的默认习惯。本文件是活文档——每次踩坑后，把教训补进来。

---

## 0. 项目是什么

AuroraAgent 是「本地 Agent 运行时」：终端 + 网页双客户端共用同一套 Agent Loop（会话 / 轮次 / 工具 / 权限 / 上下文压缩），对标 OpenBitFun 的本地化实现；「全球厂商最新大模型速测」能力完整保留为底座（`/api/chat`、自定义提供方、用量账本）。

产品形态与技术底线：

- 单用户本地工具，**仅支持 macOS**（依赖 LaunchAgent 与 `~/Library` 目录约定）
- **后端零依赖**：只用 Node 18+ 内置模块；ESM `.mjs`；无构建步骤
- **前端依赖例外**：`web-ui/` 用 React 19 + Vite 7 + TypeScript + KaTeX，依赖（react / react-dom / katex / vite / typescript / @vitejs/plugin-react / @types/*）**仅限 `web-ui/`**；构建产物随仓库提交在 `public/app/`，后端与 Bundle 运行时不接触 node_modules
- **文档站依赖例外**：`docs-site/` 用 VitePress（唯一依赖）搭建中英双语文档站；`docs-site/node_modules` 与构建产物**不提交**，仅开发期使用，后端与运行时零接触
- 双客户端：终端（`chat.mjs` → `util/agent/terminal.mjs`）+ 网页（`web.mjs` 服务 `public/app/` React 产物），共享同一套配置、会话、账本数据目录
- 可打包为独立 macOS Application（`~/Applications/AuroraAgent.app`，显示名 AuroraAgent），由 LaunchAgent `com.auroraagent.app` 常驻
- 当前接入厂商：美团 LongCat-2.5-Preview。Base URL / 模型目录 / Key 全部是配置项——**代码不绑定厂商**，接入新厂商不改架构
- 自定义 Provider：设置页可加任意 OpenAI 兼容 / Anthropic Messages 上游（存储、校验、发现、路由在 `util/providers.mjs` + `util/wire.mjs`，前端在 `web-ui/src/components/ProviderEditor.tsx`）；内置提供方只读，请求载荷保持历史形态；多提供方故障转移：429 / 5xx / 网络失败 / 超时 / HTTP 200 的错误 envelope 时连接期自动切换到提供同模型的其它提供方重试（判定与配置在 `util/llm/failover.mjs`，编排在 `util/llm/provider.mjs`，跨请求熔断器在 `util/llm/circuit.mjs`、运行时状态落 `util/llm/failover-state.mjs`，turn 内粘性与记账归属在 `util/agent/loop.mjs`；候选按用户编排的故障转移队列优先，转移成功后同模型热切换偏好优先，用户无感知、失败尝试不记账）
- Agent 能力面（6.0.0 起对齐 kimi-code 能力模型，7.0.0 起对齐 MiniMax-code goal 能力，全部零依赖自实现）：Goal 目标模式（一会话一目标、六态状态机、三维预算 + 双熔断、evaluator / subagent 独立验证、轮内自动续跑、`/goal` 与 GoalBar 双端操作（网页 Composer 在生成中亦接受 `/goal` 家族命令，直走 goal REST，异步回调带会话归属校验防串会话））、技能（`skills/` 内置 + `<数据目录>/skills/` 用户，三层渐进式披露：name + description 常驻系统提示且受 token 预算治理、`SKILL.md` 正文被触发时整篇加载、`references/` `scripts/` `assets/` 附属文件经只读白名单根按需读取；`implicit: false` 仅允许显式调用；激活内容免上下文压缩；`/<技能名>` 斜杠命令与 `skill` 工具按需加载正文）、子代理（`task` 工具派发受限子 turn）、计划模式（先出计划、批准才执行）、权限三档（`always_ask` / `ask_when_needed` / `never_ask`）、MCP 客户端（stdio / HTTP 双传输，`AURORAAGENT_EXPERIMENTAL_MCP=1` 门控，默认关）

## 1. 架构地图

| 文件 | 职责 |
| --- | --- |
| `web.mjs` | 网页服务核心：`/api/*` 路由平铺、SSE 代理、停止中断、模型目录（单飞加载 + 60s 缓存）、`/app/` 静态服务（React 产物 + SPA 回退 + 防目录穿越 + 304 协商）；Provider / LaunchAgent / SSE 泵 / 账本 / Agent HTTP 面 / 终端偏好 / 代理设置 / 故障转移设置已拆到 `util/`，静态资源走 `STATIC_ASSETS` 白名单；`/api/chat` 与 Agent 同源接入多提供方故障转移（切换后记账归属随 entry 改写） |
| `chat.mjs` | 终端客户端入口：main 委派 `runTerminal`；保留旧对话通道 `streamChat` 与配置导出（`tools/color-test.mjs` 依赖） |
| `check.mjs` | 连接自检：Key 校验 → 模型列表 → 一条最小真实请求（会花少量钱） |
| `util/config.mjs` | 数据目录三级回退 + 配置读写 + `PRICE`（chat / check / web / color-test 共用） |
| `util/sse.mjs` | SSE 解析器 `SseParser` + token 估算（测试与后端共享） |
| `util/providers.mjs` | 自定义 Provider：存储（`providers.json` 原子落盘）、ID/端点/协议/模型目录/单价/API 密钥格式校验（与 dsh 同规约）、上游模型发现、`/api/providers` 路由处理；顶层 `failoverQueue` 是用户编排的故障转移优先级（`GET/POST /api/providers/failover-queue` 整队列替换 / 增删移，内置提供方可入队，删除提供方自动清出孤儿） |
| `util/wire.mjs` | 协议适配：OpenAI 兼容与 Anthropic Messages 的 URL 拼接、请求拼装（含 `tools` / `tool_choice`）、Anthropic SSE 帧翻译成 OpenAI 帧（含 `tool_use` / `input_json_delta`） |
| `util/stream.mjs` | SSE 透传 / 翻译泵（逐帧转发 + 用量累计 + 背压 pause/resume，供 `/api/chat`）；`consumeAgentStream` 增量累积 `tool_calls` delta 供 Loop 使用；`primeUpstreamStream` 预读（缓冲至首个产出帧或语义失败帧，返回可重放 reader，把「200 错误 envelope」与首包超时变成连接期可换路错误），三条泵路共用首包 / 空闲超时（`idleMs`，kind=timeout） |
| `util/usage.mjs` | 用量账本：逐行追加 + 汇总出口 + `stats()` 统计视图（近 30 天逐日补零、按模型 / 提供方 / 用途 / 会话构成，供设置页用量面板） |
| `util/update.mjs` | 版本更新检查：查 GitHub Releases latest 比对本地版本（三段语义、忽略 v 前缀与预发布后缀），结果缓存 6 小时（`<数据目录>/update-check.json`，按本地版本号作 key——版本一变旧结论作废），失败不缓存、不抛错；只告知不自动安装，`GET /api/update/check`（`?force=1` 强制重查）。注意版本号是进程启动时读一次（`web.mjs` 的 `VERSION` 常量），升级后必须重启服务才对得上 |
| `util/errorlog.mjs` | 错误日志：`<数据目录>/logs/errors.log` JSON Lines 环形保留（200 行）、kind 白名单归一、detail 截断 4KB、写失败静默，写入前经 `sanitizeSecrets` 脱敏（Authorization / api_key / token 键值、URL 查询串与 userinfo、sk- 密钥，幂等，移植 ZCode error-sanitizer）；`POST/GET/DELETE /api/logs/errors` 供前端全局捕获上报与设置页查看清空，同 kind+message 30 秒去重 |
| `util/service.mjs` | LaunchAgent 生命周期：plist 生成 / 安装 / 卸载 / 状态 |
| `util/agent/events.mjs` | AgentEvent 协议（OpenBitFun AgenticEvent 精简子集）+ SSE 帧封装；`session_renamed` 供两端实时刷新自动总结出的标题；`provider_switched` 故障转移换路提示（from / to / reason / attempt）；`goal_created` / `goal_status_changed` / `goal_usage_updated` / `goal_wait_changed` / `goal_cleared` 五类 goal 事件 |
| `util/agent/harness.mjs` | 三档模式契约 minimal / standard / ultimate：系统提示、工具集（goal 三工具仅 standard / ultimate 收录）、轮次上限（1 / 24 / 64）、压缩阈值；Creative 留待后续 |
| `util/agent/session.mjs` | 会话存储：`sessions/<id>.meta.json` 原子落盘 + `.jsonl` 追加式转录（投影按 mtime+size 失效缓存）；投影重建容错误行；create / list / get / patch / fork / delete |
| `util/agent/title.mjs` | 会话标题自动总结：首条用户消息本地推导简短标题（零成本纯函数，不调模型）——首行提取 / markdown 噪声剥离 / 技能注入取用户原话 / 斜杠命令取参数 / emoji 与控制符清洗 / CJK 宽度截断（≤24 列）；仅会话仍是 `DEFAULT_SESSION_NAME` 时套用 |
| `util/agent/title-model.mjs` | 模型总结标题：titleMode=model 时一次无工具低温请求（≤64 token，参考首条消息与终稿）生成标题，失败回退本地推导；成本记 `purpose:'title'` 账本与会话汇总，不进转录与轮次脚注 |
| `util/tui/` | 终端 TUI 工具包（零依赖）：`theme.mjs` 语义色板暗/亮双调 + 对比度守卫（全仓库唯一允许原始 SGR 的文件）；`render.mjs` CJK/ANSI 感知宽度截断；`printable-key.mjs` Kitty CSI-u 解码；`searchable-list.mjs` 光标/搜索/翻页状态机；`select.mjs`+`pick.mjs` 单选对话框（TTY 原始模式读键 + 非 TTY 退化）；`footer.mjs` 状态条（含目标用量芯片）；`commands.mjs` 声明式斜杠命令；`screen.mjs` 增量重绘；`config.mjs` tui 段解析（terminalTitle 项序 + notifications 三档，单叶容错）；`title.mjs` OSC 终端标题（退出 / 挂起清除）；`notify.mjs` OSC9 / OSC777 / bel 三通道通知（osascript 尽力焦点探测）；`settings-api.mjs` `/api/settings/tui` HTTP 面；规范单一真值源 `docs-site/zh/reference/tui-design.md` |
| `util/llm/` | LLM 抽象：`tool.mjs` kosong 风格 Tool 归一化与 OpenAI/Anthropic 双协议转换（`tools.mjs` 共用，`deferred` 标记的工具不进请求顶层 `tools[]` 以保字节稳定）；`errors.mjs` 状态码 → 中文错误分类（额度措辞先于 400）；`provider.mjs` `openChatStream` 统一开流入口（`/api/chat` 与 Loop 共用，非 2xx 抛带 kind/status 的 Error；连接期可重试错误按 `failover` 选项换提供方重试，已发出字节后不透明换路）；`failover.mjs` 多提供方故障转移（可转移判定 429/408/5xx/网络/超时/2xx 语义失败——中止、4xx 鉴权计费类与 400/405/406/413/414/415/422/501 等请求自身问题不转移也不计健康度、候选挑选队列优先（空回退隐式顺序）且同模型 / 有 Key / 排除已试 / 熔断开闸即跳过、线性退避、`parseFailoverConfig`（超时三件套 0=禁用 + 熔断五项 + 偏好有效期，单叶容错 + 钳制）与 `GET/POST /api/settings/failover`、`POST /api/settings/failover/reset` 手动恢复（GET 附各家健康视图））；`circuit.mjs` 熔断器（closed/open/half_open 三态，连续失败 + 错误率双判据，半开探测名额并发只放行一个，快照落盘恢复，`CircuitRegistry` 按提供方 id 托管、Loop 与 `/api/chat` 跨请求共享）；`failover-state.mjs` 故障转移运行时状态（`failover-state.json` 原子落盘：熔断快照 + 热切换偏好，写节流 1s、损坏文件静默回退空态，持有 CircuitRegistry，`reset(providerId?)` 手动恢复）；`message.mjs` OpenAI ↔ Anthropic 消息序列纯函数 |
| `util/agent/tools.mjs` | 十一个内置工具（read_file / list_dir / write_file / edit_file / shell / web_fetch / grep / glob / todo / skill / task）：JSON Schema、`resolveInside` 路径禁锢（拒绝穿越）、输出截断、shell 超时（默认 30s 上限 120s）；MCP 与技能工具经 `util/llm/tool.mjs` 归一化后同形态入列 |
| `util/agent/policy.mjs` | 权限策略：`{action, resource, effect}` 规则集，层内后匹配赢、多层取最严（deny > ask > allow）；`permissionMode` 三档（always_ask / ask_when_needed / never_ask）设定 ask 类动作默认效应，不推翻 deny 与会话级「总是允许」；action 支持 `mcp__*` 前缀通配 |
| `util/agent/context.mjs` | 上下文组装（系统提示 + 历史 + 工具定义；thinking/usage 不回填、summary 转系统消息）与压缩规划（超窗口 70% 触发，保留最近 4 个用户轮原文） |
| `util/agent/loop.mjs` | turn 运行器：轮次循环至无 tool_calls 或触顶；计划 / 执行两阶段（`plan.mjs`）；权限经 pending map 挂起等前端决策；`AbortController` 中断保留已生成内容（子代理级联中止）；SSE 断开即中止；MCP 等额外工具经 `extraTools` 进请求；每轮经 `usage.mjs` 记账；连接期故障转移后 turn 内粘性沿用新提供方（单价与记账随真实产出方，自定义提供方按目标方口径拼 gen 参数，子代理经派发继承候选源）；转移成功后经 `failover-state.mjs` 写热切换偏好（TTL 内同模型优先走这家） |
| `util/agent/http.mjs` | `/api/agent/*` 与 `/api/mcp/*` HTTP 面（web.mjs 前缀委派）：会话 CRUD + PATCH + fork、turn SSE、abort、permission、harnesses、skills 目录、plan 决策通道、goal REST 四面（查询 / 创建 / pause·resume·stop / budget，纪元与状态冲突 409）、`GET /api/agent/events` 跨客户端 goal 事件流（SSE，经 `util/agent/goal/bus.mjs` 扇出）、MCP 服务器 CRUD + probe + 显示开关（实验门控）；单活跃 turn（409，主 / 侧互斥）；turn 入参 `side:true` 跑侧边对话（`/btw`：SideSession 内存门面、不落盘、不接管 goal、不派发子代理），配 `GET /api/agent/side/:id` 查转录与 `POST /api/agent/side/discard` 丢弃；turn 入参带 `providerFailover` / `providerFailoverMaxAttempts` / `failoverCandidates`（候选源=ProviderStore 全量，挑选规则在 `util/llm/failover.mjs`），并由 HTTP 面注入熔断器（CircuitRegistry）、生效超时与故障转移队列 |
| `util/agent/terminal.mjs` | 终端 REPL 协调器：readline + 声明式斜杠命令表（`defineCommands`，含 `/goal` 家族与 `/btw`）+ footer 状态条 + 可搜索选择器；OSC 标题实时改写（挂起经不可捕获 SIGSTOP 真正停下）、系统通知接线；`Ctrl+/` 主 / 侧边对话切换；`-p` 单次提问；行数预算内拆出下面两个模块 |
| `util/agent/terminal-turn.mjs` | 终端 turn 渲染器：AgentEvent → 思考流 / 工具单行 / 权限 y/n/a / 用量脚注；Ctrl+C 经 rl 'SIGINT' 事件中转中断（raw mode 下无真信号） |
| `util/agent/terminal-format.mjs` | 终端渲染纯助手：工具标签、截断、费用格式化、输出缩进（coordinator 与 turn 渲染器共用；标签与费用已转置到 `transcript.mjs` 同源） |
| `util/agent/skills.mjs` | 技能系统（对齐 Agent Skills 规范的三层渐进式披露）：frontmatter（name / description 必填，license / compatibility / metadata / allowed-tools / implicit 可选）宽松解析、内置 + 用户双目录、附属资源索引（`references/` `scripts/` `assets/`，只记路径不读内容）、L1 目录块带 4000 token 预算治理、L2 结构化激活包裹（正文 + 技能绝对目录 + 资源清单）、`skillDirs` 只读白名单根、`/<技能名>` 斜杠命令与 `skill` 工具按需加载正文（同轮去重） |
| `util/agent/plan.mjs` | 计划模式：计划轮只读 / 检索 / 待办工具白名单（单点定义）、批准后作为既定契约注入执行轮、驳回以 `plan_rejected` 收尾 |
| `util/agent/swarm.mjs` | 子代理：`task` 工具派发受限子 turn（真实子会话透明可查、嵌套深度封顶 2 层、单次上限 4 个、父中止级联），终稿经工具结果聚合回父模型 |
| `util/agent/goal/` | Goal 目标模式（语义对齐 MiniMax-code thread-goal，一会话一目标）：`types.mjs` 六态状态机 + statusReason 闭集 + 读路径归一化；`store.mjs` 原子落盘 + CAS 纪元严格推进；`tools.mjs` create_goal / update_goal / get_goal（名字与 schema 对齐 codex，混合模式拒绝）；`budget.mjs` 三维预算（token / 轮次 / 活跃秒数）触顶与收尾轮 + 用量芯片；`breaker.mjs` 回复指纹 + 无工具双熔断；`config.mjs` goal 段解析（单叶容错 + 钳制）；`verification.mjs` evaluator / subagent 验证与结算；`continuation.mjs` 轮内自动续跑；`runtime.mjs` 编排入口；`actions.mjs` 用户面操作单一事实源（REST 与终端共用）；`bus.mjs` 进程内事件总线（REST 变更按 sessionId 扇出给 SSE 订阅方，对齐 MiniMax 全局事件投影） |
| `util/settings-generation.mjs` | 生成参数与 API Key 的 HTTP 面：`GET/POST /api/settings/generation`（temperature 0~1 / maxTokens 正整数 ≤1000000，局部合并）、`GET/POST /api/settings/key`（写入落盘；GET 只回 `hasKey` 不回钥；环境变量 Key 优先时 409）；网页斜杠命令 /temp /max /key 与设置页「通用」面板共用，下一轮请求即时生效 |
| `util/proxy.mjs` | 本机代理（Agent 沙箱出站请求的出路）：`parseAgentProxy` 地址归一化与校验（`http://host:port` 或裸 `host:port`，空 = 直连，socks5 拒绝）、`proxyFetch` 零依赖抓取（http 目标走正向代理绝对 URI、https 目标走 CONNECT 隧道 + TLS、跟随重定向封顶 5 跳、错误中文化）、`handleAgentProxyApi` 的 `GET/POST /api/settings/proxy` HTTP 面（设置页「网络」面板，web.mjs 一行委派）；Node 内置 fetch 不读 `HTTP_PROXY`，故自行实现隧道 |
| `util/agent/side-session.mjs` | 侧边对话（`/btw`）：内存门面，继承主会话自洽历史前缀（无悬空工具调用的最后边界），不落盘不进 `/sessions`、不接管 goal、不派发子代理；`util/agent/http.mjs` 以 `sides` Map 按主会话 id 托管，网页与终端同源 |
| `util/workspace.mjs` | 工作区上下文（只读）：`readWorkspaceInfo` 路径校验 + home + git 分支（零依赖直读 `.git/HEAD`，兼容 worktree 的 `.git` 文件形态，不调 git 命令、不统计 dirty）；`handleWorkspaceApi` 的 `GET /api/workspace?path=`（Header 工作区卡片数据源，移植 ZCode 工作区系统：Header 常驻展示 workspace 上下文） |
| `util/agent/files.mjs` | `@` 提及时只读文件搜索：`resolveInside` 路径禁锢仅列会话工作目录，跳过依赖目录（`GET /api/files/search`） |
| `tools/perf/` | 性能基准（本地回归参考，非门禁）：`mock-upstream.mjs` 可播大上下文 SSE mock、`scenarios.mjs` startup / upstream-100 / history-300 三场景、`run.mjs` 临时数据目录拉起真实服务采样 wall / CPU / peak-RSS 输出 JSON + Markdown |
| `util/agent/transcript.mjs` | 转录投影层：工具标签 / 图标键 / 资源摘要 / 费用格式化的单一真值源 + `projectTurns` 记录分组规则（同一用户轮内文本与工具按时间线交错存 `parts`，回答不被工具调用切断；Web 投影与流式 turn 同形态；配套 `transcript.d.mts` 供 TS 取类型） |
| `util/mcp/` | MCP 客户端（实验，`AURORAAGENT_EXPERIMENTAL_MCP` 门控）：`client.mjs` JSON-RPC 2.0（stdio spawn 行读写 / HTTP POST + SSE 复用 `sse.mjs`，initialize / tools-list / tools-call）；`registry.mjs` 服务器配置（`mcp.json` 原子落盘）、显示开关（停用即从工具箱摘掉，配置保留）与工具发现注册（`mcp__<服务器>__<工具>`），单服务器失败不阻塞其他 |
| `web-ui/` | React + Vite + TS 工作台：`src/App.tsx` + `components/{Sidebar（ZCode WorkspaceSidebar 像素级：280px 栏宽 / 收回后整块消失只留顶部浮层与 WorkspaceHeader（ZCode WorkspaceShellLayout 语义：`sb-panel` 裁剪容器 width+opacity 200ms ease-out 擦除，切换入口迁至 DesktopTopOverlay，Cmd/Ctrl+B 同效；侧栏顶部 48px 空拖拽带给浮层，自身无大 Logo——品牌只在浮层切换钮里）/ 新建任务钮（ZCode NewTaskButtonGroup：w-full h-8 rounded-lg ghost、MessageCirclePlus 16px +「新建任务」+ 右侧快捷键标签，无描边无 tooltip；当前会话已是空新会话（无轮次且未在生成）时禁用——再点只会堆一个空会话，Ctrl/Cmd+K 同规则静默无效，删除恢复路径不受限）/ 36px 区头含展开搜索 / 32px 会话行悬停现操作＋左 16px 前置槽（正在运行的会话填灰色加载圈，ZCode TaskListItem leading slot））,WorkspaceHeader（ZCode WorkspaceHeader 形态：常驻 48px（h-12 + 内行 p-2 / gap-2，分隔线走 inset 阴影）；左组 gap-1＝工作区上下文钮（hover 即显信息卡、点击 pin：工作目录 home 缩写 / 最近活动 / git 分支，数据懒拉 GET /api/workspace 按工作目录缓存）＋会话标题（14px/600、max-w 400px、容器查询窄档 30vw/22vw、双击原位重命名）＋更多菜单（重命名 / 复制会话 ID / 复制工作目录 / 派生 / 删除）；右组 gap-0.5＝帮助菜单（文档 / 反馈外链＋快捷键与关于两面板，触发器挂「帮助」气泡——ZCode ControlHintTooltip 包住 DropdownMenuTrigger）＋设置；入口统一 28px ghost 图标钮只过渡颜色；收回态内行按实测浮层宽加左边距让位；自带分区错误边界）,WorkspaceTopOverlay（ZCode DesktopTopOverlay：absolute 常驻浮层、外层 pointer-events-none 交互容器 auto；切换钮静止显 20px 品牌砖、hover 淡出并淡入 16px 面板图标＋ControlTooltip「切换侧边栏＋快捷键」；后退 / 前进（会话导航历史 taskNav：浏览器式前进后退栈，栈首 / 栈尾禁用，Cmd/Ctrl+[ 与 ] 同效）；新建任务随 isNewTaskButtonVisible 语义 opacity/width 300ms 过渡（收回态才显，图标用 lucide MessageCirclePlus 精确路径；与侧栏同规则，空新会话禁用）；更新入口仅发现有新版时出现——ZCode 教训：收回态不能按宽度阈值隐藏全局入口）,Menu（零依赖下拉菜单：portal 单例 root、ARIA 菜单键盘全集、Esc/Tab/点外关闭、选中即关、onSelect 可 preventDefault 阻止关闭（Radix 语义，菜单内面板导航用）、tip 属性把 ControlTooltip 包到触发器上）,Select（零依赖下拉选择框：复刻 ZCode Select trigger input 变体 lg 尺寸 + 内容壳与对勾指示、Radix 键盘全集、portal 宿主取最近的 dialog——模态内挂 body 会被 top-layer 盖住）,ChatView,Message,ToolCard,Composer(ZCode ChatPromptEditor 排版：输入壳 rounded-2xl p-3 gap-3、工具栏 flex items-end gap-3 左组 flex-1 min-w-0 内层 shrink-0 gap-1＝「添加上下文」加号菜单（上传文件以 <file name> 块插入输入框＋@ 引用工作目录文件）＋模式 / 权限 / 标题 ghost 钮＋计划状态芯片、右组 ml-auto shrink-0 gap-1.5＝模型选择器＋发送 / 停止；入口统一 28px ghost 方钮、窄屏整组收图标钮不换行；+ComposerPickers 选择器组+CommandPalette 斜杠命令菜单，模型选择器两级化：根菜单「模型 / 思考强度」各进列表),GoalBar,ProviderEditor,ProvidersPanel,GeneralPanel,AppearancePanel（ZCode appearance 一级目录全量迁移：界面设置＝界面主题 Select 下拉（Monitor/Moon/Sun 带图标，不是分段按钮）＋界面字号 12~20；代码设置＝浅色 / 深色代码主题各一个 Select（aurora/github/vitesse/catppuccin/contrast 五套 --code-* 调色板，零依赖不引 Shiki）＋显示行号 Switch＋长行自动换行 Switch＋代码字号 12~20；代码预览＝浅 / 深双卡跑真实 Markdown 并标「当前生效」）,NumberField（复刻 ZCode FontSizeInput：钳制范围、回车提交、Esc 还原、px 后缀）,Switch（复刻 ZCode Switch：32×18 轨道 + 16px 滑块）,SegmentedControl（复刻 ZCode 分段选择器：等宽轨 + 滑块指示器，radiogroup 语义 + 方向键 / Home / End，禁用态整轨淡出且不可聚焦；故障转移「最多尝试」用它替换早年无样式的 mode-seg 裸按钮组）,SettingsDialog(分级壳：左导航轨 通用/外观/提供方/故障转移/网络/技能/MCP 工具/终端/用量/错误日志 十 section 懒挂载+hidden 缓存),McpPanel,SkillsPanel,TuiPanel,ProxyPanel,FailoverPanel,UsagePanel,ErrorLogPanel,PlanCard,Todo}.tsx` + `slash-commands.ts` 斜杠命令目录（与终端 baseCommands 同源同序，实时过滤 / 两档回车）+ 手写 Markdown 子集渲染器 + `highlight.ts` 零依赖语法高亮 + `projection.ts`（委托 `transcript.mjs` 同源投影）（网页侧边对话：`/btw` 一问一答分支、输入框上方侧边横幅、`Ctrl+/` 主 / 侧切换、turn 带 `side` 标记；历史消息行 `content-visibility:auto` + `contain-intrinsic-size:auto 160px` 延迟渲染降大会话样式开销，流式 LiveRow 不加——对齐 ZCode 时间线做法）+ 内联 SVG 图标 + `toast.tsx` 零依赖通知（右下角视口、四级语义、悬停暂停计时、同屏 4 条、同文案合并计数）；视口经 createPortal 挂「最上层打开的模态 dialog，否则 body」并用 MutationObserver 盯 open 属性——模态 <dialog> 在 top-layer，挂 body 的 fixed 视口会被整个对话框盖住（与 Select 的 portal 宿主同教训，计时与去重在模块级 store，换挂载点只重挂 DOM） + `ControlTooltip.tsx` 提示气泡（复刻 ZCode ControlHintTooltip：portal 单例 root、快捷键 kbd 键帽、@starting-style 淡入）+ `shortcut.ts` 快捷键平台标签（⌘B / Ctrl+B）+ `TurnNavigator.tsx` 会话回合导航（对话区左缘离散「梯状」历史轨，复刻 ZCode ConversationTurnNavigator：每个用户提问一条 10px 短棒、按 turn 聚合助手摘录、悬浮以焦点项为山峰向上下衰减不透明度与横向缩放 + 右侧预览卡、点击平滑跳转、滚动驱动活动条、窄于 864px 整体不渲染；纯函数层 `turn-nav.mjs` + `.d.mts`，虚拟窗口手写零依赖）+ `nav-history.mjs` + `.d.mts` 会话导航历史纯函数层（复刻 ZCode taskNavigationHistory：前进后退栈、相邻去重、入栈截断前进历史、封顶 50、删除会话按索引位移摘条目）+ `error-report.ts` / `error-boundary.tsx` 全局错误捕获与崩溃兜底页 + `ScopedErrorBoundary.tsx` 分区错误边界（scope 归因 + resetKeys 自动恢复，移植 ZCode 模式，单区崩溃不拖垮整棵工作台） + `theme.ts` 双主题偏好（跟随系统 / 浅色 / 深色，首帧防闪由 `index.html` 内联脚本负责）+ `appearance.ts` 外观偏好（界面字号 / 浅深代码主题 / 行号 / 换行 / 代码字号，localStorage 持久化 + useSyncExternalStore 迷你真存储，watchAppearance 启动落地并监听系统主题翻转；Markdown 行号结构随偏好即时切分）+ `tokens.css` 设计令牌（`:root` 深色 / `:root[data-theme="light"]` 同名覆盖，`app.css` 引用；含 `--ui-font-size` / `--code-font-size` / `--code-*` 调色板令牌——`app.css` 全文件 font-size 已 rem 化，1rem＝界面字号，图标 / 间距 / 圆角保持 px 不动，外观页调字号只动文字） |
| `web-ui/src/turn-events.ts` | turn SSE 事件 → 界面状态的单一投影器（主 / 侧边对话两条通道共用，`scope` 区分）：`appendTextPart` / `applyToolEvent` / `createTurnEventHandlers` / `finishTurnProjection`；goal 横幅仅主对话投影且带 sessionId 校验，notice（`/goal` 回执、故障转移提示）收尾重投影时保留 |
| `web-ui/src/latex.tsx` | LaTeX 渲染：KaTeX 自托管（`trust: false`，`\href` / `\includegraphics` / HTML 扩展一律拒绝），`htmlAndMathml` 输出；解析失败回退展示原始源码而非红色错误墙 |
| `web-ui/src/math-split.mjs` | 公式分段纯函数（零依赖，Node 测试直接 import 同一份）：识别 `$...$` / `\(...\)` / `$$...$$` / `\[...\]` / 裸 `\begin{env}`，代码段与货币区间假阳性防护；`.d.mts` 供 TS 取类型 |
| `web-ui/src/md-table.mjs` | Markdown 表格块解析纯函数（零依赖，Node 测试直接 import 同一份）：GFM 子集（表头 + 分隔行 + 对齐 + 数据行），列数不匹配 / 裸 `---` 不成表；渲染（thead/tbody/滚动包裹层）在 `markdown.tsx`，`.d.mts` 供 TS 取类型 |
| `web-ui/src/reasoning.mjs` | 思考过程纯函数（零依赖，Node 测试直接 import 同一份，复刻 ZCode `ReasoningTrigger` 助手）：`normalizeThinkingText` 剥开头空行（模型常吐 `\n\n` 导致展开后首行空白）、`resolveReasoningStreamingSummary` 取流式文本最后一个非空行作单行摘要、`isReasoningSummaryOverflowing` 1px 容差溢出判定；组件 `Message.tsx` 的 `ThinkingBlock` 消费，`.d.mts` 供 TS 取类型 |
| `public/app/` | web-ui 构建产物（随仓库提交）：`/` 与 `/app/` 同一份 index.html，哈希资产长缓存 |
| `public/icon.svg` `public/vendors/` | 品牌标识 / 各接入厂商标识（`/vendor/` 白名单路由） |
| `test/` | e2e 测试：mock 上游 + 真实 socket（见第 7 节）；子套件（llm / tui / highlight / config / pick / skills / guards）经 import 聚合；`guards.mjs` 仓库守卫入套 |
| `tools/install-service.mjs` | LaunchAgent 安装 / 卸载 / 状态（plist 生成规则与 `web.mjs` 内置逻辑保持一致） |
| `tools/build-app.mjs` | 打包 `.app`（含自保护，见第 5 节） |
| `tools/color-test.mjs` | 纯色识别回归测试工具（结论沉淀在 `docs/`） |
| `.github/workflows/release.yml` | CI + 自动发布：push `master` 先跑 `npm test`，全绿后 release-please 按常规提交开发布 PR，合并即打 tag 建 GitHub Release；release-please 用 `RELEASE_PLEASE_TOKEN`（classic PAT，未配则回退 `GITHUB_TOKEN`）推送发布分支——用 `GITHUB_TOKEN` 会让发布 PR 的 CI 因 `github-actions[bot]` 的「首次贡献者」判定停在 `action_required` 永不执行 |
| `tools/gen-release-notes.mjs` | 发布笔记生成：git 历史按 feat/fix/... 分组，幂等注入文档站发布笔记页标记区（`npm run docs:notes`） |
| `docs/` | 测试结论与学术图表（PNG / SVG / PDF + CSV；**TIFF 永不再进仓库**）；终端设计规范已迁入文档站 `docs-site/zh/reference/tui-design.md`（单一真值源） |
| `docs-site/` | VitePress 文档站（中文为主 + 英文镜像）：`zh/` `en/` 的 guides / reference / release-notes；写作规约见 `docs-site/AGENTS.md`；发布笔记由 `tools/gen-release-notes.mjs` 从 git 历史生成 |

数据流（Agent）：浏览器 `POST /api/agent/turn` → `loop.mjs` 按 harness 组装上下文（`context.mjs`）→ `wire.mjs` 按提供方协议请求上游（带 tools）→ `stream.mjs` 增量读取（文本 / 思考 / tool_calls）→ 工具经 `policy.mjs` 门控执行（ask 挂起等 `POST /api/agent/permission`）→ 结果回填进入下一轮 → 无 tool_calls 或触顶即 `turn_completed`；每轮经 `usage.mjs` 按提供方单价记账。客户端断开即 `AbortController` 中止 turn。

数据流（速测底座）：浏览器 `POST /api/chat` → `web.mjs` 按模型所属提供方选协议请求上游 → SSE 逐帧透传或翻译 → 结束按提供方单价结算用量账本。

## 2. 常用命令

| 命令 | 用途 | 注意 |
| --- | --- | --- |
| `npm test` | e2e 测试（mock 上游） | **每次提交前必跑**；不花真钱、不碰真实数据 |
| `npm run check` | 真实 API 连通自检 | 会花少量钱；改了上游相关逻辑时跑 |
| `PORT=8788 npm run web` | 开发态网页服务 | 避开 8787 正式端口 |
| `npm run dev:web` | 前端开发态（vite 5173，`/api` 代理 8787） | 只动 `web-ui/` 时用 |
| `npm run docs:dev` / `docs:build` / `docs:notes` | 文档站开发 / 构建 / 生成发布笔记 | 依赖例外仅 `docs-site/`，产物不提交 |
| `npm run bench` / `bench:smoke` / `bench:full` | 性能基准（basic / smoke / full 套件） | 本地回归参考，不作 CI 门禁 |
| `npm run build:web` | 构建前端产物到 `public/app/` | 改了 `web-ui/` 源码后必跑并提交产物；源码修复 + 产物同一常规提交直接落地并推送 `master`，不必逐次询问用户（push 会触发 CI 与 release-please，属预期流程） |
| `npm run typecheck:web` | `web-ui` 类型检查（`tsc --noEmit`） | CI 不装 `web-ui` 依赖，故不入 `npm test`；本地改 `web-ui/` 后跑 |
| `npm run chat` | 终端 Agent 会话 | 与网页共用 Loop / 会话 / 账本；斜杠命令含 `/plan` `/goal` `/btw` `/mcp` 与技能派生的 `/<技能名>` |
| `npm run color` | 纯色识别测试 | 真实调用，按需 |
| `npm run service` / `service:status` / `service:remove` | 安装 / 查看 / 卸载 LaunchAgent | — |
| `npm run publish` | 构建前端 + 打 `.app` + 重启服务 | **只能在 Bundle 外的源码目录执行** |
| `npm run app:build` | 构建前端 + 只构建不重启 | 同上 |

调试：`LOG_LEVEL=debug npm run web`；常驻服务日志在 `~/Library/Logs/com.auroraagent.app.log`。

发布：push 到 `master` 触发 `.github/workflows/release.yml`——先跑 `npm test`（Linux runner 需补装 `zsh`，Node 固定 24），全绿后 release-please 按常规提交（`feat` → 次版本、`fix` → 修订号，`docs` / `chore` 等不触发）开或更新「发布 PR」（版本号只动 `package.json` 一处 + 生成 `CHANGELOG.md`）；合并发布 PR 即打 tag 并创建 GitHub Release。版本基线锚点为 tag `v7.0.0`（commit `86e2276`）；仓库须开启 「Allow GitHub Actions to create and approve pull requests」且 workflow 默认权限为 write，否则 release-please 建不了 PR。发布分支由 `RELEASE_PLEASE_TOKEN`（classic PAT，`repo` scope；未配则回退 `GITHUB_TOKEN`，不阻断发布）推送——`GITHUB_TOKEN` 推送的分支触发 `pull_request` 事件时，GitHub 把 `github-actions[bot]` 当「首次贡献者」（无任何贡献历史），run 停在 `action_required` 等人工审批、CI 永不执行；换成有写权限的 PAT 属主即恢复。该审批策略无「关闭」档，`approval_policy` 最松仅 `first_time_contributors_new_to_github`（`GET /repos/{owner}/{repo}/actions/permissions/fork-pr-contributor-approval`）。文档站发布笔记仍走本地 `npm run docs:notes`。提交主题的分隔冒号须用半角 `:`（规约见第 11 节）——release-please 解析不了全角 `：`，那条提交会不进发布说明。

## 3. 数据目录与配置

三级回退（`util/config.mjs` 单一实现，`web.mjs` / `chat.mjs` / `check.mjs` / `tools/install-service.mjs` 共用；5.0.0 起旧命名一次性迁移：旧数据目录整体搬迁含 Key 保留、旧 config 就地改名）：

1. `AURORAAGENT_DATA_DIR` 环境变量（LaunchAgent 显式指定）
2. 同目录已存在 `auroraagent.config.json` → 用当前目录（源码开发态）
3. 否则 `~/Library/Application Support/AuroraAgent`（App 态，数据与 Bundle 解耦）

网页工作台偏好：主题（跟随系统 / 浅色 / 深色）存浏览器 `localStorage` 键 `auroraagent.theme`，只影响本机浏览器，不同步服务端。外观其余偏好（界面字号 / 浅深代码主题 / 显示行号 / 长行换行 / 代码字号）存 `auroraagent.ui-font-size` / `auroraagent.code-theme-light` / `auroraagent.code-theme-dark` / `auroraagent.code-line-numbers` / `auroraagent.code-wrap` / `auroraagent.code-font-size`，同样只影响本机浏览器；首帧由 `index.html` 内联脚本预置防闪。

配置字段：`apiKey` / `model` / `thinking` / `temperature` / `maxTokens` / `permissionMode` / `planMode` / `titleMode`（标题生成方式：local 本地推导零成本 / model 调模型总结，缺省 local，非法值回退缺省）/ `providerFailover`（多提供方故障转移开关，缺省 true）与 `providerFailoverMaxAttempts`（含首次总尝试次数，缺省 3，钳制 1..5；解析落 `util/llm/failover.mjs` 的 `parseFailoverConfig`，经 `GET/POST /api/settings/failover` 与设置页「故障转移」面板读写；环境变量 `AURORAAGENT_FAILOVER` / `AURORAAGENT_FAILOVER_MAX_ATTEMPTS` 优先于盘上配置）/ `failover` 段（超时三件套 `firstByteMs`（首包，缺省 60000）/ `idleMs`（流式空闲，缺省 120000）/ `nonStreamMs`（响应头总时限，缺省 600000），单位毫秒、钳制 0..3600000、0=禁用且仅故障转移开启时生效；熔断五项 `circuit`（`failureThreshold` 4 / `successThreshold` 2 / `timeoutSeconds` 60 / `errorRateThreshold` 0.6 / `minRequests` 10，保存即热更新不重置已有状态）；热切换偏好有效期 `prefTtlHours`（缺省 24，超时回退默认顺序）；与既有两项同经 `GET/POST /api/settings/failover` 读写、单叶容错 + 钳制，不新增 env 覆盖）/ `agentProxy`（Agent 沙箱出站代理：`http://主机:端口` 或裸 `主机:端口`，空 = 直连；web_fetch 等工具经它访问本机直连被重置的站点（如维基百科），`util/proxy.mjs` 归一化校验，设置页「网络」面板经 `GET/POST /api/settings/proxy` 读写，保存后即时生效，不影响模型上游请求）；`temperature` / `maxTokens` / `apiKey` 可经 `GET/POST /api/settings/generation` 与 `GET/POST /api/settings/key` 读写（`util/settings-generation.mjs`，网页斜杠命令 /temp /max /key 与设置页「通用」面板同源，下一轮请求即时生效）/ `goal` 段（目标模式：`verification` 三档缺省 none、`evaluatorModel`、`evidence`、`repeatedReplyLimit`、`repeatedNotMetLimit`、`graceSteps`、`mainTurns`、`activeSeconds`、`evaluatorMaxTokens` / `evaluatorTimeoutSeconds` / `evaluatorMaxRetries`，解析落 `util/agent/goal/config.mjs`）/ `tui` 段（终端偏好：`terminalTitle` 项序 + `notifications` 的 when / method / events，解析落 `util/tui/config.mjs`，经 `GET/POST /api/settings/tui` 读写，终端启动时读取一次）；用量账本 `usage.jsonl` 逐行追加；会话在 `sessions/<id>.meta.json` + `.jsonl`；目标在 `goals/<sessionId>.json`（一会话一个，原子落盘，`updatedAt` 兼作 CAS 决策纪元）；熔断快照与热切换偏好在 `failover-state.json`（原子落盘 + 写节流 1s，损坏静默回退空态，`POST /api/settings/failover/reset` 带 `providerId` 单家重置、缺省全量重置）；自定义提供方存 `providers.json`（顶层 `failoverQueue` 即故障转移队列，设置页「提供方」面板编排）；新建会话默认名 `新会话`（`session.mjs` 的 `DEFAULT_SESSION_NAME` 单一常量），首条消息自动总结出标题后替换，用户改名不被覆盖；titleMode 可全局配置，也可会话级热切换（网页输入区「本地总结 / 模型总结」选择器 PATCH 落 meta / 终端 `/title local|model`，新建会话继承当前选择）。环境变量 `AURORAAGENT_API_KEY`、`AURORAAGENT_BASE_URL` 优先级高于配置文件；`AURORAAGENT_FAILOVER=0` 可一键关闭多提供方故障转移（`AURORAAGENT_FAILOVER_MAX_ATTEMPTS` 覆盖尝试次数）。实验特性开关：`AURORAAGENT_EXPERIMENTAL_<NAME>`（如 `AURORAAGENT_EXPERIMENTAL_MCP`）单开、`AURORAAGENT_EXPERIMENTAL_FLAG` 全开，缺省关（`util/config.mjs` 单一实现）。

**`auroraagent.config.json`、`usage.jsonl`、`providers.json`、`mcp.json`、`sessions/`、`goals/` 已在 `.gitignore`，永远不许提交**——Key 泄露即安全事故。自定义提供方（含 API 密钥、单价）存 `providers.json`，内置 LongCat 提供方在内存里合成（`builtin: true`，只读）。用户技能放 `<数据目录>/skills/<名称>/SKILL.md`（与内置 `skills/` 合并展示）；MCP 服务器配置存 `mcp.json`（含连接信息，同级不提交）。

## 4. 代码风格铁律

- 后端只用 Node 内置模块
- 2 空格缩进、单引号、行尾分号，与现有文件保持一致
- 注释与面向用户的文案一律中文；错误消息必须「说清原因 + 给出下一步动作」（参考 401 / 402 的友好映射）
- **产品内零 emoji**：网页 UI、错误消息、终端 banner 都不允许 emoji；图标一律内联 SVG 或 `public/vendors/*.svg`。终端 CLI 的 `✓` / `✗` 属命令行惯例，允许保留
- 前端不引 CDN、不引 Markdown / 状态管理等第三方库；动画用原生 CSS（`@starting-style`、top-layer 过渡）
- 服务路由集中在 `web.mjs` 单个 `createServer` 处理器内按「方法 + 路径」平铺，不引路由库；Agent HTTP 面已拆 `util/agent/http.mjs`
- 单文件控制在约 500 行内；`web.mjs` 已接近上限，新功能优先拆到 `util/` 等模块

## 5. 服务生命周期（macOS LaunchAgent）

- Label `com.auroraagent.app`（5.0.0 起；旧 label `com.modeltester.app` 在安装/卸载时自动清理）；plist 位于 `~/Library/LaunchAgents/`；`RunAtLoad` + `KeepAlive`
- 日志**必须**落 `~/Library/Logs/com.auroraagent.app.log`：launchd 无权重定向到 `~/Documents` 等 TCC 保护目录，否则 job 以 exit 78 反复失败
- LaunchAgent 场景 `NO_OPEN=1` 不弹浏览器；只有用户手动开 App 才 `open`
- 端口冲突时 `web.mjs` 按 1 秒间隔重试最多 60 次——这是设置页切换自启时新旧实例平滑交接（约 1 秒不可用窗口）的基石，**不要改**
- 设置页开关语义：`autostart` = plist 是否存在；`managed` = 当前进程是否正被 LaunchAgent 托管
- **禁止在 Bundle 内执行 `npm run app:build`**：构建会先删掉整个 `.app`，`tools/build-app.mjs` 的自保护会直接报错；正确做法是把 `Resources/app` 拷到 Bundle 之外的目录再构建
- `publish` / `app:build` 已前置 `build:web`：Bundle 内置 `public/app/` 产物，运行时不依赖 node_modules

## 6. 接入新厂商 checklist

1. `public/vendors/<name>.svg` 放厂商标识；`web.mjs` 的 `/vendor/` 白名单路由自动放行（正则防目录穿越，勿放宽）
2. `web-ui/src/components/Composer.tsx` 的厂商标识前缀匹配加一行（模型 id → 图标）；终端不需要（无图标渲染）
3. 配置 `AURORAAGENT_BASE_URL`；模型目录来自上游 `GET /openai/v1/models`，代码不硬编码厂商模型清单
4. `README.md`「当前接入厂商」段同步更新；协议差异（如思考开关字段、Messages 线路、tools 字段形态）在 `util/wire.mjs` 处理并补测试；更常见的路径是让用户直接在设置页加自定义提供方，无需改代码
5. 遵守第 11 节：每完成一步且 `npm test` 通过，就提交推送一次

## 7. 测试规约

- e2e 模式：mock 上游（`127.0.0.1:18901`，复刻真实 SSE 帧与 401 / 402 错误、`tool_calls` 帧与 tool 结果回执）+ 真实 socket 拉起 `web.mjs`（`127.0.0.1:18787`）
- **数据隔离**：测试以临时目录作 `AURORAAGENT_DATA_DIR`，绝不许写真实数据目录
- 测试套件直接 import `web-ui/src/highlight.ts`（Node 侧类型剥离），需 Node ≥ 23.6（本机 24，CI 固定 `node-version: 24`）；后端运行时仍只需 Node 18+
- 新路由 / 新行为 / 新错误映射必须带中文测试名进入 `test/run-tests.mjs`；mock 需要新行为时改 `test/mock-longcat.mjs`
- mock 触发词：消息含 `USE_TOOL` → 模型发起 `read_file mock.txt`；含 `USE_TOOL_WRITE` → 发起 `write_file written_by_agent.txt`；`FLAKY` 断网重试；`SLOW` 慢速；`USE_SKILL` / `USE_TODO` / `USE_EDIT` / `USE_PLAN` / `USE_SWARM` / `USE_MCP` 分别触发技能加载 / 待办维护 / diff 回传 / 计划两阶段 / 子代理派发 / MCP 工具调用；`USE_GOAL` → create_goal 全链路；`USE_GOAL_BUDGET` → 预算触顶转 budget_limited + 收尾轮；`USE_GOAL_IDLE` → 空转轮后续跑；`USE_GOAL_VERIFY_MET` / `USE_GOAL_VERIFY_NOTMET` → evaluator 裁决 met 转 complete(verifier_met) / not_met 连击转 paused(no_progress)（对齐 MiniMax repeatedGap）；`USE_GOAL_VERIFY_RETRY` → evaluator 首轮无结论恰好重试一次后采信 met；`USE_GOAL_EDIT:<会话id>` → turn 内经 REST 改写目标文本，在飞模型下一轮收到【目标已更新】并按新目标结算；`GOAL_TURN2` → REST 预建 active 目标后新用户轮首轮重述（【进行中的目标】），空转续跑后提案完成；系统提示带 `【会话标题生成】` 标记即标题生成轮（titleMode=model），回固定标题 `README 安装章节改写`
- 前端契约测试（`/app` 服务、哈希资产、令牌 CSS 在场、零 emoji、旧路由 404、ProviderEditor 源码校验规则）守着构建产物与 `web-ui/` 的同步；改了 `web-ui/` 忘了 `build:web` 会红
- 仓库守卫（`test/guards.mjs`，已入 `npm test`）：产品源码零 emoji、TUI 颜色单一真值源（仅 `theme.mjs` 出 SGR）、色板对比度达标、**网页设计令牌双主题对比度达标**（`tokens.css` 的 `:root` 与 `:root[data-theme="light"]` 关键前景 / 背景组合按 WCAG 阈值校验，防止浅色主题改糊）、新模块 ≤500 行、过渡动画禁 `transition:all`（只动颜色 / 透明度 / 变换，ZCode 教训）、文档站结构契约（中英页面一一对应 / 发布笔记标记在场 / 依赖例外登记）、**README 版本机制**（README 只保留「版本随 package.json」取数机制标注、不硬编码版本号——release-please 发布 PR 只动 `package.json` 与 `CHANGELOG.md`，硬编码会让发布 PR 的 CI 必然红、合并后 master 持续红）、**架构地图覆盖**（`util/` 顶层与 `util/agent/` 每个模块都登记进第 1 节表格，基线豁免记 `test/architecture-baseline.json`，对齐 ZCode architecture-baseline 思路）
- 基线 409/409 通过。提交前 `npm test` 必须全绿；不许 `skip`，不许放宽断言迁就失败
- `npm run check` 走真实上游，只在改上游集成时跑（花少量钱）
- 跑 `npm test` 前确认 18901 无常驻 mock 占用（`pkill -f mock-longcat`）；exec 沙箱会杀后台进程，常驻服务 / mock 用 exec_command 前台会话跑

## 8. 反模式（NEVER）

- **NEVER** 攒一批改动才提交；**NEVER** 在测试红着时提交
- **NEVER** 提交 `auroraagent.config.json` / `usage.jsonl` / `providers.json` / `sessions/` / 任何日志
- **NEVER** 在产品 UI 里加 emoji
- **NEVER** 在 Bundle 内执行 `npm run app:build`
- **NEVER** 改动厂商事实层：模型 ID、显示名映射规则、价格常量 `PRICE`、纯色测试结论——除非上游本身变了
- **NEVER** 修改 `web.mjs` 的 EADDRINUSE 重试逻辑与 plist 日志路径约定（见第 5 节）
- **NEVER** 触碰 `~/Documents/cc-switch`（其他项目的仓库）
- **NEVER** 用 `rm -rf` 删目录；用 Node `fs.rmSync` 并二次确认路径

## 9. 验证基线（改动后自查）

- `npm test` → 409/409
- `curl -s localhost:8787/api/health` → `{"ok":true,...}`；`/api/settings` → `version` / `managed` / `dataDir` 符合预期
- 浏览器打开 http://localhost:8787 ：无 emoji、模型选择器按提供方分组、完整 turn（工具卡 / 权限卡 / 用量脚注）正常、设置弹层可开关开机自启；Header 工作区卡 hover 即显 / 点击 pin、标题双击重命名、更多与帮助菜单可用；浮层切换 / 后退 / 前进 / 新建在展开与收回两态都到位，收回态 Header 左侧让位无重叠；窄窗口（主列 <360px）自动收回且不自动展开
- 网页快捷键：`Ctrl/Cmd+K` 新建会话、`Ctrl/Cmd+B` 折叠 / 展开侧栏（收回态左侧边整体消失、只留常驻顶部浮层与 48px Header，侧栏 200ms 擦除；浮层上切换钮静止显品牌砖、悬停淡入面板图标 + 「切换侧边栏 + ⌘B/Ctrl+B」提示，另有后退 / 前进（会话导航历史，栈首 / 栈尾禁用）、新建会话与更新入口；`Ctrl/Cmd+[` 后退、`Ctrl/Cmd+]` 前进（与浮层箭头同栈同规则）；Header 常驻展示工作区上下文卡（hover 即显 / 点击 pin：路径 / 活动 / git 分支）、会话标题（双击重命名）、更多与帮助菜单；像素级对齐 ZCode WorkspaceHeader / DesktopTopOverlay）、`/` 聚焦输入框（焦点不在输入控件时）；对话区上翻读历史时不抢滚动，出现「回到最新」按钮，点它或继续贴底即恢复跟随；对话区左缘的回合导航：≥2 问且会话区宽于 864px 时出现梯状短棒，悬停某条以它为山峰衰减并浮出预览卡（提问 + 助手摘录），点击平滑跳到对应提问，滚动位置驱动高亮当前读到哪一问
- 终端 `npm run chat`：`/help`、权限 y/n/a、`/sessions` 切换、`/goal` 状态与预算、`/btw` 侧边对话与 `Ctrl+/` 切换均正常
- 改了启动 / 打包逻辑：`npm run publish` 后 `launchctl print gui/$(id -u)/com.auroraagent.app` 确认 `state = running`

## 10. 文档同步

- 行为发生变化时，同一次提交里更新 `README.md`（人类文档）与本文件（agent 规约）
- 版本号只改 `package.json` 一处（Info.plist 与 `/api/settings` 都读它）；品牌名 AuroraAgent 仅作品牌与文档名，包名 / Bundle ID / LaunchAgent label / 数据目录约定不变
- `docs/figures/` 只放 PNG / SVG / PDF + CSV；**TIFF 永不再进仓库**（历史上有过 112MB 教训）
- 图表脚本 `docs/figure-work/make_figures.py` 本机只能 `py_compile` 验证（环境无 numpy / matplotlib）；图标管线用 `npx sharp-cli`

---

## 11. 提交与推送规约

每完成一个通过测试的小改动，就 `git commit` 并 `git push`：不攒批、不等提醒、不留本地。这是与其他各节平行的普通工作规则；硬红线（不攒批、测试红着不提交、禁提交敏感文件）见第 8 节。

执行顺序：

1. 改代码（一个可独立验证的小改动，例如「修复一个错误映射」「新增一个厂商标识」）
2. `npm test` 全绿（基线 409 个测试；不绿不提交）
3. `git add <具体文件>` → `git commit -m "中文描述"` → `git push`

规约：

- 粒度：一次提交只做一件事；大任务拆成多次提交，每次提交后仓库都必须处于可运行、测试全绿的状态
- 提交信息：中文，一句话说清「改了什么、为什么」，如 `fix(chat): 401 错误映射补充额度不足分支`；**前缀后的分隔冒号必须用半角 `:`**（`feat(llm): xxx`）——release-please 的提交解析器只认半角，全角 `：` 会让该条提交解析失败并静默不进发布说明（7.2.0 前的历史主题全是全角，属已知欠账；已推送的历史不改写，见本节「不得改写已推送的历史」）；正文照常中文
- 身份与远端：`user.name=AuroraAeon` / `user.email=auroraaeon@users.noreply.github.com`；`origin` = https://github.com/AuroraAeon/AuroraAgent（public，master 分支）
- 凡触及真实上游行为的改动（请求格式、错误映射、模型目录解析、tools 拼装），提交前额外跑一次 `npm run check`
- 推送失败先诊断（网络 / 权限），不得 `--force` 绕过，不得改写已推送的历史
- 改了 `web-ui/` 源码必须同步 `npm run build:web` 并提交 `public/app/` 产物（运行时零构建的保证）
