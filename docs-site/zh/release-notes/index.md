# 发布笔记

本页由 `tools/gen-release-notes.mjs` 从 git 历史生成（也可手写补充里程碑段落）。

<!-- RELEASE-NOTES:ZH -->

### 新功能

- 流式活动状态行——LiveRow 展示轮次/工具数/走秒计时（>60s 转 m:ss， dots 动画走语义令牌），费用格式化收拢到 projection.fmtCostYen（终端同源 fmtCost，消除第三份重复实现）；LiveTurn 增 round/startedAt 由 model_round_started/turn_started 驱动；附源码契约（`a8ed1af` 2026-09-27）
- 零依赖语法高亮——highlight.ts 线性扫描 tokenizer（js/ts/python/json/sh/sql/go/rust/c 等语言族，拼接恒等无损、未知语言回退纯文本），Markdown 代码块接入；token 色一律走语义令牌；附六组单测（无损性/分类/块注释/大小写不敏感/回退/字符串内含关键字）与源码契约（`51041e5` 2026-09-27）
- 技能界面与斜杠命令同源——服务端 turn 统一解析 /<技能名> 为技能注入（与终端同一规则单点解析）；Composer 输入 / 浮现技能调色板（指针/hint 词汇对齐 docs/tui-design.md，键盘上下选择、Enter/Tab 插入、Esc 取消）；设置弹层增技能目录区（内置/自定义徽标）；附斜杠解析 e2e 与源码契约（`05f359a` 2026-09-27）
- 统一开流入口 openChatStream——/api/chat 与 Agent Loop 共用同一编排（构造请求 + 连接期重试 + 中文错误话术 + 协议帧翻译选择），非 2xx 抛出带 kind/status 的 Error；修复 loop 从未透传 extraTools 导致 MCP 工具 schema 不进请求的 bug（模型此前看不见外部工具）；压缩请求一并切到该入口（顺带修复 Anthropic 线路压缩不翻译帧）；附 MCP schema 进请求的回归断言；真实上游冒烟通过（`b56f6a8` 2026-09-27）
- MCP 管理面板——设置弹层可查看服务器连接状态与工具数、新增 stdio/HTTP 两种传输、测试连接与删除；未开启实验时展示开启指引；附源码契约测试与构建产物（`d903e32` 2026-09-27）
- 注册表与全链路接线——mcp.json 配置（原子落盘、草稿校验、增删）；McpRegistry 连接启用服务器发现工具并包装为 kosong 形状（mcp__<服务器>__<工具>，inputSchema 映射 parameters），单服务器失败不阻塞其他；loop 经 extraTools 进入请求与执行（子代理同享）；policy action 支持 mcp__* 前缀通配且 MCP 工具默认 ask；/api/mcp/servers CRUD + probe 路由（实验门控，未开启 404 并提示）；终端 /mcp 状态命令；policy action 前缀通配附单测（`e599127` 2026-09-27）
- JSON-RPC 2.0 客户端——stdio 传输（spawn + 行分隔 JSON，超时与进程退出在途请求报错）与 HTTP 传输（POST，JSON 或 SSE 流响应复用 SseParser）；initialize 握手 + tools/list + tools/call + callResultText 纯文本拼装（isError 抛 McpError）；附 mock stdio 服务器与三组单测（握手列举 / 调用与错误路径 / HTTP POST）（`41dc2d2` 2026-09-27）
- 子代理两端渲染——Web 工具卡透传 subAgent/subTask 标记（嵌套缩进 + └ 前缀），task 卡内展示子代理清单（任务/轮数/工具数/成败，历史回放可查）；终端子代理工具行一级缩进呈现；附类型与样式（`6b02c42` 2026-09-27）
- task 子代理工具——createSpawner 派发受限子 turn（真实子会话透明可查、继承工作目录与会话权限规则、嵌套深度封顶 2 层、单次上限 4 个、父中止级联）；子代理只透出工具调用与用量事件（subAgent 标记）供两端嵌套渲染，终稿经 task 工具结果聚合回父模型；loop 注入 ctx.spawn；harness standard/ultimate 挂载 task 并引导自含描述；policy 默认放行派发本身；终端标签同步（`acde2cd` 2026-09-27）
- 计划卡 + 权限三档选择器——LiveTurn 增 plan 状态，plan_proposed/approved/rejected 事件驱动 PlanCard（待批准时展示计划全文与批准执行/驳回按钮，decidePlan 经 POST /api/agent/plan 回传并乐观更新）；Composer 增权限三档下拉（始终询问/必要时询问/完全自动，PATCH 落会话 meta）与计划模式开关；附源码契约测试与构建产物（`361211c` 2026-09-27）
- 计划模式与权限三档接线——loop 抽出 runRound/runToolCalls 闭包供计划与执行两阶段共用；计划轮只用只读/检索/待办工具（plan.mjs 白名单单点定义）产出计划，plan_proposed 事件等用户批准，批准后计划作为既定契约注入执行轮，驳回以 finishReason=plan_rejected 收尾；POST /api/agent/plan 决策通道（断开按驳回）；turn 优先级 请求体>会话meta>config 解析 permissionMode/planMode，PATCH 可改；终端 /plan 开关 + 计划展示 y/n + footer 计划段；policy.evaluate 换 effective（三档生效）（`708b152` 2026-09-27）
- 权限三档 permissionMode——always_ask / ask_when_needed / never_ask 叠加在规则集之上设定 ask 类动作默认效应（never_ask 放行 ask 但不推翻 deny，always_ask 把默认规则的只读放行提升为逐次询问但不推翻用户「总是允许」沉淀的会话规则）；grantAlways 打 source 标记不落盘；附单测（`70eb9da` 2026-09-27）
- edit_file diff 视图 + 待办面板——ToolCard 读 extra.diff/extra.todos 结构化负载渲染行级 diff（diff 语义令牌上色）与待办清单；会话级 TodoPanel 吸顶展示进度并随 tool_event 实时刷新；TOOL_META 补 grep/glob/todo/skill 四个新工具；types/projection/App 贯通 extra 数据管道（`25088fc` 2026-09-27）

### 重构

- 转录投影层 transcript.mjs——工具标签/图标键/资源摘要/费用格式化的单一真值源（修复终端与 Web 标签表漂移：Web 缺 task 与 MCP 推导），projectTurns 统一记录分组规则（工具记录不拆散并行调用、新文本开新轮）；终端 terminal-format 与 Web projection/ToolCard/Message 全部改为消费同一份契约；附投影单测与两端同源源码契约；构建产物同步（`7671d3d` 2026-09-27）
- 抽象层落地——消息序列转换抽到 llm/message.mjs（OpenAI ↔ Anthropic turns 纯函数），上游错误话术并入 llm/errors.mjs（单一 QUOTA_WORDING），wire.mjs 收窄为请求构造与帧翻译薄封装；toolSchemas 落实 deferred 过滤（标记工具不进请求顶层 tools[] 以保持字节稳定命中提示缓存，Loop 侧仍可解析执行）；附消息转换与 deferred 单测（`8865515` 2026-09-27）

### 杂项

- 追加 mcp.json——MCP 服务器配置含连接信息，与 providers.json 同级不提交（`4fa473f` 2026-09-27）

### 修复

- web.mjs 委派 /api/mcp 前缀并修正 e2e 测试 URL——MCP 路由此前只挂在 /api/agent 前缀下导致 404，注册表 CRUD 与 Agent turn 工具调用 e2e 全链路覆盖（`4196536` 2026-09-27）

### 测试

- 子代理覆盖——Loop stub 覆盖 task 并行派发聚合（真实子会话落盘、subAgent 标记透出、子代理文本不回显）与嵌套深度封顶（孙代理派发被拒、子/孙两层会话）；mock 增 USE_SWARM 触发词（tasks 双子任务 + 子代理终稿）；e2e 覆盖子会话新建可查、转录含子任务与终稿、聚合输出收尾（`9e0e46d` 2026-09-27）
- 计划模式覆盖——Loop stub 覆盖批准进执行（计划轮只读工具集 + 执行轮注入已批准计划 + 计划提示只在计划轮）与驳回不执行（finishReason=plan_rejected 且不再请求上游）；e2e 覆盖 plan_proposed/plan_approved/plan_rejected 事件链、计划轮 tools 只读断言、批准注入落转录、无等待计划请求 ok:false；mock 增 USE_PLAN 触发词（计划轮只回计划文本，批准后执行轮回终稿）（`3591b31` 2026-09-27）

<!-- /RELEASE-NOTES:ZH -->