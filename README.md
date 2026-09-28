# AuroraAgent — 本地 Agent 运行时

对标 OpenBitFun 的本地 Agent 运行时：终端 + 网页双客户端共用同一套 Agent Loop（会话 / 轮次 / 工具 / 权限 / 上下文压缩），后端零依赖（只需 Node 18+），可打包为独立 macOS Application。原来的「全球厂商最新大模型速测」能力完整保留为底座——`/api/chat` 流式对话、自定义提供方、用量账本一切照旧。

**当前接入厂商：美团 LongCat-2.5-Preview**（2026-09-25 上线，万亿参数级 Agentic 模型，1M 上下文、128K 输出，OpenAI / Anthropic 双协议兼容）。Base URL、模型目录、Key 均为配置项，接入新厂商不改架构。

## 它是什么

- **Agent Loop**（`util/agent/loop.mjs`）：一轮用户输入驱动「模型请求 → 工具调用 → 结果回填 → 再请求」的循环，直到模型不再调用工具或触顶模式轮次上限；中断保留已生成内容，SSE 断开即中止上游，不浪费额度
- **十一个内置工具**（`util/agent/tools.mjs`）：`read_file` / `list_dir` / `write_file` / `edit_file` / `shell` / `web_fetch` / `grep` / `glob` / `todo` / `skill` / `task`，JSON Schema 参数；文件工具经路径解析 + 前缀校验禁锢在会话 workspace 内（拒绝穿越），`shell` 限定工作目录与超时（默认 30s、上限 120s），工具输出超限截断；技能（`skill`）与 MCP 服务器工具经同一套 kosong 形状接口动态入列（`mcp__<服务器>__<工具>`）
- **权限门控**（`util/agent/policy.mjs`）：只读工具默认放行，写文件 / 编辑 / 执行命令必须经你确认；「总是允许」沉淀为会话级规则，不是全局放行
- **上下文压缩**（`util/agent/context.mjs`）：token 估算超过窗口阈值（默认 128k 的 70%）时，把早期对话经一轮模型调用总结为 summary 记录，保留近期尾部原文
- **三档 Harness 模式**（`util/agent/harness.mjs`）：模式决定任务怎么被完成——系统提示、可用工具、轮次上限、压缩阈值都随模式变化
- **技能与扩展**：`skills/` 内置 + `<数据目录>/skills/` 用户技能（frontmatter 目录常驻系统提示，`/<技能名>` 斜杠命令与 `skill` 工具按需加载正文）；`task` 工具派发子代理并行处理相互独立的子任务并聚合结果；MCP 客户端（实验特性，stdio / HTTP 双传输）把外部服务器工具接入同一套工具接口
- **Goal 目标模式**（`util/agent/goal/`）：给会话挂一个跨轮次存续的目标——模型自主推进、独立验证、自动续跑，直到完成、受阻或预算耗尽；六态状态机 + 三维预算（token / 轮次 / 活跃时长）+ 无进展双熔断，你随时可暂停 / 恢复 / 改预算（`/goal`、GoalBar、`POST /api/agent/goal/*`）
- **按轮记账**：每一轮模型请求经 `util/usage.mjs` 按提供方单价结算，会话内可看到每轮 tokens 与费用
- **事件协议**（`util/agent/events.mjs`）：`turn_started` / `model_round_started` / `text_chunk` / `thinking_chunk` / `tool_event` / `token_usage_updated` / `context_compression_*` / `turn_completed|cancelled|failed`，统一 SSE 帧封装，终端与网页共用

## 快速开始

```bash
npm run chat      # 终端 Agent 会话
npm run web       # 网页工作台 http://localhost:8787
```

没配 Key 时按提示操作：打开 <https://longcat.chat/platform/api_keys> 创建 Key，然后三选一——对话里 `/key sk-你的Key`（自动保存）、`export AURORAAGENT_API_KEY="sk-你的Key"`、或写进配置文件的 `apiKey` 字段。

## Harness 模式

| 模式 | 定位 | 工具 | 轮次上限 | 压缩阈值 |
| --- | --- | --- | --- | --- |
| Minimal | 快速协作：目标明确时直接作答 | 无 | 1 | 90% |
| Standard | 日常任务：按需调用工具，多步推进并核对结果 | 全部（含 task 派发） | 24 | 70% |
| Ultimate | 复杂任务：充分探索、逐步验证、汇总结果 | 全部（含 task 派发） | 64 | 60% |

模式在输入区一键切换（下一轮生效），也可 `PATCH /api/agent/sessions/:id` 热切换。Creative（Mini App 创作）留待后续迭代。模式之上还有两个正交维度：**权限三档**（始终询问 / 必要时询问 / 完全自动）与**计划模式**（先出计划、批准才执行），互不替换。

## 工具与权限

| 工具 | 作用 | 默认权限 |
| --- | --- | --- |
| `read_file` | 读工作目录内文本文件（带行号，offset/limit 分段） | 放行 |
| `list_dir` | 列目录直接子项 | 放行 |
| `web_fetch` | 抓取网页（带响应大小上限） | 放行 |
| `write_file` | 覆盖写文件（自动建父目录） | 需确认 |
| `edit_file` | 精确字符串替换（多处出现需上下文或 replace_all） | 需确认 |
| `shell` | 工作目录内执行 shell 命令（退出码 + 输出，超限截断） | 需确认 |
| `grep` | 工作目录内正则检索（文件名 + 行号 + 命中行，预算截断） | 放行 |
| `glob` | 按 glob 模式找文件（大小写敏感、忽略 `node_modules`） | 放行 |
| `todo` | 规划清单维护（增项 / 更新状态，随会话持久化） | 放行 |
| `skill` | 按名称加载技能正文（frontmatter 目录常驻系统提示） | 放行 |
| `task` | 派发子代理：受限子 turn 并行处理自含子任务并聚合结果 | 放行 |
| `create_goal` | 建立跨轮次目标（仅 Standard / Ultimate；已存在未完成目标时失败） | 放行 |
| `update_goal` | 提案 complete / blocked；用户显式要求时带新鲜快照改 token 预算（CAS 纪元校验） | 放行 |
| `get_goal` | 读当前目标：状态 / 时间戳 / 用量 / 预算 | 放行 |

需要确认的工具会在界面里弹出权限卡：**允许**（仅这一次）/ **总是允许**（本会话后续同类操作放行，落会话规则）/ **拒绝**（结果回给模型，循环继续）。终端里是 `y` / `a` / `n` 确认。

询问粒度可切三档（网页输入区下拉 / 终端 `/plan` 同级设置，会话级）：**始终询问**（连只读也逐次确认）/ **必要时询问**（默认，只读放行、写与执行询问）/ **完全自动**（放行 ask 类动作，但用户「总是允许」沉淀的规则与显式 deny 仍然优先）。另开**计划模式**（网页开关 / 终端 `/plan on`）：下一轮模型只用只读 / 检索 / 待办工具产出计划，你在计划卡上**批准**才进入完整工具集的执行轮，**驳回**则本轮收尾不动手。

**安全边界（如实说明）**：v1 没有 OS 级沙箱。当前边界是「文件工具路径禁锢在会话 workspace + 写与执行必经权限门控」。workspace 默认 `<数据目录>/workspace`，创建会话时可指定。

## 网页工作台

`npm run web` 后访问 <http://localhost:8787>（React + Vite + TypeScript，源码在 `web-ui/`，构建产物随仓库提交在 `public/app/`，运行时零构建）：

- **侧栏**：AuroraAgent 品牌、新建会话、会话列表（相对时间 + 模式 + 轮次）、当前模式；新会话的首条消息发出后，侧栏标题会按消息内容自动总结更新（默认本地推导，不调模型、不花额度；输入区也可切「模型总结」——每个新会话多一次小额请求，失败自动回退本地推导；你手动改过名的会话不被覆盖）
- **对话区**：用户消息、流式回答、可折叠思考块、工具卡片（状态 / 参数 / 结果 / 差异）、内联权限卡、每轮用量脚注（tokens + 费用）；正文支持 LaTeX 公式渲染与 Markdown 表格；回答与工具调用按发生顺序交错呈现，不被每次工具调用切断
- **输入区**：自适应文本框、`@` 文件 / 技能提及（只读搜索会话工作目录，调色板键盘可选）、模型选择器（按提供方分组，二级菜单内含思考强度：标准 / 关闭）、模式切换（芯片定宽，切换不重排输入区）、标题生成方式（本地总结 / 模型总结，会话级）、发送 / 停止
- **目标条**：有 Goal 时单行停靠在输入框上方——「进行中」状态芯片、目标内容（超长省略）、tokens / 轮次 / live 时长、预算上限、验证结论芯片（verdict × 连击，缺失项与提示收进悬停 title），暂停 / 恢复 / 停止一键操作，等待授权 / 验证时芯片改用等待标签，目标完成即隐藏（回执走消息流）；另一客户端（终端 / 另一标签页）的改动经 SSE 事件流实时同步
- **`/goal` 命令**：聊天框直接输入即走目标命令（整段 `/goal` 开头不当作普通消息）——`/goal <目标内容>` 设立或改写、`budget=50K` 一并设预算、`/goal edit` 回填续编、`/goal clear` 移除（`cancel` / `delete` 同义）、`pause/resume/stop`，与终端同一份解析器
- **会话派生**：侧栏每会话可复制历史到新会话（新 id，原会话不动）
- **设置弹层**（左侧分类导航：通用 / 提供方 / 故障转移 / 网络 / 技能 / MCP 工具 / 终端 / 用量 / 错误日志，首次进入才加载、切换保留草稿）：提供方管理（自定义上游）、用量统计（近 30 天逐日 token 走势 + 按模型 / 提供方 / 用途 / 会话构成 + 最近请求明细）、错误日志（界面崩溃与未捕获错误的落盘查看与清空）、开机自启开关、终端偏好（OSC 标题项序、系统通知时机 / 通道 / 事件；浏览器通知 opt-in 开关，默认关）、网络（Agent 沙箱出站代理：本机直连被重置的站点（如维基百科）可经 `http://127.0.0.1:7890` 这类本机 HTTP 代理抓取，留空直连，保存即时生效）、外观（跟随系统 / 浅色 / 深色，只影响本机浏览器）、数据目录与版本
- **快捷键**：`Ctrl/Cmd+K` 新建会话，`/` 聚焦输入框；对话区上翻读历史时停止自动贴底，出现「回到最新」按钮，点一下或重新贴底即恢复跟随
- **版本检查**：设置页「服务」段可检查 GitHub Releases 新版（结果缓存 6 小时，只提示不自动安装）
- **通知与容错**：右下角通知（保存成功 / 切换失败等一次性反馈，悬停暂停计时，同一提示不重复刷屏）；未捕获异常与 Promise 拒绝统一上报错误日志；渲染期崩溃显示可重载 / 可复制详情的兜底页而非白屏
- 设计令牌自原版迁移（深色为默认，另有浅色主题整套同名变量覆盖，`data-theme` 首帧预置防闪；强调蓝 `#4d8df6`）；零 emoji，图标一律内联 SVG；Markdown 为手写子集渲染器（标题 / 列表 / 代码高亮 / 表格 / 公式），不引第三方库

开发态前端：`npm run dev:web`（vite 监听 5173，`/api` 代理到 8787）；改完前端 `npm run build:web` 产出即被 `web.mjs` 以 `/app/` 服务（哈希资产长缓存 + SPA 回退 + 防目录穿越）。

### LaTeX 公式渲染

模型回答里的数学公式由 KaTeX 渲染（自托管、零 CDN、离线可用）。分隔符全覆盖，模型怎么写都能识别：

| 写法 | 形态 |
| --- | --- |
| `$...$` | 行内公式 |
| `\(...\)` | 行内公式 |
| `$$...$$` | 显示公式（可跨行） |
| `\[...\]` | 显示公式 |
| `\begin{env}...\end{env}` | 显示公式（模型常不写分隔符，按环境名识别） |

两条护栏：反引号代码段与代码块里的 `$` 一律不当公式（`` `\$x\$` `` 原样展示）；「价格 $5 到 $10」「区间 $100-$200」这类货币与区间写法有假阳性防护，不会变成公式。分隔符未闭合时按普通文本处理，不会吞掉后续内容。公式解析失败时不刷红色错误墙，回退展示原始源码（流式输出中途的半截公式也保持可读）。宽公式在气泡内横向滚动，不撑破布局。

安全边界：KaTeX 的 `trust` 保持关闭，`\href` / `\includegraphics` / HTML 扩展一律拒绝渲染，杜绝公式注入。

## 终端客户端

`npm run chat` 或 `node chat.mjs`，与网页共用同一套 Loop、会话、账本（数据同目录，两端可交替使用）：思考过程暗色流式渲染、工具调用单行状态、权限 `y/n/a` 确认、恢复会话时打印最近几行 recap。提示符上方有状态栏（模型 · 模式 · 思考 · 权限 · tokens/费用）；`/sessions` `/harness` `/theme` 无参数时弹出可搜索选择器（`↑↓` 移动、`←→` 翻页、输入即过滤、`Enter` 选中、`Esc` 取消），终端太窄或非 TTY 时自动退化为编号列表。配色走语义主题（`AURORAAGENT_THEME=dark|light|auto` 或 `/theme` 切换），规范见文档站 `docs-site/zh/reference/tui-design.md`。终端标题按 `tui.terminalTitle` 项序实时改写（`状态 | 会话名 | AuroraAgent`，退出 / 挂起清空）；任务完成 / 失败 / 等待授权 / 等待提问可经 OSC9 / OSC777 / bel 发系统通知（`tui.notifications` 三档，设置页「终端」面板配置）；有进行中的目标时状态栏显示用量芯片（`12.5K / 50.0K · 2m30s`）。

| 命令 | 作用 |
| --- | --- |
| `/new` | 新建会话（沿用当前模型 / 提供方 / 模式 / 标题生成方式） |
| `/sessions` `/sessions <n>` | 列出 / 切换会话 |
| `/model <名称>` | 切换模型（按 ID 反查提供方） |
| `/harness <minimal\|standard\|ultimate>` | 切换模式（无参数弹出选择器） |
| `/theme <dark\|light\|auto>` | 切换终端主题（无参数弹出选择器） |
| `/title <local\|model>` | 标题生成方式：local 本地推导零成本 / model 调模型总结（每个新会话多一次小额请求，失败自动回退；无参数查看当前值） |
| `/goal` | 目标模式（终端与网页 Composer 同解析）：无参看状态；`/goal <目标内容>` 设立（有未完成目标时改写文本，可带 `budget=50K`）；`/goal budget=50K\|clear` 改 token 预算（旧式 `budget 50000` 等价；纪元不符 409，可重新武装预算耗尽的目标）；`/goal edit` 目标文本回填续编；`/goal clear` 移除（`cancel` / `delete` 同义）；`/goal pause\|resume\|stop`；`/goal help` |
| `/btw <问题>` | 侧边对话：继承当前会话历史开聊，不落盘不进 `/sessions`；`Ctrl+/` 切换、空提示符 `Ctrl+C` 丢弃 |
| `/plan on\|off` | 计划模式开关（默认关；开启后下一轮先出计划，批准才执行） |
| `/mcp` | MCP 服务器与工具状态（实验特性，需 `AURORAAGENT_EXPERIMENTAL_MCP=1`） |
| `/<技能名>` | 技能派生命令：把该技能正文作为指令注入下一轮（与网页斜杠调色板同源） |
| `/think on\|off` | 思考过程开关（默认开） |
| `/temp 0~1` `/max <n>` | 温度 / 单次最大输出 tokens |
| `/key <Key>` | 换 Key 并保存 |
| `/help` `/quit` | 帮助 / 退出 |

`node chat.mjs -p "用一句话介绍你自己"` 单次提问；`node chat.mjs --key sk-xxx` 免配置启动。

## 服务端接口

Agent 运行时（`/api/agent/*`，单活跃 turn：已有 turn 在跑时返回 409）：

| 接口 | 说明 |
| --- | --- |
| `POST /api/agent/sessions` | 创建会话（model / provider / harness / workspace / titleMode，默认 workspace 为 `<数据目录>/workspace`；titleMode 缺省继承全局配置） |
| `GET /api/agent/sessions` | 会话列表（meta） |
| `GET /api/agent/sessions/:id` | 会话详情（meta + 记录投影） |
| `PATCH /api/agent/sessions/:id` | 热切换 harness / 改名 / 换模型 / 标题生成方式 titleMode（下一轮生效；未知模式与非法模型 ID 返回 400 且不改动会话） |
| `DELETE /api/agent/sessions/:id` | 删除会话 |
| `POST /api/agent/sessions/:id/fork` | 派生会话：复制 meta 与全部转录到新会话（goal 不随复制） |
| `POST /api/agent/turn` | 发起一轮对话，SSE 事件流（事件协议见上）；会话仍是默认名时，首轮总结出标题并推送 `session_renamed`（titleMode 按请求体 > 会话 meta > 全局配置解析） |
| `POST /api/agent/abort` | 中止当前 turn，保留已生成内容 |
| `POST /api/agent/permission` | 权限决策回传：`{requestId, decision: 'allow'\|'deny'\|'always'}` |
| `POST /api/agent/plan` | 计划决策回传：`{sessionId, requestId, approve: true\|false}` |
| `GET /api/agent/skills` | 技能目录（内置 + 用户，name + description + 来源） |
| `GET /api/agent/harnesses` | 三档模式契约 |
| `GET /api/agent/goal/:id` | 读会话目标（无目标回 `{ goal: null }`） |
| `POST /api/agent/goal` | 创建目标（未完成目标已存在时 409 `GOAL_STATUS_CONFLICT`） |
| `POST /api/agent/goal/edit` | 改写未完成目标文本（空白 400 `GOAL_BAD_OBJECTIVE`，已完成 409） |
| `POST /api/agent/goal/clear` | 幂等移除目标（回 `{ cleared }`，无目标也 200） |
| `POST /api/agent/goal/pause` · `/resume` · `/stop` | 目标用户面迁移（对 complete / budget_limited 恢复 active 拒绝 409） |
| `POST /api/agent/goal/budget` | 改 token 预算（纪元不符 409 `GOAL_STALE`；抬高或清零可重新武装 budget_limited） |
| `GET /api/agent/events?sessionId=` | 跨客户端 goal 事件流（SSE）：另一客户端经 REST 改动目标时即时推送，网页横幅实时校正 |
| `GET /api/files/search?sessionId=&q=` | 会话工作目录内只读文件搜索（路径禁锢，跳过依赖目录） |
| `GET/POST /api/settings/tui` | 终端偏好读写（标题项序 + 通知三档；坏值 400） |

MCP 实验面（`AURORAAGENT_EXPERIMENTAL_MCP=1` 门控，未开启 404 并附开启指引）：`GET /api/mcp/servers`、`POST /api/mcp/servers`、`DELETE /api/mcp/servers/:id`、`POST /api/mcp/servers/:id/probe`（测试连接并列举工具）。

模型速测底座（全部保持原样）：`POST /api/chat`（SSE 流式对话，`provider` 路由自定义上游）、`POST /api/abort`、`GET /api/models`（60s 缓存）、`GET/POST/PUT/DELETE /api/providers*`、`POST /api/providers/discover`、`GET /api/status` `/api/health`、`GET /api/usage`（`?lite=1` 只取汇总；默认另带近 30 天 `stats` 统计视图）、`GET/POST /api/settings`、`POST/GET/DELETE /api/logs/errors`（前端崩溃与未捕获错误的落盘与查看）、`GET /api/update/check`（GitHub Releases 版本检查，6 小时缓存）、`GET /vendor/<name>.svg`。

## 数据与日志（与 App 解耦）

| 内容 | 位置 |
| --- | --- |
| API Key / 模型 / 温度等配置 | `~/Library/Application Support/AuroraAgent/auroraagent.config.json` |
| 会话（meta + 追加式转录） | `~/Library/Application Support/AuroraAgent/sessions/<id>.meta.json` + `.jsonl` |
| 目标（一会话一个，原子落盘） | `~/Library/Application Support/AuroraAgent/goals/<sessionId>.json` |
| 用量账本（含被中止的请求） | `~/Library/Application Support/AuroraAgent/usage.jsonl` |
| 错误日志（前端崩溃 / 未捕获错误，环形保留 200 行） | `~/Library/Application Support/AuroraAgent/logs/errors.log` |
| 自定义提供方（Key / 端点 / 模型目录 / 单价） | `~/Library/Application Support/AuroraAgent/providers.json` |
| 服务日志 | `~/Library/Logs/com.auroraagent.app.log` |

数据目录三级回退：`AURORAAGENT_DATA_DIR` 环境变量 → 同目录已存在 `auroraagent.config.json` 时用当前目录（源码开发态）→ `~/Library/Application Support/AuroraAgent`（App 态）。`auroraagent.config.json`、`usage.jsonl`、`providers.json`、`mcp.json`、`sessions/`、`goals/` 永不进仓库。

## 启动与常驻

- **双击 `~/Applications/AuroraAgent.app`**：服务已在运行就直接打开浏览器；否则后台拉起服务再打开。整个 Bundle 可随意搬移，启动器自定位目录
- **开机自启**：LaunchAgent `com.auroraagent.app`（开机自启 + 崩溃自恢复）；登录自启不弹浏览器（`NO_OPEN=1`）
- **卸载服务**：设置页关闭「开机自启」，或 `npm run service:remove`（数据保留）

## 打包与重建

```bash
npm run publish     # 先构建前端（build:web）再打 .app 并重启常驻服务
npm run app:build   # 只构建不重启
```

`app:build` 会**先删除目标 .app 再重建**，因此必须在 Bundle 之外的源码目录执行（脚本内置拒绝保护）。Bundle 内含 React 构建产物（`public/app/`），运行时**不依赖 node_modules**；`web-ui/` 源码与依赖只存在于开发副本。重建后按输出提示把服务重注册到 Bundle 内路径即可。

Bundle 结构：

```
~/Applications/AuroraAgent.app/Contents/
├── MacOS/AuroraAgent        # zsh 启动器（自定位目录，Bundle 可随意搬移）
├── Resources/app/           # 全部后端代码（零依赖，Node 18+）
│   ├── web.mjs              # 网页服务：/api/* 路由 + SSE 代理 + /app/ 静态服务
│   ├── chat.mjs             # 终端客户端入口（可 import：loadConfig / streamChat）
│   ├── check.mjs            # 连通性自检
│   ├── util/
│   │   ├── agent/           # Agent 运行时：loop / session / tools / policy / context / harness / events / http / terminal(+turn/format)
│   │   ├── tui/             # 终端 TUI 工具包：theme / render / printable-key / searchable-list / select / pick / footer / commands
│   │   └── llm/             # LLM 抽象：tool 归一化 + 错误分类
│   │   ├── providers.mjs    # 自定义提供方存储/校验/发现
│   │   ├── wire.mjs         # 协议适配（tools / tool_choice 拼装 + Anthropic 帧翻译）
│   │   ├── stream.mjs       # SSE 透传 / 翻译泵 + Agent 增量读取
│   │   ├── usage.mjs        # 用量账本
│   │   ├── service.mjs      # LaunchAgent 生命周期
│   │   └── config.mjs       # 数据目录回退 + 配置读写（chat/check/web 共用）
│   ├── public/
│   │   ├── app/             # React 工作台构建产物（/app/ 服务，哈希资产长缓存）
│   │   ├── icon.svg         # AuroraAgent 品牌标识（App 图标同款）
│   │   └── vendors/         # 各接入厂商的标识（meituan.svg …）
│   ├── test/                # mock 上游 + 319 个测试
│   └── tools/               # color-test / install-service / build-app
├── Resources/docs/          # figures/（学术图与原始数据）+ figure-work/（图表脚本）
├── AppIcon.icns
└── Info.plist               # com.auroraagent.app · LSUIElement · 版本随 package.json（7.0.0）
```

## 自动发布（GitHub Actions）

仓库接入 `.github/workflows/release.yml`：每次 push 到 `master`（含 PR）先由 GitHub Actions 跑 `npm test`；push 场景测试全绿后，[release-please](https://github.com/googleapis/release-please) 按常规提交信息（`feat` / `fix` 前缀，与仓库历史同规约）自动开或更新一个「发布 PR」——内含版本号提升（只动 `package.json`）与按提交分组的发布说明。合并该发布 PR 即自动打 tag 并创建 GitHub Release，无需手动操作（版本基线锚点为 tag `v7.0.0`；仓库需允许 GitHub Actions 创建 PR，且工作流默认权限为 write）。文档站的发布笔记页仍由本地 `npm run docs:notes` 生成后随仓库提交。

## 自定义提供方（接任意上游）

除内置美团 LongCat 外，设置页「提供方」区可接入任意上游——OpenAI 兼容网关、自建服务、或比内置目录更新更快的厂商，都不用改代码：填 Provider ID / 显示名称 / API 地址 / 协议 / 密钥；模型目录可手写或点「获取可用模型」从上游拉取勾选；单价填了账本按它计价，留空回退内置价。Agent 会话与 `/api/chat` 都按模型所属提供方路由。配了多个提供方且模型目录有交集时，主提供方返回 429 / 5xx / 网络失败后会自动切换到提供同一模型的其它提供方重试（只在连接期切换，鉴权 / 计费类错误不转移，同一轮对话内切换成功后沿用新提供方，用量记账归属真实产出方）——设置页「故障转移」面板可开关与调整尝试次数。细节（密钥不回显、编辑留空保留原值、Anthropic 协议帧翻译等）见设置页内说明与 `AGENTS.md`。

## 文档

完整文档走中英双语文档站（VitePress，仅开发期依赖，后端与运行时零接触）：

```bash
npm run docs:dev    # 本地起文档站
```

- **指南**：快速开始 / Agent Loop / Goal 目标模式 / 网页工作台 / 终端客户端 / 技能 / MCP / 自定义提供方
- **速查**：斜杠命令 / HTTP API / 配置项 / 终端设计规范（对话框与选择器的单一真值源）
- **发布笔记**：`npm run docs:notes` 从 git 历史生成，里程碑段落可手写补充
- **里程碑变更**：根目录 `CHANGELOG.md`（Keep a Changelog 格式，逐提交细节走发布笔记页）

## 当前状态（实测打通）

- `npm test` 347/347 通过（mock 上游，不花额度，含仓库守卫：零 emoji / TUI 颜色单一真值源 / 对比度 / 行数预算 / 文档站结构）；`npm run check` 真实 API 连通（Key 有效 + 模型目录 + 测试请求）
- 性能基准：`npm run bench`（basic 套件：startup / upstream-100 / history-300 三场景，采样 wall / CPU / peak-RSS），方法论与本地基线见 `docs/perf-baseline.md`，只作回归参考不作门禁
- Agent e2e 覆盖：会话 CRUD；完整 turn（工具调用 → 权限允许 → workspace 落盘 → 二轮出终稿）；权限拒绝后循环继续；路径穿越拒绝；shell 执行与超时；turn 中途 abort；harness 列表；上下文压缩触发；每轮用量记账；技能斜杠注入与 skill 工具加载；todo 维护；edit_file diff 回传；计划批准 / 驳回两阶段；首条消息自动总结会话标题（默认名才套用、事件推送、落元信息；local 本地推导与 model 调模型两路，模型失败回退本地、成本记 purpose=title 账）；task 派发子代理并汇总（子会话可查）；MCP 注册与工具调用（实验）；Goal 全链路（create_goal → 提案完成 / 预算触顶转 budget_limited + 收尾轮 / 空转续跑 / evaluator 裁决 met 与 not_met 连击两条路径）；Goal REST 冲突与纪元边界；`/goal` 命令解析单测（预算 K/M 后缀、clear 同义词、旧式空格、edit/clear/help、错误分支）与 edit / clear 动作与 REST e2e（改写 trim、空白 400、无目标 404、已完成 409、clear 幂等）；会话派生逐条一致复制；`@` 提及时文件搜索与 404；终端偏好读写与坏值 400；多提供方故障转移（主提供方 429 自动换路并记账到新提供方、候选耗尽报最后一次真实错误、`/api/chat` 换路、401 不转移、故障转移偏好读写）
- 网页工作台经浏览器实测完整 turn：权限卡允许 → 写文件 → 二轮终稿 → 按轮分组的思考 / 工具 / 用量脚注
- 终端实测：权限 y/n 两条路径、`/help` `/sessions` `/new` `/model` `/harness`、拒绝后续跑均正常；OSC 标题设置 / 清除、`/goal` 家族命令与状态栏目标芯片、`/btw` 侧边对话与 `Ctrl+/` 切换均经 PTY 实测
- 自定义提供方：设置页可接任意 OpenAI 兼容网关或 Anthropic Messages 上游；账本按提供方单价计价（只填一侧时另一侧回退内置价）；内置 LongCat 请求载荷与接入前逐字节一致（有专门测试守着）
- LaunchAgent `com.auroraagent.app`：running / managed，数据目录指向 `~/Library/Application Support/AuroraAgent`
- UI：零 emoji（全 Bundle 代码 `Extended_Pictographic` 零匹配）；动画遵循 `modern-web-guidance`，全局 `prefers-reduced-motion` 降级

## 常见问题

- `401 invalid_api_key`：Key 错或没填，去 `/key` 重新设置
- `402 insufficient_quota`：余额不足
- `429`：请求太频繁；配了多个提供方时会自动切换到提供同模型的其它提供方重试（设置页「故障转移」可调），只有一家时仍稍等重试
- 工具调用被拒绝：权限卡选「总是允许」沉淀为会话规则；或切换 Minimal 模式（无工具）
- 终端乱码：换用 iTerm2 / Terminal.app 均可，已用标准 ANSI 颜色
