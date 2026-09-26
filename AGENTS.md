# AGENTS.md — ModelTester 项目宪法

> 本文件是写给 AI 编码 agent 的项目规约。人类用户文档见 `README.md`；两者冲突时，以真实代码行为为准，并顺手修正文档。
> 优先级：用户当前对话指令 > 本文件 > agent 的默认习惯。本文件是活文档——每次踩坑后，把教训补进来。

---

## 0. 第一铁律：小改动，快提交，勤推送

**每做出一个通过测试的小改动，必须立即 `git commit` 并 `git push`。不要攒批、不要等用户提醒、不要留在本地。**

执行顺序永远是：

1. 改代码（一个可独立验证的小改动，例如「修复一个错误映射」「新增一个厂商标识」）
2. `npm test` 全绿（基线 25 个测试；不绿不准提交）
3. `git add <具体文件>` → `git commit -m "中文描述"` → `git push`

规约：

- 粒度：一次提交只做一件事；大任务拆成多次提交，每次提交后仓库都必须处于可运行、测试全绿的状态
- 提交信息：中文，一句话说清「改了什么、为什么」，如 `fix(chat): 401 错误映射补充额度不足分支`
- 身份与远端：`user.name=AuroraAeon` / `user.email=auroraaeon@users.noreply.github.com`；`origin` = https://github.com/AuroraAeon/ModelTester（private，master 分支）
- 凡触及真实上游行为的改动（请求格式、错误映射、模型目录解析），提交前额外跑一次 `npm run check`
- 推送失败先诊断（网络 / 权限），不得 `--force` 绕过，不得改写已推送的历史

---

## 1. 项目是什么

ModelTester 是「全球厂商最新大模型速测工作台」：厂商每上线一个新模型，用它在本地以最短路径完成「拿到 Key → 连通 → 对话 → 多模态 → 用量计费 → 横向对比」。

产品形态与技术底线：

- 单用户本地工具，**仅支持 macOS**（依赖 LaunchAgent 与 `~/Library` 目录约定）
- **零依赖**：只用 Node 18+ 内置模块；ESM `.mjs`；**没有任何构建步骤**（无 bundler、无转译、无 `node_modules`）
- 双客户端：终端（`chat.mjs`）+ 网页（`web.mjs` + `public/index.html`），共享同一套配置与数据目录
- 可打包为独立 macOS Application（`~/Applications/ModelTester.app`），由 LaunchAgent `com.modeltester.app` 常驻
- 当前接入厂商：美团 LongCat-2.5-Preview。Base URL / 模型目录 / Key 全部是配置项——**代码不绑定厂商**，接入新厂商不改架构
- 自定义 Provider：设置页可加任意 OpenAI 兼容 / Anthropic Messages 上游（存储、校验、发现、路由在 `util/providers.mjs` + `util/wire.mjs`，前端在 `public/providers.mjs`）；内置提供方只读，请求载荷保持历史形态

## 2. 架构地图

| 文件 | 职责 |
| --- | --- |
| `web.mjs` | 网页服务核心：静态页、`/api/*` 路由、SSE 代理、停止中断、模型目录（单飞加载 + 60s 缓存）；Provider 路由 / LaunchAgent / SSE 泵 / 账本已拆到 `util/`，静态资源走 `STATIC_ASSETS` 白名单 |
| `chat.mjs` | 终端客户端：ANSI 彩色输出、思考过程流式渲染、中断保留已生成内容、`/key` 等命令 |
| `check.mjs` | 连接自检：Key 校验 → 模型列表 → 一条最小真实请求（会花少量钱） |
| `public/index.html` | 单页前端：原生 JS + 内联 SVG 图标，无框架；模型选择器、设置弹层（原生 `<dialog closedby="any">`） |
| `util/sse.mjs` | SSE 解析器 `SseParser` + token 估算（测试与前端共享） |
| `util/providers.mjs` | 自定义 Provider：存储（`providers.json` 原子落盘）、ID/端点/协议/模型目录/单价校验、上游模型发现、`/api/providers` 路由处理 |
| `util/wire.mjs` | 协议适配：OpenAI 兼容与 Anthropic Messages 的 URL 拼接、请求拼装、Anthropic SSE 帧翻译成 OpenAI 帧 |
| `util/stream.mjs` | SSE 透传 / 翻译泵（逐帧转发 + 用量累计，供 `/api/chat` 使用） |
| `util/usage.mjs` | 用量账本：逐行追加 + 汇总出口 |
| `util/service.mjs` | LaunchAgent 生命周期：plist 生成 / 安装 / 卸载 / 状态 |
| `public/providers.mjs` | 自定义 Provider 前端：提供方行、编辑器/添加卡片、可用模型挑选弹层、删除确认（`mountProviders`） |
| `public/providers.css` | Provider 界面样式，复用全局设计令牌 |
| `test/` | e2e 测试：mock 上游 + 真实 socket（见第 8 节） |
| `tools/install-service.mjs` | LaunchAgent 安装 / 卸载 / 状态（plist 生成规则与 `web.mjs` 内置逻辑保持一致） |
| `tools/build-app.mjs` | 打包 `.app`（含自保护，见第 6 节） |
| `tools/color-test.mjs` | 纯色识别回归测试工具（结论沉淀在 `docs/`） |
| `docs/` | 测试结论与学术图表（PNG / SVG / PDF + CSV；**TIFF 永不再进仓库**） |

数据流：浏览器 `POST /api/chat` → `web.mjs` 按模型所属提供方选协议请求上游（省略 `provider` 时按模型 ID 反查，再回退内置）→ SSE 逐帧透传或翻译（`reasoning_content` 渲染为思考、`content` 渲染为回答）→ 结束按提供方单价结算用量账本。客户端断开即 `AbortController` 中止上游，不浪费额度。

## 3. 常用命令

| 命令 | 用途 | 注意 |
| --- | --- | --- |
| `npm test` | e2e 测试（mock 上游） | **每次提交前必跑**；不花真钱、不碰真实数据 |
| `npm run check` | 真实 API 连通自检 | 会花少量钱；改了上游相关逻辑时跑 |
| `PORT=8788 npm run web` | 开发态网页服务 | 避开 8787 正式端口 |
| `npm run chat` | 终端聊天 | — |
| `npm run color` | 纯色识别测试 | 真实调用，按需 |
| `npm run service` / `service:status` / `service:remove` | 安装 / 查看 / 卸载 LaunchAgent | — |
| `npm run publish` | 构建 `.app` 并重启服务 | **只能在 Bundle 外的源码目录执行** |
| `npm run app:build` | 只构建不重启 | 同上 |

调试：`LOG_LEVEL=debug npm run web`；常驻服务日志在 `~/Library/Logs/com.modeltester.app.log`。

## 4. 数据目录与配置

三级回退（`web.mjs` / `chat.mjs` / `check.mjs` / `tools/install-service.mjs` 四处实现必须保持一致）：

1. `MODELTESTER_DATA_DIR` 环境变量（LaunchAgent 显式指定）
2. 同目录已存在 `modeltester.config.json` → 用当前目录（源码开发态）
3. 否则 `~/Library/Application Support/ModelTester`（App 态，数据与 Bundle 解耦）

配置字段：`apiKey` / `model` / `thinking` / `temperature` / `maxTokens`；用量账本 `usage.jsonl` 逐行追加。环境变量 `MODELTESTER_API_KEY`、`MODELTESTER_BASE_URL` 优先级高于配置文件。

**`modeltester.config.json`、`usage.jsonl`、`providers.json` 已在 `.gitignore`，永远不许提交**——Key 泄露即安全事故。自定义提供方（含 API 密钥、单价）存 `providers.json`，内置 LongCat 提供方在内存里合成（`builtin: true`，只读）。

## 5. 代码风格铁律

- 只用 Node 内置模块；**新增任何 npm 依赖必须先获得用户同意**
- 2 空格缩进、单引号、行尾分号，与现有文件保持一致
- 注释与面向用户的文案一律中文；错误消息必须「说清原因 + 给出下一步动作」（参考 401 / 402 的友好映射）
- **产品内零 emoji**：网页 UI、错误消息、终端 banner 都不允许 emoji；图标一律内联 SVG 或 `public/vendors/*.svg`。终端 CLI 的 `✓` / `✗` 属命令行惯例，允许保留
- 前端不引框架、不引 CDN；动画用原生 CSS（`@starting-style`、top-layer 过渡，参考 `public/index.html` 设置弹层）
- 服务路由集中在 `web.mjs` 单个 `createServer` 处理器内按「方法 + 路径」平铺，不引路由库
- 单文件控制在约 500 行内；`web.mjs` 已接近上限，新功能优先拆到 `util/` 等模块

## 6. 服务生命周期（macOS LaunchAgent）

- Label `com.modeltester.app`；plist 位于 `~/Library/LaunchAgents/`；`RunAtLoad` + `KeepAlive`
- 日志**必须**落 `~/Library/Logs/com.modeltester.app.log`：launchd 无权重定向到 `~/Documents` 等 TCC 保护目录，否则 job 以 exit 78 反复失败
- LaunchAgent 场景 `NO_OPEN=1` 不弹浏览器；只有用户手动开 App 才 `open`
- 端口冲突时 `web.mjs` 按 1 秒间隔重试最多 60 次——这是设置页切换自启时新旧实例平滑交接（约 1 秒不可用窗口）的基石，**不要改**
- 设置页开关语义：`autostart` = plist 是否存在；`managed` = 当前进程是否正被 LaunchAgent 托管
- **禁止在 Bundle 内执行 `npm run app:build`**：构建会先删掉整个 `.app`，`tools/build-app.mjs` 的自保护会直接报错；正确做法是把 `Resources/app` 拷到 Bundle 之外的目录再构建

## 7. 接入新厂商 checklist

1. `public/vendors/<name>.svg` 放厂商标识；`web.mjs` 的 `/vendor/` 白名单路由自动放行（正则防目录穿越，勿放宽）
2. `public/index.html` 的 `VENDOR_MARKS` 数组加一行前缀匹配（模型 id → 图标）
3. 配置 `MODELTESTER_BASE_URL`；模型目录来自上游 `GET /openai/v1/models`，代码不硬编码厂商模型清单
4. `README.md`「当前接入厂商」段同步更新；协议差异（如思考开关字段、Messages 线路）在 `util/wire.mjs` 处理并补测试；更常见的路径是让用户直接在设置页加自定义提供方，无需改代码
5. 全程遵守第 0 节：每完成一步且 `npm test` 通过，就提交推送一次

## 8. 测试规约

- e2e 模式：mock 上游（`127.0.0.1:18901`，复刻真实 SSE 帧与 401 / 402 错误）+ 真实 socket 拉起 `web.mjs`（`127.0.0.1:18787`）
- **数据隔离**：测试以临时目录作 `MODELTESTER_DATA_DIR`，绝不许写真实数据目录
- 新路由 / 新行为 / 新错误映射必须带中文测试名进入 `test/run-tests.mjs`；mock 需要新行为时改 `test/mock-longcat.mjs`
- 基线 56/56 通过。提交前 `npm test` 必须全绿；不许 `skip`，不许放宽断言迁就失败
- `npm run check` 走真实上游，只在改上游集成时跑（花少量钱）

## 9. 反模式（NEVER）

- **NEVER** 攒一批改动才提交；**NEVER** 在测试红着时提交
- **NEVER** 提交 `modeltester.config.json` / `usage.jsonl` / 任何日志
- **NEVER** 引入 npm 依赖或构建步骤
- **NEVER** 在产品 UI 里加 emoji
- **NEVER** 在 Bundle 内执行 `npm run app:build`
- **NEVER** 改动厂商事实层：模型 ID、显示名映射规则、价格常量 `PRICE`、纯色测试结论——除非上游本身变了
- **NEVER** 修改 `web.mjs` 的 EADDRINUSE 重试逻辑与 plist 日志路径约定（见第 6 节）
- **NEVER** 触碰 `~/Documents/cc-switch`（其他项目的仓库）
- **NEVER** 用 `rm -rf` 删目录；用 Node `fs.rmSync` 并二次确认路径

## 10. 验证基线（改动后自查）

- `npm test` → 56/56
- `curl -s localhost:8787/api/health` → `{"ok":true,...}`；`/api/settings` → `version` / `managed` / `dataDir` 符合预期
- 浏览器打开 http://localhost:8787 ：无 emoji、厂商图标正常、动画流畅、设置弹层可开关开机自启
- 改了启动 / 打包逻辑：`npm run publish` 后 `launchctl print gui/$(id -u)/com.modeltester.app` 确认 `state = running`

## 11. 文档同步

- 行为发生变化时，同一次提交里更新 `README.md`（人类文档）与本文件（agent 规约）
- `docs/figures/` 只放 PNG / SVG / PDF + CSV；**TIFF 永不再进仓库**（历史上有过 112MB 教训）
- 图表脚本 `docs/figure-work/make_figures.py` 本机只能 `py_compile` 验证（环境无 numpy / matplotlib）；图标管线用 `npx sharp-cli`
