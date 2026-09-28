# 变更日志

本文件记里程碑版本（Keep a Changelog 格式，中文）。逐提交的发布笔记由 `npm run docs:notes` 从 git 历史生成，进文档站 `release-notes` 页。

## [7.1.0](https://github.com/AuroraAeon/AuroraAgent/compare/v7.0.0...v7.1.0) (2026-09-28)


### Features

* **agent:** web_fetch 支持本机代理——util/proxy.mjs 零依赖实现（parseAgentProxy 归一化校验 / http 走正向代理绝对 URI / https 走 CONNECT 隧道 + TLS / 重定向与中文 URL 处理 / 错误中文化），配置新增 agentProxy 段（saveConfig 保留未感知调用方的现值），loop / 子代理 / HTTP 面 / 终端透传 ctx.proxy，GET/POST /api/settings/proxy 路由 + 设置页网络面板（ProxyPanel + proxy-input 客户端预校验）；维基百科类直连被重置的站点可经 http://127.0.0.1:7890 出站，保存即时生效 ([2084d04](https://github.com/AuroraAeon/AuroraAgent/commit/2084d04d6ed0e8d55c3033286cae92ae16e27ed8))
* **goal-bus:** REST 目标变更经进程内事件总线扇出给同会话 SSE 订阅方——补上「另一客户端刚改过目标、本地横幅陈旧」的缺口（对齐 MiniMax 全局事件投影 thread_goal.updated）：新增 util/agent/goal/bus.mjs（零依赖订阅 / 发布 / 退订，按 sessionId 过滤，单订阅写失败与未知事件类型都不拖垮 REST 调用方）；events.mjs 登记 goal_cleared；http.mjs 新增 GET /api/agent/events?sessionId=（订阅即写 SSE 注释冲掉响应头，否则无事件时客户端 fetch 永远等不到 headers；连接关闭无条件退订防泄漏；未知会话 404），create/edit/clear/pause·resume·stop/budget 六类 REST 变更分别发布 goal_created / goal_status_changed（与 runtime.emitStatus 同载荷形状）/ goal_cleared（幂等 clear 不发布）；turn 内 goal 事件仍走 turn SSE 不经总线；单测 8 项断言（扇出 / 会话过滤 / 退订回收 / 坏订阅隔离 / 未知类型丢弃 / goal_cleared 白名单与帧形状）+ e2e 一条（真实 socket 订阅流按序收到 goal_created → goal_status_changed → goal_cleared，幂等 clear 不产生多余帧，404 边界）；基线 318/318 ([d2a98ee](https://github.com/AuroraAeon/AuroraAgent/commit/d2a98ee79cd8a6fc49e5ad4a98cb38207a9e2244))
* **goal-web:** /goal 对齐 MiniMax 运行中可管理目标 + 三处防串会话防护——对照 minimax-code 逐文件审计 WebChat 聊天框 goal 面后补三处真缺口：① busy 放行：此前 Composer.submit 被 busy 整体拦截，生成中无法抬高预算防触顶 / 暂停续跑 / 改写目标文本，而 MiniMax command-flow 的 catalog 命令在 turn 运行中直接 dispatch、Aurora 服务端本就支持运行中 goal REST（【目标已更新】与预算重武装均为在飞场景设计）——改为 /goal 家族命令优先于 busy 门控直走 REST（与 turn 单活门控互不阻塞），composer 提示补一行告知；② 无会话保留草稿：对齐 MiniMax goal-flow 的 retained 语义，无会话时也原样回填便于会话就绪后重发；③ 防串会话三处：对齐 MiniMax canProjectOperation 与 project() 首行 sessionId 校验——网页 busy 时可切换 / 新建 / 删除会话，此前 goal REST 回调、openSession 的 getGoal、SSE 四类 goal 事件均无会话归属校验，旧会话的目标状态与通知会落到新会话界面；改为回调捕获发起时会话 + 纪元（stale 守卫）、openSession 慢响应凭纪元丢弃、SSE goal 事件校验 sessionId；源码契约断言 7 条（ busy 放行顺序 / 提示文案 / SSE 校验 / stale 守卫计数 / 纪元丢弃 / 无会话回填）；docs-site 中英指南与命令参考同步、AGENTS.md 能力面补述；构建产物同步；基线 316/316 ([5b54981](https://github.com/AuroraAeon/AuroraAgent/commit/5b54981da3c686a7ba964fccb76777b601f66518))
* **goal-web:** 无会话时 /goal &lt;目标&gt; 先自动建会话再设立——对齐 MiniMax execute() 第 4-5 步：MiniMax 在 sessionId 缺失且 kind==='create' 时先 await ensureSessionId() 尝试自动建会话，仍失败才append 'Start or resume a Session before managing its Goal.'；Aurora 原先无会话一律 push 提示 + retained，用户想直接开目标时必须手动新建会话；改为 create 意图先 createSession + await openSession（等消息投影落地，目标回执不被冲掉；手动同步 currentIdRef 供 stale() 判定，setCurrentId 渲染尚未落地），其余意图维持直接告警；自动建会话失败给可操作提示并 retained；源码契约断言 3 条；构建产物同步；基线 316/316 ([6bbd542](https://github.com/AuroraAeon/AuroraAgent/commit/6bbd54283b96084202512c5eac0923bfffe8e999))
* **goal-web:** 网页订阅跨客户端 goal 事件流并按 goal_cleared 清横幅——Gap 5 客户端半边：新增 web-ui/src/goal-events.ts（EventSource 订阅 /api/agent/events?sessionId=，五类 goal 事件监听 + 会话归属双保险 + 返回关闭函数）；App.tsx 按 currentId 接线（切会话 / 卸载即关闭，goal_cleared → setGoal(null)，其余按服务端快照整体覆写）；types.ts 的 AgentEvent 联合补 goal_cleared（与 util/agent/events.mjs 白名单一致）；源码契约断言 3 条（模块订阅面 / App 接线 / 会话归属校验）；构建产物同步；基线 318/318 ([073c433](https://github.com/AuroraAeon/AuroraAgent/commit/073c4338360106402a53445f420c335e728c61cd))
* **goal:** /goal clear 支持 cancel / delete 同义别名——对齐 MiniMax thread-goal-command.ts 的 clear/cancel/delete 三分支等价语义，模型与用户零学习成本；GOAL_COMMAND_HELP 与命令清单注明别名；解析器单测补别名、大小写不敏感与「不接受参数」分支；commands / goal-mode / README 中英同步 ([5a07f31](https://github.com/AuroraAeon/AuroraAgent/commit/5a07f31dd151e3cf4b4ee0a8edd2d4032e4d105c))
* **goal:** /goal 命令家族落地——终端与网页 Composer 共用共享解析器（command.mjs 单一事实源：查看/创建/budget= 首尾抽取/旧式空格/clear/edit/pause/resume/stop/help，K·M 后缀与 clear 同义词、CJK 边界、double 检测、动作大小写不敏感）；actions.mjs 新增 setUserGoalObjective（create-or-edit，随文携带预算走重新武装）与 clearUserGoal（幂等移除）、edit 动作（空白 400 GOAL_BAD_OBJECTIVE / 已完成 409）；REST 面 edit 与 clear 接线（clear 不受无目标 404 门限制回 cleared 标记）；终端 cmdGoal 改用 parseGoalCommand 并支持 edit 回填续编与 help 输出；测试补解析器单测、edit/clear 动作单测与 REST e2e（改写 trim / 空白 400 / 无目标 404 / 已完成 409 / clear 幂等），基线 296/296 ([4f9cffa](https://github.com/AuroraAeon/AuroraAgent/commit/4f9cffa828d33ea73eaa041103d4c3b5e084ef00))
* **goal:** GoalBanner 补 usage_limited 恢复提示——对齐 MiniMax goalPolicySummary 对 usage_limited 追加的『Resume after provider access recovers』，横幅在用量受限态显示『等待提供方访问（配额 / 限流）恢复后点恢复或 /goal resume 继续』（与既有 budget_limited 提示行并列）；源码契约断言同步；构建产物同步，基线 299/299 ([6a7e9d6](https://github.com/AuroraAeon/AuroraAgent/commit/6a7e9d63cc9f5b25a48c964fbded8a22786f14f9))
* **goal:** turn 内改写目标文本——在飞模型下一轮收到【目标已更新】（对齐 MiniMax objective-updated）——此前经网页 /goal edit 或 REST 改写目标文本只落盘，在飞 turn 的模型整个 turn 都盯着旧目标工作，『回答了没人再问的问题』；现在 beginTurn / create_goal 定格目标文本，afterRound（工具轮）与 decideNext（空转轮）检出失配即返回 'updated'：经 consumeNote 把【目标已更新】提醒注入下一轮——新目标按不可信数据包裹（&lt;untrusted_objective&gt; XML 转义）并附预算快照（已用/上限/剩余，无预算记 unlimited），提示调整方向、停止只服务旧目标的工作、不借此提案完成；针对旧目标的待定终态提案同时作废（对齐 MiniMax binding-stale 的失配取消语义，修复旧完成提案把新目标标记完成的缺陷）；目标不在管辖（暂停）时不触发；loop 接线一行；单测 4 例（提醒渲染/工具轮检出且只一次/空转轮+提案作废/非管辖不触发）+ e2e 1 例（mock 同步代打 REST edit，断言上游请求体带【目标已更新】与新目标包裹、按新目标结算 complete(worker_proposal)）；docs-site 中英同步；基线 310/310 ([15080c1](https://github.com/AuroraAeon/AuroraAgent/commit/15080c1b0550834e4e4d0152bedde5a24eb3085c))
* **goal:** WebChat 聊天框 /goal 交互三处对齐 MiniMax goal-flow——① 操作失败保留用户输入（retained 语义）：create/edit/budget/clear/动作失败时把原命令经 goalPrefill 回填，onlyIfEmpty 保证只补空输入框、不覆盖失败等待期间新敲的内容，错误提示注明「输入已保留，可修改后重发」（此前失败即丢草稿，长目标文本尤其受伤）；② 无会话时给出明确提示而非静默无操作（对齐 MiniMax 的『Start or resume a Session before managing its Goal』）；③ /goal edit 回填后补操作提示「编辑目标文本后按 Enter 提交（budget=50K 可随文调整预算）」（对齐 setHint 反馈）；Composer prefill 支持 onlyIfEmpty 语义；契约断言同步；构建产物同步，基线 304/304 ([6bca0bc](https://github.com/AuroraAeon/AuroraAgent/commit/6bca0bc7bc71daede48e0cd8c2988824221e356c))
* **goal:** 横幅等待标签 / 完成隐藏 / not_met 缺口清单三处对齐 MiniMax——① GoalBanner 对 complete 返回 null（横幅隐藏，完成回执由 notice 消息承载，对齐 banner.ts render 的 status==='complete' 早退）；② active 且有 executionWait 时状态芯片改用等待标签替换「进行中」（配色保留状态色，对齐 goalPresentation 的 WAIT_LABELS 替换语义）；③ evaluator/subagent 提示词与 parseVerdict 增补 missing 缺口清单解析（每条截断 1000 字符、上限 50 条，对齐 evaluator schema），runtime 透出到 lastVerification，continuation 反馈提醒带前 5 条缺口，GoalBanner 与终端 formatGoalSummary 同源展示前 2 条 +N；源码契约断言与 parseVerdict/反馈/摘要/subagent 续跑单测同步，构建产物同步，基线 299/299 ([ffd3734](https://github.com/AuroraAeon/AuroraAgent/commit/ffd3734be356031ca3defda93dda06f33a28b153))
* **goal:** 活跃目标在每次用户轮首轮重述 + 每 5 轮状态审计（对齐 MiniMax reminder-policy）——此前续跑提醒只在 turn 内空转轮注入，跨轮场景（用户隔天发新消息、上下文压缩已把 create_goal 挤出窗口）里模型完全不知道有进行中目标，目标只剩工具描述里的一行提示；现在 beginTurn 对 active 目标返回轮首重述（&lt;objective&gt; XML 包裹 + 「回应本轮消息同时用工具推进」），loop 把它播种到执行阶段首轮；turnsUsed&gt;0 且 %5===0 时附带例行状态审计段（对照证据重估 complete/blocked，禁止心跳式 update_goal，对齐 terminal-audit）；MiniMax 的 recovery（上轮被中止后先 get_goal 核对）由无差别重述覆盖，不追加剧中止历史；单测 3 例（重述渲染与审计边界 0/4/5/10、beginTurn 对 active/暂停/无目标的返回）+ e2e 1 例（REST 预建目标后新 turn，断言上游请求带【进行中的目标】与目标文本、见到重述才调 read_file、续跑后结算 complete(worker_proposal)）；docs-site 中英同步；基线 313/313 ([194d34f](https://github.com/AuroraAeon/AuroraAgent/commit/194d34f737127bd1fd9104c489d68ccc69aeb6ad))
* **web:** Markdown 表格渲染——md-table.mjs 纯函数解析 GFM 子集（表头/分隔行/对齐/数据行，列数不匹配与裸 --- 不成表），markdown.tsx 渲染 thead/tbody 走同行内渲染，app.css 滚动包裹层不撑破气泡，test/markdown.mjs 九个用例入库 ([185d088](https://github.com/AuroraAeon/AuroraAgent/commit/185d0887260808acfe68fd3edd35227cde55fb2a))
* **web:** 网页 Composer 接入 /goal 命令家族——submit 拦截 /^\/goal(\s|$)/ 交 App 走共享解析器（command.mjs 单一事实源，与终端 REPL 同语义）；handleGoalCommand 按意图分派：view/help/error 走系统消息、create 有未完成目标时自动转 edit（服务端创建的 409 由客户端预先规避）、budget 带 CAS 三参、clear 幂等移除并清空横幅、edit 经 goalPrefill nonce 回填输入框续编；goal 转 complete 时按 goalId 迁移贴 formatGoalReceipt 回执；api.ts 补 createGoal/editGoal/clearGoal 与 goalAction 的 budget/edit 扩展；GoalBanner 富化——turnsUsed、live elapsed（active 且无 executionWait 时 1s 插值、新快照重置偏移）、最近验证结论行（中文裁决标签 + not_met 连击）、随状态动作提示（goalActionHint 同源）、完成回执；源码契约测试同步扩充，构建产物已同步，基线 296/296 ([22489bc](https://github.com/AuroraAeon/AuroraAgent/commit/22489bc6947d7febba18ea7bb1c5322e437fa770))


### Bug Fixes

* **goal-command:** 裸 /goal budget 无值从静默清除改为报错 + complete 操作提示补 /goal clear——对齐 MiniMax thread-goal-command 两处语义：① MiniMax 'head === budget' 一律 error '/goal budget needs a value'，Aurora 原先 fallthrough 到 {kind:'budget', tokenBudget:null} 静默清掉上限——用户本想设预算却丢掉保护是危险的静默失败，改为可操作报错（给出 budget=50K / budget=clear 两种写法，旧式 /goal budget 50000 与 /goal budget clear 保留）；② goalActionHint('complete') 对齐 MiniMax actionHint '/goal &lt;objective&gt; starts a new Goal · /goal clear removes this Goal'，补上移除目标那半；单测两条（裸 budget 报错文案含两种写法 / complete 提示含 /goal clear）；基线 316/316 ([df65c9a](https://github.com/AuroraAeon/AuroraAgent/commit/df65c9aa1155fb1f0c8c05dde6641016393d1e5a))
* **goal-web:** /goal 命令执行前取新鲜目标快照再分派——对齐 MiniMax TuiGoalFlow.execute() 的结构性语义：MiniMax 每次执行都先 await runtime.getGoal(sessionId) 拿 fresh existing，再按它分派 create/edit/budget/view；Aurora 原先直接用 React state 的 goal 判定，快照可能陈旧（turn 运行中模型侧自建 / 改写目标、另一客户端刚改动），后果是误走 createGoal 撞 409 GOAL_STATUS_CONFLICT、或带陈旧 expectedUpdatedAt 触发假 GOAL_STALE 409；改为 help/error 本地收尾（不依赖快照，MiniMax 同样在取快照前消费二者）→ 无会话 retained → await getGoal(sid) 取新鲜快照 → 在途切会话丢弃（consumed）→ setGoal(existing) 以服务端真相校正横幅 → create-or-edit 判定 / 纪元 / 查看摘要 / edit 回填全部基于 fresh existing；源码契约断言 2 条（新鲜快照分派 / unfinished 基于 existing）；构建产物同步；基线 316/316 ([643aedd](https://github.com/AuroraAeon/AuroraAgent/commit/643aedd5dcc05041b37d5d8be97f382d49e85e57))
* **goal-web:** turn 收尾刷新保留本地 notice 并按会话守卫——浏览器实测「生成中可输入 /goal」命令被 busy 放行后收不到任何反馈：Composer 已放行 /goal 穿越 busy 直走 REST（服务端本就支持运行中 goal REST），但 App.tsx turn 收尾 finally 里 setMessages(projectRecords(...)) 整体替换消息列表，把 /goal 命令回执与 goal 事件凭据（kind:'notice'，只存在于本地、不在服务端转录里）当场冲掉——实测 busy 期间 notice 正常显示，turn 一结束（busy:false）notices 即为空；改为保留 notice 追加在投影之后。同时补会话守卫：finally 原先以发送时捕获的 cur.id 无条件刷新，运行中切换 / 新建会话后会把旧会话投影写进新会话界面（与 SSE goal 事件的 sessionId 校验同一道防线，对齐 MiniMax canProjectOperation）；源码契约断言一条（回滚即红）；构建产物同步；基线 316/316 ([5bc7958](https://github.com/AuroraAeon/AuroraAgent/commit/5bc7958fd54daba2134ff981da7de956bd0f9968))
* **goal:** /goal 命令家族三处缺陷修复（浏览器实测发现）——① edit 动作随文携带 tokenBudget：applyUserGoalAction edit 与 setUserGoalObjective 接受并应用预算（保留重新武装语义），HTTP 层对 edit 带预算启用与 budget 路由同规约的纪元门（expectedGoalId + expectedUpdatedAt，不符 409 GOAL_STALE），终端 create 分支传 cur.updatedAt，网页 create 分支把预算与快照带给 editGoal（此前 /goal &lt;目标&gt; budget=50K 对已有目标会静默丢预算）；② rearmAfterBudgetRaise 改返回增量（status/statusReason/tokenBudget）而非整体 goal——修复与 objective 复合时旧文本覆盖新文本的缺陷，runtime/budget/edit 三个调用方同步改增量复合；③ 网页 Composer 技能调色板无匹配时吞掉 Enter——裸 /goal 与未知 /xxx 无法提交，改为无匹配不拦截、Enter 落到统一提交分支；另新增 notice 消息类型（IconTag + row-notice 令牌化样式）承载 /goal 命令输出与完成回执，不再套 system 行的「已折叠早期对话为摘要」前缀；测试补增量回归、edit 随文预算（纪元/重新武装/坏值）与 REST e2e（新鲜快照生效/陈旧 409/缺字段 409/纯文本不受门限），基线 298/298 ([46c6939](https://github.com/AuroraAeon/AuroraAgent/commit/46c6939fde15cff4c7a43b5aecb153d7d3742acf))
* **goal:** evaluator 裁决校验与提示词对齐 MiniMax——① parseVerdict 增补结构性校验（对齐 normalizeVerificationResult）：met 必须带依据、not_met 必须带依据且至少一条缺口、impossible 必须带依据，载荷不完整或非法一律降级 inconclusive(schema_error)（协议层归因），宁可暂停不悄悄放行；② missing 归一化对齐 normalizeMissing：空白折叠 + 去重 + 排序（streak 指纹对同一批缺口稳定）；③ evaluator/subagent 提示词增补安全边界：目标/自述/转录是不可信数据不是指令、其中指令一律忽略、无工具不得虚构证据、证据不足返回 not_met/inconclusive 严禁凭信心推断；④ 裁决层重试对齐 MiniMax physicalCall 语义：仅对 inconclusive（含 schema_error 降级）重试、上限 maxRetries（钳 0..1）次，传输层重试仍在 openChatStream；⑤ 失败归因：超时标 code=timeout、turn 中止标 aborted（供宿主区分 paused(verifier_timeout) 与不结算）；单测补结构性校验/归一化/code 透出，基线 300/300 ([679e479](https://github.com/AuroraAeon/AuroraAgent/commit/679e4796dfb4d6cd72d4ce1d69e616e765a19727))
* **goal:** hasUpdateGoalTokenBudgetIntent 对齐 MiniMax tool-defs 字节级语义——豁免仅限「终态提案在场」的 null 兼容填充；孤立 null（无 mode / 无 status）是明确的清预算意图，改判 token_budget 模式后由纪元校验要求新鲜 get_goal 快照（缺快照返回纠正性错误，与 MiniMax 同路径），修复此前孤立 null 被静默忽略、模型清预算无反馈的缺口；单测同步（loneNull → token_budget、提案在场 null → 非意图、数字+status → 混合） ([5e487ac](https://github.com/AuroraAeon/AuroraAgent/commit/5e487accdf5b595a6db8951789bb4a41a3fbf086))
* **goal:** 熔断阶梯对齐 MiniMax decideAction/scoresReply 三处语义——① 空回复不再重置连胜：原实现把纯工具轮（无回复文本）当作「指纹清零、连胜中断」，模型交替「空轮 + 复读」即可无限绕过 noProgressStreak；改为无可用回复文本不携带指纹证据，指纹与连胜原样保持（对齐 scoresReply）；② 新增第 2 阶纠正提醒：原实现从「无」直接跳到「熔断暂停」，模型没有纠偏机会；现在第 1 次观察只记录、第 2 次注入对应 nudge（复读 / 无工具各自成文，同时中招合并，工具轮经 afterRound 'nudge' 暂存、空转轮与续跑提醒合并注入——对齐 renderNudgePrompt = continuationBody + nudgeGuard）、第 limit 次才转 paused(no_progress)；③ 阈值下限 1 → 2（对齐 max(2, limit)：limit=1 时原实现首轮回复即熔断，明显违背「首次观察只记录」）；单测重写熔断阶梯（首观察/二次 nudge/三次熔断/双计数器合并/空轮不重置/limit 钳制）+ 新增运行时 nudge 接线两路用例；e2e 新增 USE_GOAL_SPIN（复读三轮：断言【无进展提醒】与续跑提醒合并注入、第 3 轮 paused(no_progress)）；docs-site 中英指南与配置表同步；基线 315/315 ([df2e7a2](https://github.com/AuroraAeon/AuroraAgent/commit/df2e7a2f52e093af5832b521623485c701c5f917))
* **goal:** 用量计数与时长格式对齐 MiniMax——① token 计数 formatGoalCount：&lt;1K 原样、&lt;1M 记 K（&gt;=10 取整，12500→13K）、其余记 M，替换原 toFixed(1)（12.5K/20.0K → 13K/20K），对齐 formatCompactCount；② 时长 formatGoalDuration：&lt;60s 记 s、&lt;60min 记 min+s（秒位不省略，2m→2min0s）、&gt;=1h 记 h+min+s（原 122m 丢小时信息 → 2h2min0s），对齐 formatTuiDuration；③ GoalBanner 去掉本地 fmtTokens/fmtTime，改导入 budget.mjs 共享格式化（网页与终端 footer 单一真值）；formatGoalReceipt 直接用 formatGoalDuration/formatGoalCount 替代脆弱的 goalUsageChip.split 提取；新增 budget.d.mts 供 TS 取类型；测试补时长/计数边界（8s/1min2s/2min0s/2h2min0s/2h9min30s 与 1.2K/13K/20K/999/2.5M）并更新旧形态断言；tui-design footer 芯片规范中英同步；构建产物同步，基线 299/299 ([cffccf1](https://github.com/AuroraAeon/AuroraAgent/commit/cffccf185b20c7e052d7a2757f5298a5e8879c10))
* **goal:** 空转指纹算法对齐 MiniMax fingerprintThreadGoalReply——原实现删除全部内部空白 + 截断 512 + FNV 哈希过于宽松：模型把复读内容改几个空格、换行位置或超长复读即可绕过 noProgressStreak 熔断；改为仅归一化行尾形态（\r\n?|\n → \n）+ trim，内部空白与全文原样参与 sha256 哈希（node:crypto），展示性重排不赦免、换皮复读无缝遁形；单测改断言内部空白敏感 / 行尾与首尾空白不敏感；基线 304/304 ([15f1ac3](https://github.com/AuroraAeon/AuroraAgent/commit/15f1ac33907bc410a80914108ce13264add45a79))
* **goal:** 续跑提醒对齐 MiniMax continuationBody 两处语义——① 每轮续跑提醒重述当前目标文本（&lt;objective&gt; XML 转义、截断 2000 字符）：上下文压缩会把 create_goal 的工具调用挤出窗口，模型失忆后自动续跑只会空转，重述目标后续跑始终知道在追什么（对齐 continuationBody 的 {{objective}} 注入与 escapeXmlText 不可信数据处理）；验证未通过后的续跑路径同样改为「目标重述 + 缺口反馈」组合；② 验证反馈缺口展示对齐 renderVerifierFeedback：条数 5 → 10、单条截断 240 字符（原超长缺口可挤爆提醒），省略计数同步；单测补目标重述 / 转义 / 截断 / 反馈条数与截断断言；基线 305/305 ([e449940](https://github.com/AuroraAeon/AuroraAgent/commit/e44994071b4c5d6cb9f4abff2c600a5995eb5180))
* **goal:** 网页 /goal pause|resume|stop 补状态回执——与终端 REPL 同源输出『目标已暂停：已暂停』形态（此前网页仅静默更新横幅，两端反馈不对称，也对不齐 MiniMax goal-flow 每个动作都设 hint 的行为）；契约断言同步；构建产物同步，基线 304/304 ([040ead2](https://github.com/AuroraAeon/AuroraAgent/commit/040ead2fde7b97b8a9e4769d984cd7e78a4eca9b))
* **goal:** 验证结算语义对齐 MiniMax settlement——① not_met streak 改指纹语义（sameMissingSet：归一化后同一批缺口才累加，缺口变化重新计数，对齐 normalizeVerificationResult 的 missingFingerprint）；② 连击达 repeatedNotMetLimit 的终态由 blocked(verifier_impossible) 改为 paused(no_progress)（覆盖式决策，对齐 recordThreadGoalVerification 的 repeatedGap）；③ 新增 inconclusive 结算分支：按 code 归因暂停（schema_error → paused(verifier_protocol)，其余 → paused(verifier_unavailable)），streak 清零、不并入 not_met 连击、不清帐放行（对齐 threadGoalInconclusiveTransition）；④ 失败归因细化：超时 → paused(verifier_timeout)，验证随 turn 中止 → 不结算不改状态（对齐 verifier_aborted 的『宿主生命周期非缺陷』语义，修复用户取消 turn 反致目标暂停的缺陷）；⑤ statusReason 闭集补 verifier_protocol/verifier_timeout/verifier_aborted；⑥ mock 补 VERIFY_RETRY 触发词（evaluator 首轮非 JSON、次轮 met），集成测试改断言 paused(no_progress) 并新增「恰好重试一次」用例；单测补 streak 指纹/缺口变化重计/inconclusive 归因三条；docs-site 中英同步；基线 304/304 ([c5a249a](https://github.com/AuroraAeon/AuroraAgent/commit/c5a249aed210a2ad4111aa5ad7be94429b6ffc12))
* **transcript:** 工具结果按 id 回填时优先补尚未完结的调用——上游代理复用 tool_call id 时（同一 turn 内 create_goal 与 update_goal 同 id），原实现按「首个同 id 卡片」匹配，第二个调用的结果顶到第一个卡片上，自己永远停在 ok:null（网页投影渲染为「执行中」，浏览器实测复现：USE_GOAL 全链路投影里 update_goal 卡片卡在执行中）；改为优先匹配 ok 为 null 的未完结调用、回退到首个同 id（异 id 并行调用按序回填语义不变）；补单测（同 id 两调用各归其位、异 id 并行回归）；基线 316/316 ([889621d](https://github.com/AuroraAeon/AuroraAgent/commit/889621d3031004ef22c5c25f394b178938d8d1cb))
* **web-ui:** 流式 tool_event 同 id 多调用优先更新未完结卡片——与 transcript 投影同源的第二个缺陷面：applyToolEvent 按「首个同 id 卡片」定位，上游代理复用 tool_call id 时（mock 实测 create_goal 与 update_goal 同发 call_mock_1），第二个调用的 started/completed 会把第一个卡片改名顶掉、流式视图只剩一张卡；改为 open（未完结：phase 非 done/failed/rejected）优先定位，无未完结卡片时 begin 类事件开新卡、settle 类事件仅对从未见过的调用补卡（重复完成事件忽略，拒绝态不被 failed 覆盖的既有语义保留）；源码契约断言两条；构建产物同步；基线 316/316 ([0eae516](https://github.com/AuroraAeon/AuroraAgent/commit/0eae51695ac94f7c923399d7415ae8697fa8ebdb))
* **web-ui:** 窄屏输入区工具栏修复——芯片禁止收缩与折行（窄屏标签两行错字根因）、工具栏允许换行并留行距、模型选择器与发送键收进右对齐尾部组（换行后整组贴右不拆散）、模型芯片可收缩以省略号收尾；补源码契约断言 1 条；构建产物同步；基线 319/319 ([3650d9e](https://github.com/AuroraAeon/AuroraAgent/commit/3650d9e5b5f0fe01a88a20aac8d03dcef4a2a545))
* **web:** /goal 解析失败时回填原始命令——对齐 MiniMax goal-flow 的 retained 语义（错误提示进系统消息流，输入框保留 /goal &lt;原文&gt; 供就地修改，不再清空）；构建产物同步，基线 296/296 ([9385ece](https://github.com/AuroraAeon/AuroraAgent/commit/9385ece4a6709067c08ded72083e14759d09b1dd))
* **web:** 回答按用户轮整体呈现——projectTurns 改为用户轮内文本与工具时间线交错（parts），流式与历史同形态不再每次重排版；Message/ChatView/App 按 parts 渲染，文本增量追加到末片段、工具事件保持原位置，并行调用按序回填；测试改契约并补交错用例与源码契约 ([0d6a2f9](https://github.com/AuroraAeon/AuroraAgent/commit/0d6a2f9867c3fae0ae9d80aa512d72c4baaf9f45))

## [7.0.0] - 2026-09-27

以 MiniMax-code 为范本的全面升级：goal 目标模式为主峰，辅以性能基准方法论、终端能力面扩展、前端 UX 补强与文档工程同步。后端仍为零依赖 Node 内置模块，macOS 单用户定位、LaunchAgent 常驻、厂商事实层（模型 ID / `PRICE` / 纯色结论）均不变；缺省行为与 6.x 一致，新能力全部可选开启。

### Goal 目标模式（主峰）

- 一会话一目标（`<数据目录>/goals/<sessionId>.json` 原子落盘，`updatedAt` 兼作 CAS 决策纪元）；六态状态机 `active / paused / blocked / complete / budget_limited / usage_limited`，statusReason 闭集，终态停止自动续跑
- 模型侧三工具 `create_goal` / `update_goal` / `get_goal`（名字与 schema 对齐 codex / minimax-code，仅 Standard / Ultimate 收录）；`update_goal` 提案模式与预算模式严格分离，预算变更必须带新鲜 `get_goal` 快照（纪元不符 409）
- 三维预算（token / 续跑轮次 / 轮内活跃秒数）+ 触顶自动迁移与唯一无工具收尾轮；抬高或清零预算可重新武装 `budget_limited(token)`
- 双熔断：归一化回复指纹 + 无工具提交轮共享阈值，互不累加，触发转 `paused(no_progress)`
- 验证三档 `none / evaluator / subagent`：evaluator 走同路由小快模型低温裁决（maxTokens 4096、超时 60s、重试封顶 1）；met → `complete(verifier_met)`，not_met 连击 → `blocked(verifier_impossible)`，验证器不可用 → `paused(verifier_unavailable)` 不静默放行
- 轮内自动续跑（适配单 SSE turn 模型，不建队列子系统）；`executionWait` 随 `goal_wait_changed` 发布，两端渲染「等待中」
- 双端操作：`/goal` 家族终端命令 + footer 用量芯片；REST `GET /api/agent/goal/:id` 与 `POST /api/agent/goal/{,pause,resume,stop,budget}`；网页 GoalBanner；`goal_created` 等四类事件两端共用

### 性能基准与热点优化

- `tools/perf/` 基准设施：可播大上下文的 SSE mock、startup / upstream-100 / history-300 三场景、临时数据目录拉起真实服务采样 wall / CPU / peak-RSS，输出 JSON + Markdown（`npm run bench` / `bench:smoke` / `bench:full`，本地回归参考非门禁）
- 四项热点优化：`util/stream.mjs` SSE 泵背压 pause/resume、`util/agent/context.mjs` tools JSON 按 (harness, extraTools 签名) 缓存、`util/agent/session.mjs` jsonl 投影按 mtime+size 失效缓存、`web.mjs` 静态资产 304；方法论与前后数字落 `docs/perf-baseline.md`

### 终端 CLI 能力面

- OSC 终端标题（`tui.terminalTitle` 项序，退出 / 挂起清除；挂起经不可捕获 SIGSTOP 真正停下）
- 系统通知三通道（OSC9 / OSC777 / bel，`tui.notifications` 的 when × method × events；unfocused 经 osascript 尽力焦点探测，失败按未聚焦）
- `/btw` 侧边对话：继承主会话自洽历史前缀，内存门面不落盘不进 `/sessions`，`Ctrl+/` 无污染切换
- `/goal` 家族命令与状态栏目标用量芯片

### 前端 UI/UX

- Composer `@` 提及：`GET /api/files/search` 只读搜索会话工作目录（路径禁锢、跳过依赖目录），MentionPalette 调色板（150ms 防抖 + 键盘导航）
- 会话派生：`POST /api/agent/sessions/:id/fork` 复制 meta 与全部转录到新会话（goal 不随复制），侧栏入口
- 设置页「终端」面板：OSC 标题项序、系统通知三档（服务端配置 `GET/POST /api/settings/tui`）、浏览器 Notification opt-in 开关（默认关）

### 文档系统

- 新增 Goal 模式指南中英双页；速查页同步 goal / tui 配置字段表、goal REST 与文件搜索等新路由、`/goal` `/btw` 命令、OSC 标题 / 通知 / footer 芯片规范
- 测试基线 266/266；mock 触发词新增 `USE_GOAL` / `USE_GOAL_BUDGET` / `USE_GOAL_IDLE` / `USE_GOAL_VERIFY_MET` / `USE_GOAL_VERIFY_NOTMET`

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
