# 发布笔记

本页由 `tools/gen-release-notes.mjs` 从 git 历史生成（也可手写补充里程碑段落）。

<!-- RELEASE-NOTES:ZH -->

### 文档

- 宪法沉淀两条工作规约并修正测试基数（`5708b77` 2026-09-30）
- 队列 / 定时任务 / 屏幕操作三指南去除外部项目引用（`f988829` 2026-09-30）
- README 去除外部项目引用与过时测试数（`58e7ed4` 2026-09-30）
- 消息队列 / 定时任务 / 屏幕操作三指南与 README、发布笔记生成器修复（`616cea2` 2026-09-30）
- 架构地图登记 API 边界归一化三模块并沉淀版本错配教训（`2f2d108` 2026-09-29）
- 发布笔记同步 v7.3.2（npm run docs:notes 生成）（`80d181b` 2026-09-29）
- 常规提交直接落地并推送 master，不必逐次询问用户（`e3f91fd` 2026-09-29）
- README Bundle 结构里 test 目录测试计数 319 同步为 409（`7c08d29` 2026-09-29）
- README 版本标注同步 7.2.0——随发布 PR 进 tag，避免合并提交上守卫红、release job 被跳过（`d22142e` 2026-09-28）
- 提交主题分隔冒号改用半角——release-please 解析前提，另同步测试基线 381→395（`d3d67a1` 2026-09-28）
- 同步 Header 丰富化与顶部浮层的规约、指南与术语（`8504293` 2026-09-28）
- AGENTS.md 补记历史消息行延迟渲染与文档站新规范页入口（`0dec1dc` 2026-09-28）
- 网页设计规范与术语文案规约入文档站——提炼为实现纪律，中英镜像并注册侧栏（`4f65e14` 2026-09-28）
- 修正 AGENTS.md 验证基线测试计数 358→359（`3594d43` 2026-09-28）
- 同步多提供方故障转移文档——文档站提供方指南（中英）新增故障转移一节、配置速查补 providerFailover 字段与环境变量、HTTP API 速查补 /api/settings/failover、Agent Loop 指南事件清单补 provider_switched；README 自定义提供方段与 429 FAQ 说明新行为并修正测试基数；AGENTS.md 架构地图 / 配置字段 / 基线 334→345 同步（`9b02ba3` 2026-09-28）
- 补自动发布流水线运行细节——v7.0.0 版本基线锚点、仓库须允许 Actions 建 PR 且默认权限 write、CI 补 zsh 与 Node 24 前提；基线 319/319（`98a5a40` 2026-09-28）
- 「小改动快提交勤推送」从第一铁律降为普通规则——移至文末第 11 节与其余各节平行，硬红线归反模式节统一收口；章节顺次重编号并同步交叉引用；顺手修正基线 316→318 与远端可见性 public（`0295447` 2026-09-28）
- 跨客户端 goal 事件流补文档——http-api 中英参考补 GET /api/agent/events（SSE 扇出语义、订阅即写注释帧、关闭退订、404 边界）；AGENTS.md 架构表 goal 目录补 bus.mjs 进程内事件总线、events.mjs 四类→五类 goal 事件（含 goal_cleared）、http.mjs 补 events 路由；README REST 表同步该路由并说明横幅实时同步；Gap 5 浏览器复验（远程 clear/create/pause 三路 SSE 实时校正横幅）随本轮完成（`8ea8688` 2026-09-28）
- 测试基线 299 → 316——goal 系列提交（15f1ac3..df2e7a2）累计 +16 用例与 1 用例（transcript 同 id 多调用回填），第 0/8/10 节三处基线数字同步实际跑分（`3672a7a` 2026-09-27）
- 测试基线同步 299/299（新增 subagent not_met missing 透出单测）（`f537e1b` 2026-09-27）
- 测试基线同步 298/298（`124121d` 2026-09-27）
- goal edit 路由补随文 tokenBudget 与纪元门说明（中英对应）——可带预算一并改写，需新鲜快照，不符 409 GOAL_STALE；纯文本改写不受门限（`0d6df43` 2026-09-27）
- /goal 命令家族文档同步（中英一一对应）——goal-mode 指南用户面操作节重写为完整命令面（设立/改写/budget= 首尾与旧式空格/edit 回填/clear 移除/pause/resume/stop/help）+ 网页 Composer 拦截语义与 GoalBanner 富化说明；commands 参考页补 /goal 家族与 edit/clear；http-api 参考页补 edit（空白 400/已完成 409）与 clear（幂等）两路由；web-ui 指南输入区与目标横幅两条目同步；README 目标横幅条目、/goal 命令表行、REST 表与 e2e 覆盖清单更新；AGENTS.md 架构表补 command.mjs 单一事实源、测试基线改 296（`75d7c6c` 2026-09-27）
- 7.0.0 归档——README 补 goal 模式 / 会话派生 / @ 提及 / 终端偏好 / 新路由与 goals 数据位、AGENTS.md 架构表补 goal 十模块与 tui 四新模块与 mock 触发词、CHANGELOG 记目标模式升级全貌、版本升 7.0.0（仅 package.json）、发布笔记经 docs:notes 生成；测试基线 266/266（P6c）（`86e2276` 2026-09-27）
- 速查页同步新能力——config 补 goal 段十一项与 tui 段四项字段表、http-api 补会话派生 / goal REST 四面 / 文件搜索 / 终端偏好读写、commands 补 /goal /btw 与 goal 三工具与 bench 脚本、tui-design 补 OSC 标题 / 系统通知 / footer 目标芯片三节规范（中英一一对应）（P6b）（`9300065` 2026-09-27）
- goal 模式指南中英双页——三方权限 / 六态状态机 / 三工具与 CAS / 预算与双熔断 / 验证三档 / 轮内续跑 / 用户面操作与 goal 段配置字段表；侧栏导航双语言同步收录（P6a）（`c3afb3c` 2026-09-27）
- 补交四项热点优化的基准报告——stream 背压 / tools 缓存 / 投影缓存 / 静态 304 的优化后 JSON 与 Markdown（docs/perf-baseline.md 优化轨迹的数据来源）（`fc52f48` 2026-09-27）
- 性能方法论与优化轨迹 docs/perf-baseline.md——三场景基准方法、6.0.0 基线数字、四项热点优化前后对比，并记录内置 fetch 已默认连接复用故不加 Agent 的结论（`14532c8` 2026-09-27）
- 标题生成方式（本地总结 / 模型总结）写入 README / AGENTS.md / 文档站中英页——架构表补 title-model.mjs 与 titleMode 配置项、mock 标题轮触发约定、输入区选择器与终端 /title 命令、turn 接口 titleMode 解析顺序；测试基线升至 213/213（`4e84718` 2026-09-27）
- 会话标题自动总结写入 README / AGENTS.md / 文档站中英页——架构表补 title.mjs 与 session_renamed、默认名收敛为 DEFAULT_SESSION_NAME、测试基线升至 206/206（`d5011cd` 2026-09-27）
- 新增 CHANGELOG.md——6.0.0 里程碑（TUI 规范化/技能/子代理/MCP/权限三档/计划模式/Web 一致性/双语文档站）与 5.0.0 更名背景，README 文档节补指针（`4ecbf86` 2026-09-27）
- 6.0.0 能力面同步——工具表扩到十一个、权限三档与计划模式、终端 /plan /mcp 与技能派生命令、skills/plan/mcp 接口表、当前状态刷新 192/192 与 e2e 覆盖清单（`cd33288` 2026-09-27）
- 6.0.0 能力面归档——架构表补 skills/plan/swarm/transcript/mcp 与 llm 开流入口、工具表扩到十一个、权限三档与计划/执行两阶段、实验开关与数据目录新约定、测试基线 192/192（`939851d` 2026-09-27）
- VitePress 双语文档站——指南/速查/发布笔记三结构，终端设计规范迁入站点作单一真值源，写作规约与 git 历史发布笔记生成；修复发布笔记注入幂等性（原正则不消费闭合标记导致每次生成重复追加），补文档站结构契约守卫（中英页面一一对应/标记在场/依赖例外登记）（`72d26ae` 2026-09-27）
- AGENTS.md / README 删掉「新增 npm 依赖需经用户同意」相关规约——用户不想要额外条框；只保留事实性描述（前端依赖仅限 web-ui/、后端零依赖）（`6cd81b5` 2026-09-26）
- AGENTS.md 撤掉我自作主张加的两条规约（公式分段测试方式与 KaTeX emoji 踩坑记录）——用户不想要额外条框；只留事实性更新（测试基线 102、katex 依赖例外、两个新文件的架构表行）（`66e84be` 2026-09-26）
- README 移除对使用者无用的内容——AI 编码 agent 规约引用行与 Computer Use（CUA）内部调试结论章（旧前端时期的方法论记录，含被策略阻断的状态备注）；面向使用者的文档只保留产品能力、接口、数据与实测结论（`30364ce` 2026-09-26）
- README 与 AGENTS 全面更名 AuroraAgent——env/数据目录/config 文件名/LaunchAgent label/.app 名/日志名同步更新，Bundle 结构树与命令表现状同步；补记 5.0.0 一次性迁移说明（旧数据目录整体搬迁含 Key 保留、旧 label 自动清理）与配置收敛到 util/config.mjs 后的单一实现约定（`a492bb8` 2026-09-26）
- README 重写为 AuroraAgent Agent 运行时定位（Loop/工具/权限/压缩/三档模式/双端接口/打包管线），保留速测底座与纯色/CUA 历史结论并更新为实测状态；AGENTS.md 同步架构图（util/agent/* 与 web-ui）、命令（dev:web/build:web）、测试基线 92/92、mock 触发词、前端依赖例外与品牌注释教训；版本升至 5.0.0（Info.plist 与 /api/settings 同源读取）（`497d990` 2026-09-26）
- README 同步输入区改版——模型选择器入口改述为输入区工具栏，补充统一输入卡片与 IME 防护说明（`1718082` 2026-09-26）
- 同步自定义提供方功能——README 补提供方专节/接口表/ Bundle 清单，AGENTS.md 更新架构表与测试基线 56/56（`b697e4f` 2026-09-26）
- README 开头新增 AGENTS.md 指引指针，移除文末埋没的重复行（`a016247` 2026-09-26）
- 新增 AGENTS.md 项目宪法——第一铁律为通过测试的小改动必须主动 commit & push（`b737bd6` 2026-09-26）

### 杂项

- Merge pull request #7 from AuroraAeon/release-please--branches--master--components--auroraagent（`5eb9a67` 2026-09-30）
- release 7.4.0（`9b855a0` 2026-09-30）
- Merge pull request #6 from AuroraAeon/release-please--branches--master--components--auroraagent（`2ac62ec` 2026-09-29）
- release 7.3.2（`10de3c9` 2026-09-29）
- Merge pull request #5 from AuroraAeon/release-please--branches--master--components--auroraagent（`140466b` 2026-09-29）
- release 7.3.1（`c72594b` 2026-09-29）
- Merge pull request #3 from AuroraAeon/release-please--branches--master--components--auroraagent（`436dc97` 2026-09-29）
- release 7.3.0（`c26016f` 2026-09-29）
- 删除 docs 下重复的原始数据文件（`4035cc4` 2026-09-29）
- Merge pull request #2 from AuroraAeon/release-please--branches--master--components--auroraagent（`d0c0ad5` 2026-09-28）
- release 7.2.0（`fb53ac3` 2026-09-28）
- 质量门禁——文档新鲜度与架构地图覆盖入守卫，typecheck:web 脚本落地（门禁模式落地）（`28d7867` 2026-09-28）
- Merge pull request #1 from AuroraAeon/release-please--branches--master--components--auroraagent（`fd65a6e` 2026-09-28）
- release 7.1.0（`d79ea75` 2026-09-28）
- 追加 mcp.json——MCP 服务器配置含连接信息，与 providers.json 同级不提交（`4fa473f` 2026-09-27）
- 新增 React+Vite+TS 脚手架与构建管线——npm run dev:web 开发态代理 /api，npm run build:web 产出 public/app 由 web.mjs 以 /app/ 服务（哈希资产长缓存 + SPA 回退 + 防目录穿越）；前端依赖经用户同意引入为零依赖铁律唯一例外；构建产物随仓库提交保证运行时零构建；web.mjs 清理死代码 QUOTA_WORDING（`e0a5b97` 2026-09-26）
- test+docs: 提供方界面关键结构断言（容量折叠/aria 同步/弹层说明/无地址禁用）；README 与 AGENTS.md 同步密钥格式规则、默认全选、必填反馈与测试基线 59/59（`db2c4a7` 2026-09-26）
- ModelTester 4.0.0：品牌重塑与独立化（`2f2a037` 2026-09-26）

### 新功能

- 定时任务与屏幕操作——cron 工具 / jobs 调度 / computer_use 截图（#3149 / #3191 本地化）（`b55b9ea` 2026-09-30）
- 消息队列——活跃 turn 期间提交自动排队，前一条结算后由泵接力（`47cc839` 2026-09-29）
- 提供方预设目录——14 家厂商端点与模型 ID 一键预填（`875455c` 2026-09-29）
- 消息行改无头像形态——用户消息靠右铺列、思考过程改紧缩行（`417bb80` 2026-09-29）
- 工具调用改紧缩摘要行，加号菜单删说明项（`a25f950` 2026-09-29）
- 技能系统引入 Agent Skills 三层渐进式披露——L3 附属资源、只读白名单根与目录预算治理（`a4be825` 2026-09-29）
- 浮层箭头改后退/前进会话导航，输入区改紧凑排版并加添加上下文菜单，侧栏会话行运行态加载圈（`0b5bda3` 2026-09-28）
- 移植故障转移机制——跨请求熔断 / 2xx 语义失败 / 超时三件套 / 队列与热切换（`dd8b8b6` 2026-09-28）
- 故障转移「最多尝试」改用分段选择器，设置行按外观页规格（`af5d7ce` 2026-09-28）
- 外观页全量补选项，空新会话禁止再新建（`894e253` 2026-09-28）
- 侧栏新建任务钮与外观主题下拉，帮助钮补气泡（`d33155a` 2026-09-28）
- Header 补丰富形态并加顶部浮层（`d8ce873` 2026-09-28）
- ControlTooltip 扩展富内容卡与受控模式——工作区上下文卡载体（`93bd814` 2026-09-28）
- 新增零依赖下拉菜单 Menu——补齐交互与视觉（`b75ea08` 2026-09-28）
- 新增工作区上下文端点 GET /api/workspace——Header 工作区卡片数据源（`fc6623f` 2026-09-28）
- 侧栏收回改真实语义——左边整体消失只留 Header，加 200ms 擦除动画（`09d0ace` 2026-09-28）
- 对话区左缘离散「梯状」历史悬浮导航（`4ea1f12` 2026-09-28）
- 分区错误边界——侧栏与主列局部崩溃降级为兜底卡，scope 归因落日志、切换会话自动恢复（`0764f68` 2026-09-28）
- 错误日志脱敏——密钥 / Token / URL 凭据写入前清洗，先清洗后截断且幂等（`f6317c9` 2026-09-28）
- 侧栏折叠导轨像素级打磨——单按钮静止显品牌砖、悬停淡入面板图标与快捷键提示，Cmd/Ctrl+B 同效（`87a9124` 2026-09-28）
- 侧栏像素级打磨——280px 栏体、56px 折叠导轨、36px 区头搜索、32px 会话行（`0714cdd` 2026-09-28）
- 斜杠命令菜单替换技能调色板——16 条命令实时过滤、两档回车、合法命令色彩语义，计划开关并入 /plan（`5c7729b` 2026-09-28）
- MCP 服务器显示开关——停用即从工具箱摘掉工具，配置保留（`ab5858d` 2026-09-28）
- 侧边对话界面——消息分流、侧边横幅、Ctrl+/ 切换，turn 事件处理器抽为共享模块（`3f81361` 2026-09-28）
- 网页接入侧边对话——turn 支持 side、SideSession 进程内托管、侧边转录查询与丢弃（`ace6361` 2026-09-28）
- 新增生成参数与 API Key 端点，设置页通用面板可改温度 / 最大输出 / Key（`9ab1688` 2026-09-28）
- 四项设计调整——目标条替代半透明遮罩、模型选择器二级思考强度、设置弹层分级导航、切换格式不重排输入区（`bbed19d` 2026-09-28）
- 故障转移全链路可感知——新增 provider_switched 事件在网页落提示条、终端打单行（切换原因中文映射），设置页新增故障转移面板（开关 + 最多尝试次数，走 /api/settings/failover）；mock 支持按 Key 返回 429/503，e2e 覆盖 Agent turn 换路记账、候选耗尽报真实错误、速测通道换路、401 不转移与设置读写，补源码契约（`4976116` 2026-09-28）
- 接入多提供方故障转移编排——openChatStream 在流尚未打开时对 429/408/5xx/网络错误换到提供同模型的其它提供方重试（次数钳 1..5、切换前线性退避、已发出字节后不透明换路）；Loop 内粘性（activeProvider 后续轮次沿用，单价与记账归属真实产出方，自定义提供方按目标方口径拼 gen 参数），子代理经派发继承候选源，/api/chat 同步接入并随切换改记账归属；新增 provider_switched 事件（`1b56f6f` 2026-09-28）
- 新增多提供方故障转移模块——可转移判定（429/408/5xx/网络，中止与鉴权类不转移）、候选挑选（同模型 / 有 Key / 排除已试）、线性退避与配置解析（providerFailover 缺省开 + maxAttempts 钳 1..5，env 可覆盖），并接入 config 读写与 /api/settings/failover；对应上游「自动轮换账号」的本地化底座，编排层随后接入（`58dd123` 2026-09-28）
- 首屏会话骨架屏——列表未回时显示三条微光骨架并标 aria-busy，不再把「加载中」显示成「还没有会话」；动画尊重系统减少动效设置（`058f591` 2026-09-28）
- 版本检查与对话区跟手 / 渲染性能——新增 util/update.mjs 查 GitHub Releases latest 比对本地版本（三段语义、6 小时缓存、失败不缓存不抛错），GET /api/update/check 与设置页「检查更新」入口（只提示不自动安装）；ChatView 改为贴底才跟随滚动并给出「回到最新」按钮，上翻读历史不再被抢滚动；历史消息 memo（流式掉帧主因是整段历史被反复重渲染）；补 Ctrl/Cmd+K 新建会话与 / 聚焦输入框快捷键；刻意不用 content-visibility 以免占位尺寸让自动贴底落点偏移（原因写进注释）（`b024555` 2026-09-28）
- 双主题与用量 / 错误日志面板——tokens.css 增加浅色主题整套同名变量覆盖（data-theme 由 index.html 首帧脚本预置防闪，theme.ts 管运行期切换与跟随系统），浮层阴影改走令牌；util/usage.mjs 增 stats() 统计视图（近 30 天逐日补零 + 按模型 / 提供方 / 用途 / 会话构成），/api/usage 默认带 stats、?lite=1 只取汇总；设置弹层新增用量面板（零依赖 SVG 堆叠柱 + 占比条 + 最近请求表）与错误日志面板（查看 / 清空 logs/errors.log）；补单测、e2e 与源码契约（`b1e3a35` 2026-09-28）
- 新增零依赖通知与前端错误上报——toast.tsx 右下角视口（四级语义、悬停暂停计时、同屏 4 条、同文案 3 秒合并计数、aria-live 播报），操作类失败从错误横幅改走通知；error-report.ts 收口 window error 与 unhandledrejection 上报 /api/logs/errors（30 秒去重）；error-boundary.tsx 渲染期崩溃改白屏为可重载 / 可复制详情的兜底页；补源码契约断言与构建产物（`c9576ac` 2026-09-28）
- 新增错误日志——前端崩溃与未捕获错误落盘 <数据目录>/logs/errors.log（JSON Lines 环形保留 200 行、kind 白名单、detail 截断 4KB、写失败静默），POST/GET/DELETE /api/logs/errors 三面供上报与查看，同 kind+message 30 秒去重防崩溃循环刷屏；顺带把 goals/ 与 logs/ 补进 .gitignore，并修正 AGENTS.md 测试基线漂移（318→323）（`b0370c0` 2026-09-28）
- 网页订阅跨客户端 goal 事件流并按 goal_cleared 清横幅——Gap 5 客户端半边：新增 web-ui/src/goal-events.ts（EventSource 订阅 /api/agent/events?sessionId=，五类 goal 事件监听 + 会话归属双保险 + 返回关闭函数）；App.tsx 按 currentId 接线（切会话 / 卸载即关闭，goal_cleared → setGoal(null)，其余按服务端快照整体覆写）；types.ts 的 AgentEvent 联合补 goal_cleared（与 util/agent/events.mjs 白名单一致）；源码契约断言 3 条（模块订阅面 / App 接线 / 会话归属校验）；构建产物同步；基线 318/318（`073c433` 2026-09-28）
- REST 目标变更经进程内事件总线扇出给同会话 SSE 订阅方——补上「另一客户端刚改过目标、本地横幅陈旧」的缺口：新增 util/agent/goal/bus.mjs（零依赖订阅 / 发布 / 退订，按 sessionId 过滤，单订阅写失败与未知事件类型都不拖垮 REST 调用方）；events.mjs 登记 goal_cleared；http.mjs 新增 GET /api/agent/events?sessionId=（订阅即写 SSE 注释冲掉响应头，否则无事件时客户端 fetch 永远等不到 headers；连接关闭无条件退订防泄漏；未知会话 404），create/edit/clear/pause·resume·stop/budget 六类 REST 变更分别发布 goal_created / goal_status_changed（与 runtime.emitStatus 同载荷形状）/ goal_cleared（幂等 clear 不发布）；turn 内 goal 事件仍走 turn SSE 不经总线；单测 8 项断言（扇出 / 会话过滤 / 退订回收 / 坏订阅隔离 / 未知类型丢弃 / goal_cleared 白名单与帧形状）+ e2e 一条（真实 socket 订阅流按序收到 goal_created → goal_status_changed → goal_cleared，幂等 clear 不产生多余帧，404 边界）；基线 318/318（`d2a98ee` 2026-09-28）
- 无会话时 /goal <目标> 先自动建会话再设立——先尝试自动建会话，仍失败才给可操作提示；Aurora 原先无会话一律 push 提示 + retained，用户想直接开目标时必须手动新建会话；改为 create 意图先 createSession + await openSession（等消息投影落地，目标回执不被冲掉；手动同步 currentIdRef 供 stale() 判定，setCurrentId 渲染尚未落地），其余意图维持直接告警；自动建会话失败给可操作提示并 retained；源码契约断言 3 条；构建产物同步；基线 316/316（`6bbd542` 2026-09-28）
- /goal 运行中可管理目标 + 三处防串会话防护——逐文件审计 WebChat 聊天框 goal 面后补三处真缺口：① busy 放行：此前 Composer.submit 被 busy 整体拦截，生成中无法抬高预算防触顶 / 暂停续跑 / 改写目标文本，而目录命令在 turn 运行中直接分派、Aurora 服务端本就支持运行中 goal REST（【目标已更新】与预算重武装均为在飞场景设计）——改为 /goal 家族命令优先于 busy 门控直走 REST（与 turn 单活门控互不阻塞），composer 提示补一行告知；② 无会话保留草稿：无会话时也原样回填便于会话就绪后重发；③ 防串会话三处：补齐 project() 首行 sessionId 校验——网页 busy 时可切换 / 新建 / 删除会话，此前 goal REST 回调、openSession 的 getGoal、SSE 四类 goal 事件均无会话归属校验，旧会话的目标状态与通知会落到新会话界面；改为回调捕获发起时会话 + 纪元（stale 守卫）、openSession 慢响应凭纪元丢弃、SSE goal 事件校验 sessionId；源码契约断言 7 条（ busy 放行顺序 / 提示文案 / SSE 校验 / stale 守卫计数 / 纪元丢弃 / 无会话回填）；docs-site 中英指南与命令参考同步、AGENTS.md 能力面补述；构建产物同步；基线 316/316（`5b54981` 2026-09-27）
- 活跃目标在每次用户轮首轮重述 + 每 5 轮状态审计——此前续跑提醒只在 turn 内空转轮注入，跨轮场景（用户隔天发新消息、上下文压缩已把 create_goal 挤出窗口）里模型完全不知道有进行中目标，目标只剩工具描述里的一行提示；现在 beginTurn 对 active 目标返回轮首重述（`<objective>` XML 包裹 + 「回应本轮消息同时用工具推进」），loop 把它播种到执行阶段首轮；turnsUsed>0 且 %5===0 时附带例行状态审计段（对照证据重估 complete/blocked，禁止心跳式 update_goal，例行审计）；上轮被中止后的恢复核对由无差别重述覆盖，不追加剧中止历史；单测 3 例（重述渲染与审计边界 0/4/5/10、beginTurn 对 active/暂停/无目标的返回）+ e2e 1 例（REST 预建目标后新 turn，断言上游请求带【进行中的目标】与目标文本、见到重述才调 read_file、续跑后结算 complete(worker_proposal)）；docs-site 中英同步；基线 313/313（`194d34f` 2026-09-27）
- turn 内改写目标文本——在飞模型下一轮收到【目标已更新】——此前经网页 /goal edit 或 REST 改写目标文本只落盘，在飞 turn 的模型整个 turn 都盯着旧目标工作，『回答了没人再问的问题』；现在 beginTurn / create_goal 定格目标文本，afterRound（工具轮）与 decideNext（空转轮）检出失配即返回 'updated'：经 consumeNote 把【目标已更新】提醒注入下一轮——新目标按不可信数据包裹（`<untrusted_objective>` XML 转义）并附预算快照（已用/上限/剩余，无预算记 unlimited），提示调整方向、停止只服务旧目标的工作、不借此提案完成；针对旧目标的待定终态提案同时作废（修复旧完成提案把新目标标记完成的缺陷）；目标不在管辖（暂停）时不触发；loop 接线一行；单测 4 例（提醒渲染/工具轮检出且只一次/空转轮+提案作废/非管辖不触发）+ e2e 1 例（mock 同步代打 REST edit，断言上游请求体带【目标已更新】与新目标包裹、按新目标结算 complete(worker_proposal)）；docs-site 中英同步；基线 310/310（`15080c1` 2026-09-27）
- WebChat 聊天框 /goal 交互三处收紧——① 操作失败保留用户输入（retained 语义）：create/edit/budget/clear/动作失败时把原命令经 goalPrefill 回填，onlyIfEmpty 保证只补空输入框、不覆盖失败等待期间新敲的内容，错误提示注明「输入已保留，可修改后重发」（此前失败即丢草稿，长目标文本尤其受伤）；② 无会话时给出明确提示而非静默无操作；③ /goal edit 回填后补操作提示「编辑目标文本后按 Enter 提交（budget=50K 可随文调整预算）」；Composer prefill 支持 onlyIfEmpty 语义；契约断言同步；构建产物同步，基线 304/304（`6bca0bc` 2026-09-27）
- GoalBanner 补 usage_limited 恢复提示——横幅在用量受限态显示『等待提供方访问（配额 / 限流）恢复后点恢复或 /goal resume 继续』（与既有 budget_limited 提示行并列）；源码契约断言同步；构建产物同步，基线 299/299（`6a7e9d6` 2026-09-27）
- 横幅等待标签 / 完成隐藏 / not_met 缺口清单三处调整——① GoalBanner 对 complete 返回 null（横幅隐藏，完成回执由 notice 消息承载）；② active 且有 executionWait 时状态芯片改用等待标签替换「进行中」（配色保留状态色）；③ evaluator/subagent 提示词与 parseVerdict 增补 missing 缺口清单解析（每条截断 1000 字符、上限 50 条），runtime 透出到 lastVerification，continuation 反馈提醒带前 5 条缺口，GoalBanner 与终端 formatGoalSummary 同源展示前 2 条 +N；源码契约断言与 parseVerdict/反馈/摘要/subagent 续跑单测同步，构建产物同步，基线 299/299（`ffd3734` 2026-09-27）
- /goal clear 支持 cancel / delete 同义别名——clear/cancel/delete 三分支等价，模型与用户零学习成本；GOAL_COMMAND_HELP 与命令清单注明别名；解析器单测补别名、大小写不敏感与「不接受参数」分支；commands / goal-mode / README 中英同步（`5a07f31` 2026-09-27）
- 网页 Composer 接入 /goal 命令家族——submit 拦截 /^\/goal(\s|$)/ 交 App 走共享解析器（command.mjs 单一事实源，与终端 REPL 同语义）；handleGoalCommand 按意图分派：view/help/error 走系统消息、create 有未完成目标时自动转 edit（服务端创建的 409 由客户端预先规避）、budget 带 CAS 三参、clear 幂等移除并清空横幅、edit 经 goalPrefill nonce 回填输入框续编；goal 转 complete 时按 goalId 迁移贴 formatGoalReceipt 回执；api.ts 补 createGoal/editGoal/clearGoal 与 goalAction 的 budget/edit 扩展；GoalBanner 富化——turnsUsed、live elapsed（active 且无 executionWait 时 1s 插值、新快照重置偏移）、最近验证结论行（中文裁决标签 + not_met 连击）、随状态动作提示（goalActionHint 同源）、完成回执；源码契约测试同步扩充，构建产物已同步，基线 296/296（`22489bc` 2026-09-27）
- /goal 命令家族落地——终端与网页 Composer 共用共享解析器（command.mjs 单一事实源：查看/创建/budget= 首尾抽取/旧式空格/clear/edit/pause/resume/stop/help，K·M 后缀与 clear 同义词、CJK 边界、double 检测、动作大小写不敏感）；actions.mjs 新增 setUserGoalObjective（create-or-edit，随文携带预算走重新武装）与 clearUserGoal（幂等移除）、edit 动作（空白 400 GOAL_BAD_OBJECTIVE / 已完成 409）；REST 面 edit 与 clear 接线（clear 不受无目标 404 门限制回 cleared 标记）；终端 cmdGoal 改用 parseGoalCommand 并支持 edit 回填续编与 help 输出；测试补解析器单测、edit/clear 动作单测与 REST e2e（改写 trim / 空白 400 / 无目标 404 / 已完成 409 / clear 幂等），基线 296/296（`4f9cffa` 2026-09-27）
- web_fetch 支持本机代理——util/proxy.mjs 零依赖实现（parseAgentProxy 归一化校验 / http 走正向代理绝对 URI / https 走 CONNECT 隧道 + TLS / 重定向与中文 URL 处理 / 错误中文化），配置新增 agentProxy 段（saveConfig 保留未感知调用方的现值），loop / 子代理 / HTTP 面 / 终端透传 ctx.proxy，GET/POST /api/settings/proxy 路由 + 设置页网络面板（ProxyPanel + proxy-input 客户端预校验）；维基百科类直连被重置的站点可经 http://127.0.0.1:7890 出站，保存即时生效（`2084d04` 2026-09-27）
- Markdown 表格渲染——md-table.mjs 纯函数解析 GFM 子集（表头/分隔行/补宽/数据行，列数不匹配与裸 --- 不成表），markdown.tsx 渲染 thead/tbody 走同行内渲染，app.css 滚动包裹层不撑破气泡，test/markdown.mjs 九个用例入库（`185d088` 2026-09-27）
- 终端偏好经服务端配置——GET/POST /api/settings/tui（util/tui/settings-api.mjs 单叶校验 + 局部合并 + 坏值 400，web.mjs 只留委派），设置页新增 TuiPanel：OSC 标题项序开关、系统通知 when/method/events 三档、浏览器 Notification opt-in 开关（默认关，turn 完成/失败时弹出）；终端启动时读取一次，下一次启动生效（P5c）（`16d57d5` 2026-09-27）
- 会话派生——POST /api/agent/sessions/:id/fork 复制 meta 与全部转录到新会话（新 id / 新时间戳 / 名字加副本后缀），goal 按会话隔离不随复制，源会话只读不动；侧栏加派生入口（复用 IconCopy 与 sess-del 悬停范式）（P5b）（`28402ea` 2026-09-27）
- Composer @ 提及只读文件搜索——GET /api/files/search 经 resolveInside 路径禁锢仅列会话工作目录文件（跳过依赖目录），MentionPalette 调色板复用 SkillPalette 交互范式（150ms 防抖 + 键盘导航），前端走 api.ts 不直连路径（P5a）（`b7500d3` 2026-09-27）
- /btw 侧边对话——继承主会话自洽历史前缀（无悬空工具调用的最后边界，中断轮次残骸整组剔除）开聊，内存门面不落盘不进 /sessions、不接管 goal、不派发子代理；Ctrl+/ 经预挂 data 监听无污染切换（实测验证），侧边空提示符 Ctrl+C 丢弃，主存储零污染（P4d）（`1a81f36` 2026-09-27）
- 系统通知三通道——OSC9 / OSC777 / bel 按 tui.notifications 的 when/method/events 择一发送，unfocused 经 osascript 200ms 超时尽力探测焦点（失败按未聚焦，宁可多响不漏响）；完成/失败/授权/提问四类事件在终端渲染器接线（P4c）（`ab4e879` 2026-09-27）
- OSC 终端标题——状态 | 会话名 | AuroraAgent 按 tui.terminalTitle 项序拼装，会话切换/生成态/侧边模式实时重设，退出统一清空；挂起经不可捕获的 SIGSTOP 真正停下（Node 会拦截 SIGTSTP 重发导致假挂起），SIGCONT 恢复重设（P4b）（`80b4c14` 2026-09-27）
- tui 配置段——terminalTitle 项序与 notifications 三档（when/method/events）解析落 util/tui/config.mjs，单叶损坏独立回退+告警，util/config.mjs 只做委派；空数组=显式关闭不告警（P4a）（`848b0c8` 2026-09-27）
- 网页端目标横幅 GoalBanner——状态芯片/用量/预算/暂停恢复停止（动作按状态裁剪与后端同语义），四类 goal 事件进 App 状态编排，api 接线 goal 读与动作，构建产物同步（P3c）（`fe15572` 2026-09-27）
- 用户面目标操作单一事实源 actions.mjs（REST/终端共用）——/goal 家族命令、状态栏目标芯片、三类 goal 事件终端呈现；修复 GoalStore 纪元不推进导致 CAS 形同虚设（P3b）（`8224125` 2026-09-27）
- Goal REST 面——一会话一目标的创建/查询/暂停/恢复/停止/预算调整，用户操作纪元 CAS（expectedUpdatedAt 不符 409 GOAL_STALE）与状态冲突 409 语义，附 e2e（P3a）（`8ea9105` 2026-09-27）
- goal 验证与自动续跑——evaluator/subagent 双档裁决、轮内续跑、预算收尾轮、executionWait（P2）（`7eb8c02` 2026-09-27）
- goal 模式核心——六态状态机/原子存储/create_goal·update_goal·get_goal 工具/三维预算/双熔断（P1）（`003d174` 2026-09-27）
- 新增零依赖性能基准设施 tools/perf/——三场景（startup / upstream-100 / history-300）各起独立 mock + web.mjs 进程对，采样 wall / CPU / peak-RSS，落 JSON + Markdown 报告；接入 bench / bench:smoke / bench:full 脚本并记录 6.0.0 优化前基线（`e3311b9` 2026-09-27）
- 输入区新增标题生成方式选择器——本地总结 / 模型总结会话级切换（PATCH 落 meta，与终端 /title 同源），含 SVG 图标、类型与 api 接线、源码契约；构建产物同步（`2070bce` 2026-09-27）
- /title local|model 切换标题生成方式（无参查看当前值）——新建会话继承当前选择、状态栏在模型总结模式给可选段、footerState 透传；附 footer 单测与终端接线源码契约（`9b50110` 2026-09-27）
- 标题生成方式 model 落地——一次小额上游请求总结标题（无工具 / 低温 / 64 token 上限 / 参考终稿），失败回退本地推导，成本照实记账本与会话汇总（purpose=title，不进转录与轮次脚注）；标题清洗器增补引号壳 / 标题前缀 / 结尾句读以兼容模型输出；session_renamed 带 mode 供两端措辞；附 Loop 四例与 e2e 全链路（`6cf0d50` 2026-09-27）
- 标题生成方式进入会话面——create 继承全局 titleMode、PATCH 可热切换（非法值 400）、turn 按请求体 > 会话 meta > 全局配置解析并透传 Loop；附 PATCH 回归（`8b4723b` 2026-09-27）
- 标题生成方式配置项 titleMode（local 本地推导缺省 / model 模型总结）——load/save 同权限三档规约，非法值回退缺省；附 round-trip 单测（`8f66884` 2026-09-27）
- 首条消息总结出标题后打印一行提示——终端与网页同样可见标题更新；源码契约补终端呈现断言（`b510c93` 2026-09-27）
- 侧栏实时接收 session_renamed——首条消息总结出标题后即时刷新会话名，不必等 turn 收尾；事件联合类型补登记，附源码契约与构建产物同步断言；build:web 产物已更新（`8568615` 2026-09-27）
- 首条消息自动总结会话标题——默认名会话按用户输入本地推导标题并落元信息，新增 session_renamed 事件供两端实时刷新；默认名收敛为 session.mjs 单一常量；附 Loop 三例与 turn e2e 回归（`b293ab1` 2026-09-27）
- 会话标题自动总结模块——首条用户消息本地推导简短标题（零成本不调模型），覆盖首行提取 / markdown 噪声剥离 / 技能注入取用户原话 / 斜杠命令取参数 / emoji 与控制符清洗 / CJK 宽度截断，附九组单测（`a69cd64` 2026-09-27）
- 流式活动状态行——LiveRow 展示轮次/工具数/走秒计时（>60s 转 m:ss， dots 动画走语义令牌），费用格式化收拢到 projection.fmtCostYen（终端同源 fmtCost，消除第三份重复实现）；LiveTurn 增 round/startedAt 由 model_round_started/turn_started 驱动；附源码契约（`a8ed1af` 2026-09-27）
- 零依赖语法高亮——highlight.ts 线性扫描 tokenizer（js/ts/python/json/sh/sql/go/rust/c 等语言族，拼接恒等无损、未知语言回退纯文本），Markdown 代码块接入；token 色一律走语义令牌；附六组单测（无损性/分类/块注释/大小写不敏感/回退/字符串内含关键字）与源码契约（`51041e5` 2026-09-27）
- 技能界面与斜杠命令同源——服务端 turn 统一解析 /<技能名> 为技能注入（与终端同一规则单点解析）；Composer 输入 / 浮现技能调色板（指针/hint 词汇与 docs/tui-design.md 一致，键盘上下选择、Enter/Tab 插入、Esc 取消）；设置弹层增技能目录区（内置/自定义徽标）；附斜杠解析 e2e 与源码契约（`05f359a` 2026-09-27）
- 统一开流入口 openChatStream——/api/chat 与 Agent Loop 共用同一编排（构造请求 + 连接期重试 + 中文错误话术 + 协议帧翻译选择），非 2xx 抛出带 kind/status 的 Error；修复 loop 从未透传 extraTools 导致 MCP 工具 schema 不进请求的 bug（模型此前看不见外部工具）；压缩请求一并切到该入口（顺带修复 Anthropic 线路压缩不翻译帧）；附 MCP schema 进请求的回归断言；真实上游冒烟通过（`b56f6a8` 2026-09-27）
- MCP 管理面板——设置弹层可查看服务器连接状态与工具数、新增 stdio/HTTP 两种传输、测试连接与删除；未开启实验时展示开启指引；附源码契约测试与构建产物（`d903e32` 2026-09-27）
- 注册表与全链路接线——mcp.json 配置（原子落盘、草稿校验、增删）；McpRegistry 连接启用服务器发现工具并包装为 统一形状（mcp__<服务器>__<工具>，inputSchema 映射 parameters），单服务器失败不阻塞其他；loop 经 extraTools 进入请求与执行（子代理同享）；policy action 支持 mcp__* 前缀通配且 MCP 工具默认 ask；/api/mcp/servers CRUD + probe 路由（实验门控，未开启 404 并提示）；终端 /mcp 状态命令；policy action 前缀通配附单测（`e599127` 2026-09-27）
- JSON-RPC 2.0 客户端——stdio 传输（spawn + 行分隔 JSON，超时与进程退出在途请求报错）与 HTTP 传输（POST，JSON 或 SSE 流响应复用 SseParser）；initialize 握手 + tools/list + tools/call + callResultText 纯文本拼装（isError 抛 McpError）；附 mock stdio 服务器与三组单测（握手列举 / 调用与错误路径 / HTTP POST）（`41dc2d2` 2026-09-27）
- 子代理两端渲染——Web 工具卡透传 subAgent/subTask 标记（嵌套缩进 + └ 前缀），task 卡内展示子代理清单（任务/轮数/工具数/成败，历史回放可查）；终端子代理工具行一级缩进呈现；附类型与样式（`6b02c42` 2026-09-27）
- task 子代理工具——createSpawner 派发受限子 turn（真实子会话透明可查、继承工作目录与会话权限规则、嵌套深度封顶 2 层、单次上限 4 个、父中止级联）；子代理只透出工具调用与用量事件（subAgent 标记）供两端嵌套渲染，终稿经 task 工具结果聚合回父模型；loop 注入 ctx.spawn；harness standard/ultimate 挂载 task 并引导自含描述；policy 默认放行派发本身；终端标签同步（`acde2cd` 2026-09-27）
- 计划卡 + 权限三档选择器——LiveTurn 增 plan 状态，plan_proposed/approved/rejected 事件驱动 PlanCard（待批准时展示计划全文与批准执行/驳回按钮，decidePlan 经 POST /api/agent/plan 回传并乐观更新）；Composer 增权限三档下拉（始终询问/必要时询问/完全自动，PATCH 落会话 meta）与计划模式开关；附源码契约测试与构建产物（`361211c` 2026-09-27）
- 计划模式与权限三档接线——loop 抽出 runRound/runToolCalls 闭包供计划与执行两阶段共用；计划轮只用只读/检索/待办工具（plan.mjs 白名单单点定义）产出计划，plan_proposed 事件等用户批准，批准后计划作为既定契约注入执行轮，驳回以 finishReason=plan_rejected 收尾；POST /api/agent/plan 决策通道（断开按驳回）；turn 优先级 请求体>会话meta>config 解析 permissionMode/planMode，PATCH 可改；终端 /plan 开关 + 计划展示 y/n + footer 计划段；policy.evaluate 换 effective（三档生效）（`708b152` 2026-09-27）
- 权限三档 permissionMode——always_ask / ask_when_needed / never_ask 叠加在规则集之上设定 ask 类动作默认效应（never_ask 放行 ask 但不推翻 deny，always_ask 把默认规则的只读放行提升为逐次询问但不推翻用户「总是允许」沉淀的会话规则）；grantAlways 打 source 标记不落盘；附单测（`70eb9da` 2026-09-27）
- edit_file diff 视图 + 待办面板——ToolCard 读 extra.diff/extra.todos 结构化负载渲染行级 diff（diff 语义令牌上色）与待办清单；会话级 TodoPanel 吸顶展示进度并随 tool_event 实时刷新；TOOL_META 补 grep/glob/todo/skill 四个新工具；types/projection/App 贯通 extra 数据管道（`25088fc` 2026-09-27）
- todo 待办工具 + edit_file diff 结构化负载 + extra 契约——工具可返回 {output, extra}，extra（diff/todos）进转录与 tool_event 供两端渲染但不进模型消息；todo 随会话 meta 持久化经 ctx.todoStore 读写；终端待办完成打印进度行；附单测与 e2e（USE_TODO/USE_EDIT 触发词）（`5d32801` 2026-09-27）
- 新增检索工具 grep（正则+glob 文件名过滤+预算截断）与 glob（星号星号跨目录路径匹配）；policy 默认放行检索/待办/skill；harness standard/ultimate 挂上 grep/glob/todo 并在系统提示引导使用；终端工具标签同步；附真实查找单测（含路径禁锢与非法正则）（`b46c923` 2026-09-27）
- 技能系统接线——系统提示注入技能目录（正文按需加载）、loop 贯穿 skills 并有技能时把 skill 工具并入请求 tools、tools.mjs 新增 skill 工具（统一形状，读 ctx.skills）、policy 默认放行 skill、GET /api/agent/skills 路由、终端 /<技能名> 斜杠命令进同一张命令表；mock 增 USE_SKILL 触发词；e2e 覆盖工具调用与回填，npm run check 真实上游通过（`ca53ce6` 2026-09-27）
- 新增技能系统 util/agent/skills.mjs——SKILL.md frontmatter 解析、内置/用户双目录加载（用户覆盖）、系统提示清单块、斜杠注入文本；内置 4 个技能（auroraagent-ops / code-review / systematic-debugging / test-writing，统一目录结构）；build-app 补拷 skills/ 进 Bundle；附单测（`f9e180b` 2026-09-27）
- 终端 REPL 重构为协调器——裸 ANSI 换语义色板 painter、声明式斜杠命令表、/sessions /harness /theme 可搜索选择器、footer 状态条；流式渲染拆出 terminal-turn.mjs、纯助手拆出 terminal-format.mjs；修复 raw mode 下 Ctrl+C 不中断生成的缺陷（rl SIGINT 事件中转）；README/AGENTS 同步（`41e5d97` 2026-09-27）
- 单选对话框 pick.mjs（TTY 原始模式读键 + 非 TTY 回退）与增量重绘 screen.mjs；searchable-list 补 setCursor/focusById；附 pty 验证过的 readline 共存机制与单测（`a29b9dc` 2026-09-26）
- 新增 工具抽象 util/llm(tool 归一化+wire 转换、errors 状态分类)，tools.mjs 改采共享转换器；config 增补实验特性解析器与 permissionMode/planMode 字段(缺省等价现状)；落 docs/tui-design.md 设计规范单一真值源；附单测（`3c7a59a` 2026-09-26）
- 新增零依赖 TUI 工具包 util/tui——语义色板(暗/亮+对比度守卫)、Kitty CSI-u 键位解码、CJK 渲染、SearchableList；附单测与仓库守卫(零 emoji/颜色单一真值源/对比度/行数预算)接入 npm test（`30a881e` 2026-09-26）
- 正文支持 LaTeX 公式渲染——KaTeX 自托管，五种分隔符全覆盖（`b35dbda` 2026-09-26）
- 终端客户端 Agent 化——同一 loop.mjs 驱动会话/工具/权限/记账，思考暗色流式渲染、工具单行状态、权限 readline 确认（y/n/a），新增 /new /sessions /model /harness 等命令与 -p 单次提问；配置解析抽取到 util/config.mjs 供 color-test 复用；web-ui 修复拒绝态被 failed 覆盖导致权限卡状态回退（`dd1de5a` 2026-09-26）
- / 翻转指向 AuroraAgent 工作台——React 构建产物成为唯一前端，旧聊天页与提供方模块/样式退役（文件删除 + 白名单条目清理）；旧 UI 结构断言改写为新构建契约（/ 与 /app 同一份产物、哈希资产存在、设计令牌在场、零 emoji、旧路由 404）与编辑器校验规则源码契约（`1de151b` 2026-09-26）
- AuroraAgent 工作台前端落地——侧栏会话管理/流式对话（思考块/工具卡/内联权限卡/用量脚注）/输入区（模型选择器按提供方分组/模式切换/思考开关）/设置弹层（提供方管理移植+自启开关）；手写 Markdown 子集渲染器与内联 SVG 图标，零 emoji；PATCH 会话接口支撑模式与模型热切换；经浏览器实测完整 turn（权限允许→写文件→二轮终稿）（`448a664` 2026-09-26）
- 会话支持 PATCH 切换模式/改名/换模型——下一轮 turn 生效，未知模式与非法模型 ID 返回 400 且不改动会话；e2e 覆盖成功与各类失败分支（`3e58c40` 2026-09-26）
- web.mjs 接入 /api/agent/* 路由——会话 CRUD、turn SSE 事件流、abort 中断、permission 决策回传、harnesses 列表；HTTP 面拆到 util/agent/http.mjs 守 500 行预算（web.mjs 仅前缀委派）；mock 扩展写文件触发；e2e 覆盖只读放行/写权限允许与拒绝/409 并发/中断续会话（`667e05f` 2026-09-26）
- 新增 turn 运行器 loop.mjs——轮次循环至无工具调用或触顶，工具经权限门控执行并回填，每轮按提供方单价记账，中断保留已生成内容，超限自动折叠早期对话为摘要；附带修复：abort 赛跑在信号已中止时立即拒绝（防读取挂死）、grantAlways 返回规则供持久化、contextWindowOf 接受小窗口声明（`4d485a7` 2026-09-26）
- 新增上下文组装与压缩规划——记录投影为上游消息（thinking/usage 不回填、summary 转系统消息），token 估算超窗口 70% 触发压缩，保留最近 4 个用户轮原文（`af63fc9` 2026-09-26）
- 上游线路支持工具调用——wire.mjs 按协议拼装 tools（OpenAI function calling / Anthropic tools schema），Anthropic 帧翻译补 tool_use 与 input_json_delta 且 finish_reason 映射 OpenAI 词表；stream.mjs 新增 Agent 消费式读取（文本/思考/工具调用增量累积）；mock 扩展工具轮与结果回执（`9ef0f06` 2026-09-26）
- 新增六个内置工具与权限策略——文件工具禁锢工作目录（防穿越）、shell 带超时与输出截断；规则集后匹配赢、未命中默认 ask，「总是允许」沉淀为会话级 allow 规则（`cbdcb74` 2026-09-26）
- 新增会话存储——meta 原子落盘 + jsonl 追加式转录，投影重建容错误行，提供创建/列表/读取/更新/删除（`5aa76b5` 2026-09-26）
- 新增 Agent 事件协议与 Harness 模式契约——事件集定义精简子集（SSE 帧统一封装），三档模式 minimal/standard/ultimate 各自携带系统提示、工具集、轮次上限与压缩阈值（`df2d46a` 2026-09-26）
- 提供方界面改版——行内编辑/删除文字按钮、编辑器标题改 Provider ID、折叠内字段顺序统一、模型行容量改单行 disclosure、挑选弹层补说明并默认全选、获取可用模型在无地址时禁用、必填标记与 :user-invalid 读屏同步（`1d06ae0` 2026-09-26）
- API 密钥新增格式校验——规约：仅可见 ASCII，拒绝 NAME=value 环境变量行与成对引号，全空格视为失误；读取时丢弃永不合法的旧密钥（`5b9dcd8` 2026-09-26）
- 输入区改版为统一大圆角卡片——短占位符 + 工具栏（附件/思考/模型选择/圆形发送），模型选择与思考开关移入输入区；回车提交补 IME 组合态防护，文本框改用原生 field-sizing 增高（`841b0cf` 2026-09-26）
- 编辑器新增计费单价字段——只填一侧也接受并按侧回退内置价，保存时一次性展示全部字段错误（`6282d49` 2026-09-26）
- 设置页接入自定义提供方界面——提供方行/编辑器卡片/添加卡片/可用模型挑选弹层，模型选择器按提供方分组并附提供方提示（`81684a8` 2026-09-26）
- 模型质问改为 id 无关路由，提供方记录新增单价/思考开关/容量字段，账本按提供方单价计价（`d750526` 2026-09-26）
- 新增 Anthropic Messages 线路——util/wire.mjs 拼装请求并把 SSE 翻译成 OpenAI 帧，前端零改动（`54b6f05` 2026-09-26）
- web.mjs 接入自定义 Provider 路由，/api/models 汇总全部提供方，/api/chat 按提供方路由并区分协议鉴权（`77dac76` 2026-09-26）
- 新增自定义 Provider 存储模块 util/providers.mjs，含 ID/端点/协议/模型目录校验与原子落盘（`3c93cfe` 2026-09-26）

### 修复

- 运行时核心修复——悬空 tool_call 补合成结果、MCP 传输类型归一、新模型默认 300K（`6ea0bcf` 2026-09-29）
- API 边界全量归一化——响应形状漂移不再白屏任何面板（`0cc59c6` 2026-09-29）
- 技能目录响应边界归一化——字段缺失不再把设置页白屏（`22a534e` 2026-09-29）
- 修侧栏搜索钮错位与点击展开溢出两处布局缺陷（`6e2fbb5` 2026-09-29）
- 更新检查缓存按本地版本号作 key，版本一变旧结论作废（`5440a34` 2026-09-29）
- 版本机制守卫逐处扫描 README 全部标注，多处硬编码不再漏检（`6f27072` 2026-09-29）
- README 去掉硬编码版本号，守卫改为校验版本机制标注，解除发布 PR 的 CI 死锁（`ff55bdf` 2026-09-29）
- 思考行默认收起、换 lucide brain 图标并修展开首行空白（`b8c6de2` 2026-09-29）
- 修复设置弹层等模态内 toast 被 top-layer 盖住不可见（`a2ef9e9` 2026-09-28）
- 修复浮层让位测量与帮助菜单面板导航两处缺陷（`cdab657` 2026-09-28）
- 修正 Header 像素细节、侧栏高度塌陷、tooltip 闪现三处缺陷（`f7f4f98` 2026-09-28）
- SPA 入口缓存头修正——/ 与 /app 曾误得 immutable，开过根路径的浏览器死缓存旧页面，发版后看到的永远是老版本（`adca0e1` 2026-09-28）
- 用量措辞去 token 化——只讲输入多少 / 输出多少 / 费用多少（`336382d` 2026-09-28）
- 设置弹层居中、遮罩模糊与固定高度（`061b489` 2026-09-28）
- 停止按钮方块按比例放大（`91cf69f` 2026-09-28）
- 修 toast 重复提示不刷新的问题——同屏已有同一条时原地改 repeat 与 expiresAt，快照引用没变，useSyncExternalStore 不会重渲染，计数与续期都看不到；改为整体换新数组新对象，顺带把悬停暂停的赋值写法改直白（`a17ff64` 2026-09-28）
- 窄屏输入区工具栏修复——芯片禁止收缩与折行（窄屏标签两行错字根因）、工具栏允许换行并留行距、模型选择器与发送键收进靠右的尾部组（换行后整组贴右不拆散）、模型芯片可收缩以省略号收尾；补源码契约断言 1 条；构建产物同步；基线 319/319（`3650d9e` 2026-09-28）
- /goal 命令执行前取新鲜目标快照再分派——每次执行都先取新鲜目标快照，再按它分派 create/edit/budget/view；Aurora 原先直接用 React state 的 goal 判定，快照可能陈旧（turn 运行中模型侧自建 / 改写目标、另一客户端刚改动），后果是误走 createGoal 撞 409 GOAL_STATUS_CONFLICT、或带陈旧 expectedUpdatedAt 触发假 GOAL_STALE 409；改为 help/error 本地收尾（不依赖快照）→ 无会话 retained → await getGoal(sid) 取新鲜快照 → 在途切会话丢弃（consumed）→ setGoal(existing) 以服务端真相校正横幅 → create-or-edit 判定 / 纪元 / 查看摘要 / edit 回填全部基于 fresh existing；源码契约断言 2 条（新鲜快照分派 / unfinished 基于 existing）；构建产物同步；基线 316/316（`643aedd` 2026-09-28）
- 裸 /goal budget 无值从静默清除改为报错 + complete 操作提示补 /goal clear——两处语义收紧：① 裸 budget 一律 error '/goal budget needs a value'，Aurora 原先 fallthrough 到 {kind:'budget', tokenBudget:null} 静默清掉上限——用户本想设预算却丢掉保护是危险的静默失败，改为可操作报错（给出 budget=50K / budget=clear 两种写法，旧式 /goal budget 50000 与 /goal budget clear 保留）；② goalActionHint('complete') 补 '/goal `<objective>` starts a new Goal · /goal clear removes this Goal'，补上移除目标那半；单测两条（裸 budget 报错文案含两种写法 / complete 提示含 /goal clear）；基线 316/316（`df65c9a` 2026-09-28）
- turn 收尾刷新保留本地 notice 并按会话守卫——浏览器实测「生成中可输入 /goal」命令被 busy 放行后收不到任何反馈：Composer 已放行 /goal 穿越 busy 直走 REST（服务端本就支持运行中 goal REST），但 App.tsx turn 收尾 finally 里 setMessages(projectRecords(...)) 整体替换消息列表，把 /goal 命令回执与 goal 事件凭据（kind:'notice'，只存在于本地、不在服务端转录里）当场冲掉——实测 busy 期间 notice 正常显示，turn 一结束（busy:false）notices 即为空；改为保留 notice 追加在投影之后。同时补会话守卫：finally 原先以发送时捕获的 cur.id 无条件刷新，运行中切换 / 新建会话后会把旧会话投影写进新会话界面（与 SSE goal 事件的 sessionId 校验同一道防线）；源码契约断言一条（回滚即红）；构建产物同步；基线 316/316（`5bc7958` 2026-09-28）
- 流式 tool_event 同 id 多调用优先更新未完结卡片——与 transcript 投影同源的第二个缺陷面：applyToolEvent 按「首个同 id 卡片」定位，上游代理复用 tool_call id 时（mock 实测 create_goal 与 update_goal 同发 call_mock_1），第二个调用的 started/completed 会把第一个卡片改名顶掉、流式视图只剩一张卡；改为 open（未完结：phase 非 done/failed/rejected）优先定位，无未完结卡片时 begin 类事件开新卡、settle 类事件仅对从未见过的调用补卡（重复完成事件忽略，拒绝态不被 failed 覆盖的既有语义保留）；源码契约断言两条；构建产物同步；基线 316/316（`0eae516` 2026-09-27）
- 工具结果按 id 回填时优先补尚未完结的调用——上游代理复用 tool_call id 时（同一 turn 内 create_goal 与 update_goal 同 id），原实现按「首个同 id 卡片」匹配，第二个调用的结果顶到第一个卡片上，自己永远停在 ok:null（网页投影渲染为「执行中」，浏览器实测复现：USE_GOAL 全链路投影里 update_goal 卡片卡在执行中）；改为优先匹配 ok 为 null 的未完结调用、回退到首个同 id（异 id 并行调用按序回填语义不变）；补单测（同 id 两调用各归其位、异 id 并行回归）；基线 316/316（`889621d` 2026-09-27）
- 熔断阶梯三处语义收紧——① 空回复不再重置连胜：原实现把纯工具轮（无回复文本）当作「指纹清零、连胜中断」，模型交替「空轮 + 复读」即可无限绕过 noProgressStreak；改为无可用回复文本不携带指纹证据，指纹与连胜原样保持；② 新增第 2 阶纠正提醒：原实现从「无」直接跳到「熔断暂停」，模型没有纠偏机会；现在第 1 次观察只记录、第 2 次注入对应 nudge（复读 / 无工具各自成文，同时中招合并，工具轮经 afterRound 'nudge' 暂存、空转轮与续跑提醒合并注入）、第 limit 次才转 paused(no_progress)；③ 阈值下限 1 → 2（max(2, limit)：limit=1 时原实现首轮回复即熔断，明显违背「首次观察只记录」）；单测重写熔断阶梯（首观察/二次 nudge/三次熔断/双计数器合并/空轮不重置/limit 钳制）+ 新增运行时 nudge 接线两路用例；e2e 新增 USE_GOAL_SPIN（复读三轮：断言【无进展提醒】与续跑提醒合并注入、第 3 轮 paused(no_progress)）；docs-site 中英指南与配置表同步；基线 315/315（`df2e7a2` 2026-09-27）
- 续跑提醒两处语义收紧——① 每轮续跑提醒重述当前目标文本（`<objective>` XML 转义、截断 2000 字符）：上下文压缩会把 create_goal 的工具调用挤出窗口，模型失忆后自动续跑只会空转，重述目标后续跑始终知道在追什么（不可信数据处理一致）；验证未通过后的续跑路径同样改为「目标重述 + 缺口反馈」组合；② 验证反馈缺口展示：条数 5 → 10、单条截断 240 字符（原超长缺口可挤爆提醒），省略计数同步；单测补目标重述 / 转义 / 截断 / 反馈条数与截断断言；基线 305/305（`e449940` 2026-09-27）
- 空转指纹算法收紧——原实现删除全部内部空白 + 截断 512 + FNV 哈希过于宽松：模型把复读内容改几个空格、换行位置或超长复读即可绕过 noProgressStreak 熔断；改为仅归一化行尾形态（\r\n?|\n → \n）+ trim，内部空白与全文原样参与 sha256 哈希（node:crypto），展示性重排不赦免、换皮复读无缝遁形；单测改断言内部空白敏感 / 行尾与首尾空白不敏感；基线 304/304（`15f1ac3` 2026-09-27）
- 网页 /goal pause|resume|stop 补状态回执——与终端 REPL 同源输出『目标已暂停：已暂停』形态（此前网页仅静默更新横幅，两端反馈不对称）；契约断言同步；构建产物同步，基线 304/304（`040ead2` 2026-09-27）
- hasUpdateGoalTokenBudgetIntent 字节级语义收紧——豁免仅限「终态提案在场」的 null 兼容填充；孤立 null（无 mode / 无 status）是明确的清预算意图，改判 token_budget 模式后由纪元校验要求新鲜 get_goal 快照（缺快照返回纠正性错误），修复此前孤立 null 被静默忽略、模型清预算无反馈的缺口；单测同步（loneNull → token_budget、提案在场 null → 非意图、数字+status → 混合）（`5e487ac` 2026-09-27）
- 验证结算语义收紧——① not_met streak 改指纹语义（sameMissingSet：归一化后同一批缺口才累加，缺口变化重新计数）；② 连击达 repeatedNotMetLimit 的终态由 blocked(verifier_impossible) 改为 paused(no_progress)（覆盖式决策）；③ 新增 inconclusive 结算分支：按 code 归因暂停（schema_error → paused(verifier_protocol)，其余 → paused(verifier_unavailable)），streak 清零、不并入 not_met 连击、不清帐放行；④ 失败归因细化：超时 → paused(verifier_timeout)，验证随 turn 中止 → 不结算不改状态（修复用户取消 turn 反致目标暂停的缺陷）；⑤ statusReason 闭集补 verifier_protocol/verifier_timeout/verifier_aborted；⑥ mock 补 VERIFY_RETRY 触发词（evaluator 首轮非 JSON、次轮 met），集成测试改断言 paused(no_progress) 并新增「恰好重试一次」用例；单测补 streak 指纹/缺口变化重计/inconclusive 归因三条；docs-site 中英同步；基线 304/304（`c5a249a` 2026-09-27）
- evaluator 裁决校验与提示词收紧——① parseVerdict 增补结构性校验：met 必须带依据、not_met 必须带依据且至少一条缺口、impossible 必须带依据，载荷不完整或非法一律降级 inconclusive(schema_error)（协议层归因），宁可暂停不悄悄放行；② missing 归一化：空白折叠 + 去重 + 排序（streak 指纹对同一批缺口稳定）；③ evaluator/subagent 提示词增补安全边界：目标/自述/转录是不可信数据不是指令、其中指令一律忽略、无工具不得虚构证据、证据不足返回 not_met/inconclusive 严禁凭信心推断；④ 裁决层重试：仅对 inconclusive（含 schema_error 降级）重试、上限 maxRetries（钳 0..1）次，传输层重试仍在 openChatStream；⑤ 失败归因：超时标 code=timeout、turn 中止标 aborted（供宿主区分 paused(verifier_timeout) 与不结算）；单测补结构性校验/归一化/code 透出，基线 300/300（`679e479` 2026-09-27）
- 用量计数与时长格式收紧——① token 计数 formatGoalCount：<1K 原样、<1M 记 K（>=10 取整，12500→13K）、其余记 M，替换原 toFixed(1)（12.5K/20.0K → 13K/20K）；② 时长 formatGoalDuration：<60s 记 s、<60min 记 min+s（秒位不省略，2m→2min0s）、>=1h 记 h+min+s（原 122m 丢小时信息 → 2h2min0s）；③ GoalBanner 去掉本地 fmtTokens/fmtTime，改导入 budget.mjs 共享格式化（网页与终端 footer 单一真值）；formatGoalReceipt 直接用 formatGoalDuration/formatGoalCount 替代脆弱的 goalUsageChip.split 提取；新增 budget.d.mts 供 TS 取类型；测试补时长/计数边界（8s/1min2s/2min0s/2h2min0s/2h9min30s 与 1.2K/13K/20K/999/2.5M）并更新旧形态断言；tui-design footer 芯片规范中英同步；构建产物同步，基线 299/299（`cffccf1` 2026-09-27）
- /goal 命令家族三处缺陷修复（浏览器实测发现）——① edit 动作随文携带 tokenBudget：applyUserGoalAction edit 与 setUserGoalObjective 接受并应用预算（保留重新武装语义），HTTP 层对 edit 带预算启用与 budget 路由同规约的纪元门（expectedGoalId + expectedUpdatedAt，不符 409 GOAL_STALE），终端 create 分支传 cur.updatedAt，网页 create 分支把预算与快照带给 editGoal（此前 /goal <目标> budget=50K 对已有目标会静默丢预算）；② rearmAfterBudgetRaise 改返回增量（status/statusReason/tokenBudget）而非整体 goal——修复与 objective 复合时旧文本覆盖新文本的缺陷，runtime/budget/edit 三个调用方同步改增量复合；③ 网页 Composer 技能调色板无匹配时吞掉 Enter——裸 /goal 与未知 /xxx 无法提交，改为无匹配不拦截、Enter 落到统一提交分支；另新增 notice 消息类型（IconTag + row-notice 令牌化样式）承载 /goal 命令输出与完成回执，不再套 system 行的「已折叠早期对话为摘要」前缀；测试补增量回归、edit 随文预算（纪元/重新武装/坏值）与 REST e2e（新鲜快照生效/陈旧 409/缺字段 409/纯文本不受门限），基线 298/298（`46c6939` 2026-09-27）
- /goal 解析失败时回填原始命令——失败时保留输入（错误提示进系统消息流，输入框保留 /goal <原文> 供就地修改，不再清空）；构建产物同步，基线 296/296（`9385ece` 2026-09-27）
- 回答按用户轮整体呈现——projectTurns 改为用户轮内文本与工具时间线交错（parts），流式与历史同形态不再每次重排版；Message/ChatView/App 按 parts 渲染，文本增量追加到末片段、工具事件保持原位置，并行调用按序回填；测试改契约并补交错用例与源码契约（`0d6a2f9` 2026-09-27）
- Ultimate 补挂 task 工具——系统提示要求派发子代理但工具集缺失，模型看得见指令够不着工具；补三档 task 挂载回归断言（`afebcc8` 2026-09-27）
- web.mjs 委派 /api/mcp 前缀并修正 e2e 测试 URL——MCP 路由此前只挂在 /api/agent 前缀下导致 404，注册表 CRUD 与 Agent turn 工具调用 e2e 全链路覆盖（`4196536` 2026-09-27）
- 模型选择器菜单移出 footer——backdrop-filter 包含块把 fixed 菜单拽出视口；键盘/焦点/外点关闭监听同步挂到菜单容器，菜单补视口内滚动上限，测试加结构防回归断言（`9d571cc` 2026-09-26）
- 内置提供方行在上游目录加载前不再显示误导性的「0 个模型」（`bec12dd` 2026-09-26）

### ci

- release-please 改用 classic PAT 推送发布分支，修发布 PR 的 CI 永不执行（`c077e94` 2026-09-29）
- Linux runner 补装 zsh——shell 工具按 macOS 约定 spawn /bin/zsh，产品代码不动、只补 CI 依赖（`47d0533` 2026-09-28）
- CI 固定 Node 24——测试直接 import highlight.ts 需类型剥离（>=23.6），Node 20 跑不了 e2e；AGENTS.md 测试规约补该运行前提（`5736512` 2026-09-28）
- 新增 GitHub Actions 测试与自动发布流水线——push master 先跑 npm test，全绿后 release-please 按常规提交（feat/fix）开发布 PR，合并即打 tag 建 GitHub Release，版本号只动 package.json；AGENTS.md 架构表与常用命令表、README 补发布说明，顺手修正 README 测试数与 Info.plist 版本漂移；基线 319/319（`0f419a6` 2026-09-28）

### 性能

- 历史消息行 content-visibility 延迟渲染、过渡动画纪律入守卫（禁 transition:all）（`bbbdf2c` 2026-09-28）
- 静态资源 ETag/Last-Modified 协商与 304——SPA 外壳由 no-store 改 no-cache（可重验证），重复访问命中 If-None-Match 只回校验器不传产物；哈希资产 immutable 不变；附 e2e 协商断言（`cd570d6` 2026-09-27）
- jsonl 投影缓存按 (mtimeMs, size) 失效——侧栏列表 / 会话读取不再反复解析全量转录；命中返回浅拷贝（loop 会 push 返回数组，不能直接给出缓存引用），写路径同步失效（`11dacca` 2026-09-27）
- tools[] 拼装按 (toolNames, extraTools 对象标识) 缓存——每个模型轮不再重建 function 形状；MCP 刷新换新对象即自动失效，无陈旧 schema 风险（`5f14015` 2026-09-27）
- SSE 泵背压暂停/恢复——客户端写缓冲满时停读上游等 drain（或中止），杜绝慢客户端场景下上游帧在内存无限堆积；透传与 Anthropic 翻译两条线路同改（`d408374` 2026-09-27）

### 测试

- 新增网页设计令牌双主题对比度守卫——解析 tokens.css 的深色与浅色两块，校验正文 / 次要文字 / 强调色 / 语义色在面板与代码底上的 WCAG 对比度（faint 元信息按 3.0，其余 4.5），浅色主题后续改色不能再悄悄变糊；顺带清理 /api/logs/errors 路由的死条件（`237abc1` 2026-09-28）
- 工具调用 id 每次递增贴合真实上游——原 mock 每次请求都固定发 call_mock_1，同一 turn 内多轮工具调用（如 goal 的 create_goal → update_goal）复用同一 id，既不符合真实上游（OpenAI / Anthropic 均全局唯一），也让「按 id 匹配」的消费路径永远走不到唯一 id 分支；改为 state.toolCallSeq 递增生成 call_mock_N，e2e 自此覆盖唯一 id 主路径，复用 id 的容错由前两笔的投影 / 流式匹配修复与单测守护；基线 316/316（`c95083b` 2026-09-27）
- 子代理覆盖——Loop stub 覆盖 task 并行派发聚合（真实子会话落盘、subAgent 标记透出、子代理文本不回显）与嵌套深度封顶（孙代理派发被拒、子/孙两层会话）；mock 增 USE_SWARM 触发词（tasks 双子任务 + 子代理终稿）；e2e 覆盖子会话新建可查、转录含子任务与终稿、聚合输出收尾（`9e0e46d` 2026-09-27）
- 计划模式覆盖——Loop stub 覆盖批准进执行（计划轮只读工具集 + 执行轮注入已批准计划 + 计划提示只在计划轮）与驳回不执行（finishReason=plan_rejected 且不再请求上游）；e2e 覆盖 plan_proposed/plan_approved/plan_rejected 事件链、计划轮 tools 只读断言、批准注入落转录、无等待计划请求 ok:false；mock 增 USE_PLAN 触发词（计划轮只回计划文本，批准后执行轮回终稿）（`3591b31` 2026-09-27）

### 重构

- GoalBanner 删除与状态芯片重复的等待行——等待仅经芯片标签呈现，无独立 wait 行，同时清理随之失效的 .goalbanner-wait CSS 规则；构建产物同步，基线 299/299（`9325488` 2026-09-27）
- GoalBanner live elapsed 去掉无效 useRef——用量快照到达即重置插值的语义不变（effect 依赖 timeUsedSeconds），少一层中间状态；构建产物同步，基线 296/296（`26d5530` 2026-09-27）
- 转录投影层 transcript.mjs——工具标签/图标键/资源摘要/费用格式化的单一真值源（修复终端与 Web 标签表漂移：Web 缺 task 与 MCP 推导），projectTurns 统一记录分组规则（工具记录不拆散并行调用、新文本开新轮）；终端 terminal-format 与 Web projection/ToolCard/Message 全部改为消费同一份契约；附投影单测与两端同源源码契约；构建产物同步（`7671d3d` 2026-09-27）
- 抽象层落地——消息序列转换抽到 llm/message.mjs（OpenAI ↔ Anthropic turns 纯函数），上游错误话术并入 llm/errors.mjs（单一 QUOTA_WORDING），wire.mjs 收窄为请求构造与帧翻译薄封装；toolSchemas 落实 deferred 过滤（标记工具不进请求顶层 tools[] 以保持字节稳定命中提示缓存，Loop 侧仍可解析执行）；附消息转换与 deferred 单测（`8865515` 2026-09-27）
- 旧命名 ModelTester 全套更名 AuroraAgent——env（AURORAAGENT_DATA_DIR/BASE_URL/API_KEY）、数据目录 ~/Library/Application Support/AuroraAgent、config 文件名 auroraagent.config.json、LaunchAgent label com.auroraagent.app 与日志名同步更换；数据目录回退与 loadConfig 从 web.mjs/check.mjs/install-service.mjs 三处内联收敛到 util/config.mjs 单一实现（顺带修复 web.mjs 硬编码 VERSION 4.0.0 与 package.json 脱节，改为读 package.json）；附一次性迁移：旧数据目录整体搬迁含 Key 保留、旧 label 安装时自动 bootout 防双 job 抢端口；已实测线上服务平滑切换（health hasKey:true，92/92 全绿）（`b7b4012` 2026-09-26）
- 代码注释与启动日志品牌同步为 AuroraAgent（仅文案，行为与 plist 约定不动）（`cc83541` 2026-09-26）
- 上游错误话术与连接期重试抽取到 wire.mjs——/api/chat 与 Agent Loop 共用同一份 401/402 映射与退避重试语义；会话存储补 rules 字段与 replaceRecords（压缩后重写转录）（`3df5b3d` 2026-09-26）
- 色彩语义令牌化——强调色从品牌黄改为图标渐变蓝（#4d8df6），补齐成功/危险/思考/中性灰令牌，清除 providers.css 与 index.html 全部硬编码语义色（原 3 种绿、6 种红各自统一）（`f8c10a9` 2026-09-26）
- LaunchAgent 生命周期、SSE 透传、Provider 路由分别拆到 util/，web.mjs 回到 468 行预算内（`881d430` 2026-09-26）
- 用量账本抽到 util/usage.mjs，web.mjs 只保留汇总出口（`941d1f2` 2026-09-26）

### release

- 版本升至 6.0.0（仅 package.json 一处，Info.plist 与 /api/settings 同源读取）；发布笔记重新生成本轮全部 39 个提交（覆盖 5.0.0 之后的 技能体系搭建全程）（`9a539d3` 2026-09-27）

### build

- .app 更名 AuroraAgent.app——Bundle 内可执行文件、CFBundleExecutable/Identifier（com.auroraagent.app）、启动器 env 与日志路径同步更换；构建时把落地目录里的旧 ModelTester.app 改名为 .legacy 让位（避免两个 App 抢 8787，可手动改回）；旧名 config 迁移时按新名落盘；经临时目录实测打包与让位（`b20b488` 2026-09-26）
- 打包管线前置 web 构建——publish 与 app:build 先执行 build:web 再打 .app，Bundle 内置 React 产物、运行时零 node_modules；CFBundleDisplayName/CFBundleName 更名 AuroraAgent（Bundle ID 与 LaunchAgent label 不变）；经临时目录实测打包与服务冒烟（/api/health、/app/、/api/agent/harnesses 均正常）（`6a27888` 2026-09-26）

<!-- /RELEASE-NOTES:ZH -->