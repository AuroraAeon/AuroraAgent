# AuroraAgent — 本地 Agent 运行时

对标 OpenBitFun 的本地 Agent 运行时：终端 + 网页双客户端共用同一套 Agent Loop（会话 / 轮次 / 工具 / 权限 / 上下文压缩），后端零依赖（只需 Node 18+），可打包为独立 macOS Application。原来的「全球厂商最新大模型速测」能力完整保留为底座——`/api/chat` 流式对话、自定义提供方、用量账本一切照旧。

**当前接入厂商：美团 LongCat-2.5-Preview**（2026-09-25 上线，万亿参数级 Agentic 模型，1M 上下文、128K 输出，OpenAI / Anthropic 双协议兼容）。Base URL、模型目录、Key 均为配置项，接入新厂商不改架构。

> AI 编码 agent：动手前必须先读并遵守仓库根目录的 `AGENTS.md`——第一铁律：每个通过测试的小改动都要主动 `git commit & push`。

## 它是什么

- **Agent Loop**（`util/agent/loop.mjs`）：一轮用户输入驱动「模型请求 → 工具调用 → 结果回填 → 再请求」的循环，直到模型不再调用工具或触顶模式轮次上限；中断保留已生成内容，SSE 断开即中止上游，不浪费额度
- **六个内置工具**（`util/agent/tools.mjs`）：`read_file` / `list_dir` / `write_file` / `edit_file` / `shell` / `web_fetch`，JSON Schema 参数；文件工具经路径解析 + 前缀校验禁锢在会话 workspace 内（拒绝穿越），`shell` 限定工作目录与超时（默认 30s、上限 120s），工具输出超限截断
- **权限门控**（`util/agent/policy.mjs`）：只读工具默认放行，写文件 / 编辑 / 执行命令必须经你确认；「总是允许」沉淀为会话级规则，不是全局放行
- **上下文压缩**（`util/agent/context.mjs`）：token 估算超过窗口阈值（默认 128k 的 70%）时，把早期对话经一轮模型调用总结为 summary 记录，保留近期尾部原文
- **三档 Harness 模式**（`util/agent/harness.mjs`）：模式决定任务怎么被完成——系统提示、可用工具、轮次上限、压缩阈值都随模式变化
- **按轮记账**：每一轮模型请求经 `util/usage.mjs` 按提供方单价结算，会话内可看到每轮 tokens 与费用
- **事件协议**（`util/agent/events.mjs`）：`turn_started` / `model_round_started` / `text_chunk` / `thinking_chunk` / `tool_event` / `token_usage_updated` / `context_compression_*` / `turn_completed|cancelled|failed`，统一 SSE 帧封装，终端与网页共用

## 快速开始

```bash
npm run chat      # 终端 Agent 会话
npm run web       # 网页工作台 http://localhost:8787
```

没配 Key 时按提示操作：打开 <https://longcat.chat/platform/api_keys> 创建 Key，然后三选一——对话里 `/key sk-你的Key`（自动保存）、`export MODELTESTER_API_KEY="sk-你的Key"`、或写进配置文件的 `apiKey` 字段。

## Harness 模式

| 模式 | 定位 | 工具 | 轮次上限 | 压缩阈值 |
| --- | --- | --- | --- | --- |
| Minimal | 快速协作：目标明确时直接作答 | 无 | 1 | 90% |
| Standard | 日常任务：按需调用工具，多步推进并核对结果 | 全部六个 | 24 | 70% |
| Ultimate | 复杂任务：充分探索、逐步验证、汇总结果 | 全部六个 | 64 | 60% |

模式在输入区一键切换（下一轮生效），也可 `PATCH /api/agent/sessions/:id` 热切换。Creative（Mini App 创作）留待后续迭代；Ultimate 暂不含 subagent 派发。

## 工具与权限

| 工具 | 作用 | 默认权限 |
| --- | --- | --- |
| `read_file` | 读工作目录内文本文件（带行号，offset/limit 分段） | 放行 |
| `list_dir` | 列目录直接子项 | 放行 |
| `web_fetch` | 抓取网页（带响应大小上限） | 放行 |
| `write_file` | 覆盖写文件（自动建父目录） | 需确认 |
| `edit_file` | 精确字符串替换（多处出现需上下文或 replace_all） | 需确认 |
| `shell` | 工作目录内执行 shell 命令（退出码 + 输出，超限截断） | 需确认 |

需要确认的工具会在界面里弹出权限卡：**允许**（仅这一次）/ **总是允许**（本会话后续同类操作放行，落会话规则）/ **拒绝**（结果回给模型，循环继续）。终端里是 `y` / `a` / `n` 确认。

**安全边界（如实说明）**：v1 没有 OS 级沙箱。当前边界是「文件工具路径禁锢在会话 workspace + 写与执行必经权限门控」。workspace 默认 `<数据目录>/workspace`，创建会话时可指定。

## 网页工作台

`npm run web` 后访问 <http://localhost:8787>（React + Vite + TypeScript，源码在 `web-ui/`，构建产物随仓库提交在 `public/app/`，运行时零构建）：

- **侧栏**：AuroraAgent 品牌、新建会话、会话列表（相对时间 + 模式 + 轮次）、当前模式
- **对话区**：用户消息、流式回答、可折叠思考块、工具卡片（状态 / 参数 / 结果 / 差异）、内联权限卡、每轮用量脚注（tokens + 费用）
- **输入区**：自适应文本框、模型选择器（按提供方分组）、思考开关、模式切换、发送 / 停止
- **设置弹层**：提供方管理（自定义上游）、开机自启开关、数据目录与版本
- 设计令牌自原版迁移（暗色、强调蓝 `#4d8df6`）；零 emoji，图标一律内联 SVG；Markdown 为手写子集渲染器，不引第三方库

开发态前端：`npm run dev:web`（vite 监听 5173，`/api` 代理到 8787）；改完前端 `npm run build:web` 产出即被 `web.mjs` 以 `/app/` 服务（哈希资产长缓存 + SPA 回退 + 防目录穿越）。

## 终端客户端

`npm run chat` 或 `node chat.mjs`，与网页共用同一套 Loop、会话、账本（数据同目录，两端可交替使用）：思考过程暗色流式渲染、工具调用单行状态、权限 `y/n/a` 确认、恢复会话时打印最近几行 recap。

| 命令 | 作用 |
| --- | --- |
| `/new` | 新建会话（沿用当前模型 / 提供方 / 模式） |
| `/sessions` `/sessions <n>` | 列出 / 切换会话 |
| `/model <名称>` | 切换模型（按 ID 反查提供方） |
| `/harness <minimal\|standard\|ultimate>` | 切换模式 |
| `/think on\|off` | 思考过程开关（默认开） |
| `/temp 0~1` `/max <n>` | 温度 / 单次最大输出 tokens |
| `/key <Key>` | 换 Key 并保存 |
| `/help` `/quit` | 帮助 / 退出 |

`node chat.mjs -p "用一句话介绍你自己"` 单次提问；`node chat.mjs --key sk-xxx` 免配置启动。

## 服务端接口

Agent 运行时（`/api/agent/*`，单活跃 turn：已有 turn 在跑时返回 409）：

| 接口 | 说明 |
| --- | --- |
| `POST /api/agent/sessions` | 创建会话（model / provider / harness / workspace，默认 workspace 为 `<数据目录>/workspace`） |
| `GET /api/agent/sessions` | 会话列表（meta） |
| `GET /api/agent/sessions/:id` | 会话详情（meta + 记录投影） |
| `PATCH /api/agent/sessions/:id` | 热切换 harness / 改名 / 换模型（下一轮生效；未知模式与非法模型 ID 返回 400 且不改动会话） |
| `DELETE /api/agent/sessions/:id` | 删除会话 |
| `POST /api/agent/turn` | 发起一轮对话，SSE 事件流（事件协议见上） |
| `POST /api/agent/abort` | 中止当前 turn，保留已生成内容 |
| `POST /api/agent/permission` | 权限决策回传：`{requestId, decision: 'allow'\|'deny'\|'always'}` |
| `GET /api/agent/harnesses` | 三档模式契约 |

模型速测底座（全部保持原样）：`POST /api/chat`（SSE 流式对话，`provider` 路由自定义上游）、`POST /api/abort`、`GET /api/models`（60s 缓存）、`GET/POST/PUT/DELETE /api/providers*`、`POST /api/providers/discover`、`GET /api/status` `/api/health`、`GET /api/usage`、`GET/POST /api/settings`、`GET /vendor/<name>.svg`。

## 数据与日志（与 App 解耦）

| 内容 | 位置 |
| --- | --- |
| API Key / 模型 / 温度等配置 | `~/Library/Application Support/ModelTester/modeltester.config.json` |
| 会话（meta + 追加式转录） | `~/Library/Application Support/ModelTester/sessions/<id>.meta.json` + `.jsonl` |
| 用量账本（含被中止的请求） | `~/Library/Application Support/ModelTester/usage.jsonl` |
| 自定义提供方（Key / 端点 / 模型目录 / 单价） | `~/Library/Application Support/ModelTester/providers.json` |
| 服务日志 | `~/Library/Logs/com.modeltester.app.log` |

数据目录三级回退：`MODELTESTER_DATA_DIR` 环境变量 → 同目录已存在 `modeltester.config.json` 时用当前目录（源码开发态）→ `~/Library/Application Support/ModelTester`（App 态）。`modeltester.config.json`、`usage.jsonl`、`providers.json`、`sessions/` 永不进仓库。

## 启动与常驻

- **双击 `~/Applications/ModelTester.app`**（macOS 里显示名 AuroraAgent，Bundle ID 与 LaunchAgent label 不变）：服务已在运行就直接打开浏览器；否则后台拉起服务再打开。整个 Bundle 可随意搬移，启动器自定位目录
- **开机自启**：LaunchAgent `com.modeltester.app`（开机自启 + 崩溃自恢复）；登录自启不弹浏览器（`NO_OPEN=1`）
- **卸载服务**：设置页关闭「开机自启」，或 `npm run service:remove`（数据保留）

## 打包与重建

```bash
npm run publish     # 先构建前端（build:web）再打 .app 并重启常驻服务
npm run app:build   # 只构建不重启
```

`app:build` 会**先删除目标 .app 再重建**，因此必须在 Bundle 之外的源码目录执行（脚本内置拒绝保护）。Bundle 内含 React 构建产物（`public/app/`），运行时**不依赖 node_modules**；`web-ui/` 源码与依赖只存在于开发副本。重建后按输出提示把服务重注册到 Bundle 内路径即可。

Bundle 结构：

```
~/Applications/ModelTester.app/Contents/
├── MacOS/ModelTester        # zsh 启动器（自定位目录，Bundle 可随意搬移）
├── Resources/app/           # 全部后端代码（零依赖，Node 18+）
│   ├── web.mjs              # 网页服务：/api/* 路由 + SSE 代理 + /app/ 静态服务
│   ├── chat.mjs             # 终端客户端入口（可 import：loadConfig / streamChat）
│   ├── check.mjs            # 连通性自检
│   ├── util/
│   │   ├── agent/           # Agent 运行时：loop / session / tools / policy / context / harness / events / http / terminal
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
│   ├── test/                # mock 上游 + 92 个测试
│   └── tools/               # color-test / install-service / build-app
├── Resources/docs/          # figures/（学术图与原始数据）+ figure-work/（图表脚本）
├── AppIcon.icns
└── Info.plist               # com.modeltester.app · LSUIElement · 5.0.0
```

## 自定义提供方（接任意上游）

除内置美团 LongCat 外，设置页「提供方」区可接入任意上游——OpenAI 兼容网关、自建服务、或比内置目录更新更快的厂商，都不用改代码：填 Provider ID / 显示名称 / API 地址 / 协议 / 密钥；模型目录可手写或点「获取可用模型」从上游拉取勾选；单价填了账本按它计价，留空回退内置价。Agent 会话与 `/api/chat` 都按模型所属提供方路由。细节（密钥不回显、编辑留空保留原值、Anthropic 协议帧翻译等）见设置页内说明与 `AGENTS.md`。

## 接到其他工具

官方端点 `https://api.longcat.chat`，OpenAI 协议填 `https://api.longcat.chat/openai`：

- **Cherry Studio / Chatbox / 任何 OpenAI 兼容客户端**：Base URL `https://api.longcat.chat/openai`，模型 `LongCat-2.5-Preview`
- **Claude Code**：`ANTHROPIC_BASE_URL=https://api.longcat.chat/anthropic`
- **Codex CLI**：见官方文档 <https://longcat.chat/platform/docs/zh/codex>

完整 API 文档：<https://longcat.chat/platform/docs/zh/>

## 纯色图片识别测试结论（`npm run color`，三轮复测）

用 15 张本地生成的纯色 PNG（红绿蓝黄紫橙青粉黑白灰棕 + 64px 复测 + 深蓝 + 红底白圆对照组）逐张询问模型主色，**连续跑 3 轮共 45 次请求**（约 ¥0.012）：

- **彩色纯色 0/33 全错**（11 个刺激 × 3 轮）：红→白色、绿/黄/紫/橙/青/粉/灰/深蓝→黑色、蓝→浅粉色、棕→品红色
- **消色纯色 5/9**：黑 3/3、白 2/3、灰 0/3
- **对照组（红底白圆）3/3 答"红色"** → 图片上传、Base64 编码、上游解码与多模态视觉链路本身完好；缺陷定位在模型对**均匀、无纹理、无边缘**图像的颜色感知，不是客户端 bug
- **误判是确定性的，不是噪声**：11/15 刺激的三轮回答逐字相同，含全部 8 个"答成黑色"的彩色刺激
- **回答向消色系坍塌**：45 次回答中 40 次（88.9%）为黑/白/浅粉等消色词，42 次（93.3%）不是该刺激的正确颜色
- Fisher 精确检验（单侧）：对照 vs 彩色 p ≈ 1.4×10⁻⁴；消色 vs 彩色 p ≈ 1.5×10⁻⁴
- 实测建议：涉及颜色判断时，给图片加参照物/纹理/文字标注，避免纯色大图

学术图与完整数据见 `Contents/Resources/docs/figures/`（`fig1-solid-color-misidentification` 三面板：刺激图像板 / 混淆矩阵 / 分类别准确率；`fig2-determinism-and-collapse` 两面板：45 次逐轮原始回答表 / 回答分布；另附 `caption.md` 图注与统计说明、`color-raw-3rounds.csv`、`color-summary-3rounds.csv`、`round1-3.json`；PDF / PNG / SVG 三种格式，600dpi TIFF 源图已按仓库体积要求移除）。

## Computer Use（CUA）结论

按"抛弃 IAB、直接驱动真实 Chrome"的思路，对本机网页端做过完整链路验证（以下坐标与细节为旧版前端时期测得，方法仍适用）：

- **可用（完整闭环）**：`cua.getApp("com.google.Chrome")` → 点击输入框 → `paste()` 中文提示词 → `pressKey("Return")` 发送 → 流式返回。中文与 URL 均可靠（`typeText` 会丢字符，必须用 `paste`）
- **坐标系**：`app.click([x, y])` 用 2x 视网膜像素、窗口相对坐标
- **停止链路曾全面失效（已定位并修复）**：根因是旧版前端以 `type="module"` 加载（严格模式），而 `stopped` 用 `var` 声明在 `send()` 函数体内，`stopGeneration()` 首句抛 `ReferenceError`，整条中止逻辑在第一步就中断——服务端从未收到 `/api/abort`。修复：`stopped` 提升为模块级作用域 + 读取循环补 `Promise.race([reader.read(), abortRace])`
- **对策（已落地）**：`POST /api/abort` 按 `requestId` 中止，前端双保险调用；自动化场景也可直接 `curl -XPOST localhost:8787/api/abort -H 'Content-Type: application/json' -d '{"requestId":"..."}'`
- **已知坑**：Chrome 页面会缓存旧页面，改动前端后必须真正重导航才生效；Mac 锁屏后 CUA 全部动作失效，需人工解锁
- **当前状态**：Computer Use 浏览器面被 admin 安全策略阻断（"admin-enforced policy could not be verified"），未绕行；视觉验证暂以 curl + 静态检查替代

## 当前状态（实测打通）

- `npm test` 92/92 通过（mock 上游，不花额度）；`npm run check` 真实 API 连通（Key 有效 + 模型目录 + 测试请求）
- Agent e2e 覆盖：会话 CRUD；完整 turn（工具调用 → 权限允许 → workspace 落盘 → 二轮出终稿）；权限拒绝后循环继续；路径穿越拒绝；shell 执行与超时；turn 中途 abort；harness 列表；上下文压缩触发；每轮用量记账
- 网页工作台经浏览器实测完整 turn：权限卡允许 → 写文件 → 二轮终稿 → 按轮分组的思考 / 工具 / 用量脚注
- 终端实测：权限 y/n 两条路径、`/help` `/sessions` `/new` `/model` `/harness`、拒绝后续跑均正常
- 自定义提供方：设置页可接任意 OpenAI 兼容网关或 Anthropic Messages 上游；账本按提供方单价计价（只填一侧时另一侧回退内置价）；内置 LongCat 请求载荷与接入前逐字节一致（有专门测试守着）
- LaunchAgent `com.modeltester.app`：running / managed，数据目录指向 `~/Library/Application Support/ModelTester`
- UI：零 emoji（全 Bundle 代码 `Extended_Pictographic` 零匹配）；动画遵循 `modern-web-guidance`，全局 `prefers-reduced-motion` 降级

## 常见问题

- `401 invalid_api_key`：Key 错或没填，去 `/key` 重新设置
- `402 insufficient_quota`：余额不足，平台充值或抢资源包
- `429`：请求太频繁，稍等重试
- 工具调用被拒绝：权限卡选「总是允许」沉淀为会话规则；或切换 Minimal 模式（无工具）
- 终端乱码：换用 iTerm2 / Terminal.app 均可，已用标准 ANSI 颜色
