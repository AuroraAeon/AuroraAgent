# ModelTester — 全球新模型速测工作台

厂商每上线一个新模型，你最想知道的是：**它到底行不行**。ModelTester 把「拿到 Key → 连通 → 对话 → 多模态 → 用量计费 → 横向对比」这套流程压缩到本地一个 App 里：终端 + 网页双客户端，流式输出、思考过程开关、图片理解、停止中断、用量账本，零依赖（只需 Node 18+），可打包为独立 macOS Application。

**当前接入厂商：美团 LongCat-2.5-Preview**（2026-09-25 上线，万亿参数级 Agentic 模型，1M 上下文、128K 输出，OpenAI / Anthropic 双协议兼容）。Base URL、模型目录、Key 均为配置项，接入新厂商只需在 `public/vendors/` 放一张厂商标识、在模型目录映射里加一行。

> AI 编码 agent：动手前必须先读并遵守仓库根目录的 `AGENTS.md`——第一铁律：每个通过测试的小改动都要主动 `git commit & push`。

## 启动与常驻

- **双击 `~/Applications/ModelTester.app`**：服务已在运行就直接打开浏览器；否则后台拉起服务再打开（日志追加到 `~/Library/Logs/com.modeltester.app.log`）。整个 Bundle 可随意搬移，启动器自定位目录
- **开机自启**：LaunchAgent `com.modeltester.app` 已安装（开机自启 + 崩溃自恢复）；登录自启不弹浏览器（`NO_OPEN=1`），只有你手动开 App 时才开浏览器
- **卸载服务**：设置页关闭「开机自启」，或终端执行 `npm run service:remove`（数据与配置保留）
- 网页地址：<http://localhost:8787>

## 数据与日志（与 App 解耦）

| 内容 | 位置 |
| --- | --- |
| API Key / 模型 / 温度等配置 | `~/Library/Application Support/ModelTester/modeltester.config.json` |
| 用量账本（含被中止的请求） | `~/Library/Application Support/ModelTester/usage.jsonl` |
| 服务日志 | `~/Library/Logs/com.modeltester.app.log` |

数据目录按三级回退解析：`MODELTESTER_DATA_DIR` 环境变量 → 同目录已存在 `modeltester.config.json` 时用当前目录（源码开发态）→ `~/Library/Application Support/ModelTester`（App 态）。因此 Bundle 内直接执行 npm 命令无需设置任何环境变量。

## 设置页

页头右上角齿轮按钮打开设置弹层（原生 `<dialog closedby="any">`，Esc 或点击背板关闭，不支持的浏览器有 JS 兜底）：

- **开机自启**开关：切换即安装/卸载 LaunchAgent `com.modeltester.app`；前端轮询 `/api/settings` 直到 `managed` 与目标一致（开启时旧实例会让出端口等新 job 接管，不可用窗口约 1 秒）
- **服务状态**：`managed`（LaunchAgent 是否托管当前进程）、服务 PID、数据目录、端口、版本

## 第一步：获取 API Key（唯一需要你操作的）

1. 打开 <https://longcat.chat/platform/api_keys>，手机号（或邮箱）注册登录
2. 创建 API Key（形如 `sk-xxxxx`）
3. 三选一配置：
   - 聊天界面里输入 `/key sk-你的Key`（自动保存）
   - 或终端执行 `export MODELTESTER_API_KEY="sk-你的Key"`
   - 或把 Key 写进 `~/Library/Application Support/ModelTester/modeltester.config.json` 的 `apiKey` 字段

> 平台按量付费，限时折扣价：输入 ¥2 / 缓存命中 ¥0.04 / 输出 ¥8（每百万 tokens）。也可在「Token资源包」页每天 10:00/16:00/21:00/23:00 抢购限时额度包。

## 用法

Bundle 内终端执行（数据目录自动回退，直接读到 Key）：

```bash
cd ~/Applications/ModelTester.app/Contents/Resources/app
npm run check   # 自检：Key 是否有效 + 模型列表 + 测试请求
npm run chat    # 终端聊天（流式输出，思考过程灰色显示）
npm test        # 25 个单元/集成测试（mock 上游，不花 Key 额度；账本落临时目录，不污染真实数据）
npm run color   # 纯色图片识别测试（打真实 API，约 ¥0.004）
```

`node chat.mjs -p "用一句话介绍你自己"` 可单次提问；`node chat.mjs --key sk-你的Key` 可免配置直接启动（Key 仍会写入配置供下次使用）。

网页端功能：实时状态行（思考中 Xs / 生成中 Xs · N 字）、停止按钮（页脚和顶栏各一个，生成时出现；中止后保留部分内容可继续对话）、智能自动滚动（距底 140px 内才跟随）、断流即中止上游（不再白烧 token）、生成期间键入 `/stop` 回车即停止（文本命令通道，真实键盘/终端均可）、**模型选择器**（页头触发器 + `/model` 文本命令双入口，选择记入 `localStorage`，体验新模型无需改代码；触发器展示当前接入厂商的标识）、四种发图方式（附件按钮 / Ctrl+V 粘贴 / 拖拽到窗口 / `/img 路径`）。

## 终端命令

| 命令 | 作用 |
| --- | --- |
| `/think on\|off` | 思考过程开关（默认开） |
| `/img <路径>` | 附带图片，体验多模态（如下一行输入"这张图讲了什么"） |
| `/model <名称>` | 切换 `LongCat-2.5-Preview` / `LongCat-2.0` |
| `/temp 0~1` `/max <n>` | 温度 / 单次最大输出 tokens |
| `/clear` `/key` `/quit` | 清空上下文 / 换 Key / 退出 |

每轮回复后会显示耗时、token 用量和估算费用。

## App Bundle 结构

```
~/Applications/ModelTester.app/Contents/
├── MacOS/ModelTester    # zsh 启动器（自定位目录，Bundle 可随意搬移）
├── Resources/app/       # 全部代码（本文件所在处）
│   ├── web.mjs          # 网页服务（零依赖 http 服务器 + SSE 透传）
│   ├── chat.mjs         # 终端客户端（可 import：loadConfig / streamChat）
│   ├── check.mjs        # 连通性自检
│   ├── public/
│   │   ├── index.html   # 网页前端（独立文件）
│   │   ├── icon.svg     # ModelTester 品牌标识（App 图标同款）
│   │   └── vendors/     # 各接入厂商的标识（meituan.svg …）
│   ├── util/sse.mjs     # 增量 SSE 解析器 + token 估算（前后端共用）
│   ├── test/            # mock 上游 + 25 个测试
│   └── tools/           # color-test / install-service / build-app
├── Resources/docs/      # figures/（学术图与原始数据）+ figure-work/（图表脚本）
├── AppIcon.icns         # ModelTester 品牌图标（public/icon.svg 栅格化生成）
└── Info.plist           # com.modeltester.app · LSUIElement · 4.0.0
```

## 重建 App

`npm run app:build` 会**先删除目标 .app 再重建**，因此必须在 Bundle 之外的源码目录执行（脚本内置拒绝保护，在 Bundle 内执行会直接报错退出）：

```bash
cp -R ~/Applications/ModelTester.app/Contents/Resources/app /tmp/modeltester-src
cd /tmp/modeltester-src
npm run app:build        # 默认输出 ~/Applications/ModelTester.app
# 按输出提示把服务重注册到 Bundle 内路径：
MODELTESTER_DATA_DIR="$HOME/Library/Application Support/ModelTester" \
  node "$HOME/Applications/ModelTester.app/Contents/Resources/app/tools/install-service.mjs"
```

在开发副本里可以一条命令搞定「构建 + 重启服务」：`npm run publish`。

搬移整个 .app 到任何机器、任何路径都能直接跑；换路径后重注册服务执行 `npm run service`（在 Bundle 内执行即可，数据目录会自动写对）。

服务端接口：

| 接口 | 说明 |
| --- | --- |
| `POST /api/chat` | SSE 流式对话；请求体带 `requestId`（前端自动生成）用于注册活跃流 |
| `POST /api/abort` | 按 `requestId` 停止正在进行的生成：`{aborted:true}` 已中止 / `{aborted:false}` 无对应活跃请求 |
| `GET /api/models` | 模型目录（可读名 + 标签 + 是否配置默认）；60s 缓存，`?force=1` 强制刷新 |
| `GET /api/status` `/api/health` | Key 状态 / 存活检查 |
| `GET /api/usage` | 用量汇总；明细落盘 `usage.jsonl`，被中止的请求记 `stopped:true` |
| `GET/POST /api/settings` | 开机自启开关 + 服务状态（`managed` / PID / 数据目录 / 端口 / 版本） |
| `GET /vendor/<name>.svg` | 接入厂商的标识图（文件名正则白名单，防目录穿越） |

模型选择：前端把所选 `model` 随 `/api/chat` 上报，服务端按 `/^[A-Za-z0-9._:-]{1,80}$/` 校验后透传给上游，非法值回退到 `modeltester.config.json` 的 `model`；目录来自 `GET /openai/v1/models`，厂商上线新模型后刷新页面即可在列表里看到，账本 `usage.jsonl` 记录每次实际使用的模型。

停止按钮工作原理（双保险）：点击后前端先 `POST /api/abort` 让服务端 `AbortController` 中止上游请求，再中止本地 fetch；客户端断连同样会触发服务端中止。中止后已产生的部分回答保留可继续对话，用量账本记录 `stopped:true`。

以下设计借鉴自本机 `deepseek-harness`（`dsh`，源码位于 `/Users/pub/.local/lib/node_modules/@deepseek-ai/dsh`）：

- **模型选择器交互**：借鉴 `dsh-client-ui-model-selection` 的 `ModelSelect` —— 触发器 + 弹层（贴触发器右对齐向上弹出、12px 视口边距钳制）、`↑`/`↓` 循环移动焦点、`Escape` 关闭并把焦点归还触发器、点击外部与失焦均关闭、`aria-haspopup/expanded/controls` + `role=menu/menuitem`、`aria-busy` 忙碌态、加载失败显示原因并提供重试
- **按流 id 取消 + 命名原因**：借鉴 `dsh-api-gateway` 的 stream cancel 协议与 `cancellableStream`，中止时携带原因（`用户点击了停止按钮` / `客户端断开连接`），日志可区分
- **race 式中断读取循环**：`Promise.race([reader.read(), abortRace])`，即使 `read()` 未立即拒绝也能立刻跳出循环；服务端与浏览器端读取循环均已采用，退出前 `reader.cancel()` 释放上游连接
- **中止也落账**：借鉴 dsh"取消时保留已产生的部分结果"的语义，停止请求同样写入用量账本（`stopped:true`）
- **连接期退避重试**：借鉴 `dsh-llm` retry-policy"未产生任何 durable 输出才重试"的思想，仅网络层失败（`fetch` 抛 `TypeError`）且未收到任何字节时重试，最多 2 次（500ms/1000ms 退避）
- **按措辞识别额度耗尽**：借鉴 `dsh-llm` 的 `isQuotaExceededError`，非 402 状态码但错误文本含 quota/balance 耗尽措辞时也给出充值指引

## 继续开发

源码副本位于 `~/Documents/ModelTester`（本 README 所在目录即开发副本；`~/Applications/ModelTester.app` 是构建产物，日常改动都在开发副本进行）：

```bash
cd ~/Documents/ModelTester
npm test                      # 25 个测试（mock 上游，账本落临时目录，不污染真实数据）
npm run check                 # 真实 API 连通性自检（Key 经数据目录回退自动读取）
PORT=8788 npm run web         # 开发模式前台运行（避开常驻服务占用的 8787）
npm run publish               # 构建 Bundle + 重启常驻服务，一条命令发布
```

- 数据目录回退对开发副本同样生效：副本内没有 `modeltester.config.json`，自动使用 `~/Library/Application Support/ModelTester`，开发产生的用量照常记入真实账本
- 也可在开发副本执行 `npm run service` 让 LaunchAgent 直接跑源码（改完 `launchctl kickstart -k gui/$(id -u)/com.modeltester.app` 即生效，免去重新打包）；要改回跑 Bundle，重新 `npm run app:build` 并按提示重注册服务
- Bundle 内执行 `npm run app:build` 会被自保护拒绝，发布务必在开发副本操作

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

按"抛弃 IAB、直接驱动真实 Chrome"的思路，用 Computer Use 对 `http://localhost:8787` 做过完整链路验证：

- **可用（完整闭环）**：`cua.getApp("com.google.Chrome")` → 点击输入框 → `paste()` 中文提示词 → `pressKey("Return")` 发送 → 流式返回。中文与 URL 均可靠（`typeText` 会丢字符，必须用 `paste`）
- **坐标系**：`app.click([x, y])` 用 2x 视网膜像素、窗口相对坐标；本机发送/停止按钮 2x 像素中心约 `(2097, 1388)`（窗口逻辑尺寸约 1346×761，截图 2692×1522）
- **停止链路曾全面失效（已定位并修复）**：根因是 `public/index.html` 以 `type="module"` 加载（严格模式），而 `stopped` 用 `var` 声明在 `send()` 函数体内，`stopGeneration()` 首句抛 `ReferenceError`，整条中止逻辑在第一步就中断——服务端从未收到 `/api/abort`。这解释了此前所有"点击无反应"现象：页脚按钮、顶栏按钮、`Escape`、`/stop` 四条通道全部失效，且与点击方式无关，并非输入投递问题。修复：`stopped` 提升为模块级作用域 + 读取循环补 `Promise.race([reader.read(), abortRace])`
- **对策（已落地）**：顶栏新增同功能停止按钮（生成时出现）；服务端 `POST /api/abort` 按 `requestId` 中止，前端双保险调用；自动化场景也可直接 `curl -XPOST localhost:8787/api/abort -H 'Content-Type: application/json' -d '{"requestId":"..."}'`
- **已知坑**：Chrome 页面会缓存旧 `index.html`，改动前端后必须真正重导航才生效；Mac 锁屏后 CUA 全部动作失效，需人工解锁
- **当前状态**：Computer Use 浏览器面被 admin 安全策略阻断（"admin-enforced policy could not be verified"），未绕行；视觉验证暂以 curl + 静态检查替代

## 当前状态（实测打通）

- `npm test` 25/25 通过（mock 上游，不花额度）；`npm run check` 真实 API 连通（Key 有效 + 模型目录 + 测试请求）
- LaunchAgent `com.modeltester.app`：running / managed，数据目录指向 `~/Library/Application Support/ModelTester`
- 开机自启开关往返验证通过：关闭→job 与 plist 移除、App 经保活子进程继续服务；开启→旧实例等 job 拉起，App 全程可达，实际不可用约 1s
- 启动器实测：同进程接管、无重复启动
- UI：零 emoji（全 Bundle 代码 `Extended_Pictographic` 零匹配），左上角为 ModelTester 品牌标识，模型选择器展示当前接入厂商标识；动画体系（aurora 光斑漂移、页头/页脚入场、消息入场、CSS 三点打字指示器、开关 knob、模型菜单 `@starting-style` 入场、停止按钮 pulse、对话框 scale+fade+背板模糊）遵循 `modern-web-guidance`；全局 `prefers-reduced-motion` 降级
- 多模态：实测图片理解正常，四种发图方式（附件按钮 / 粘贴 / 拖拽 / `/img 路径`）

## 常见问题

- `401 invalid_api_key`：Key 错或没填，去 `/key` 重新设置
- `402 insufficient_quota`：余额不足，平台充值或抢资源包
- `429`：请求太频繁，稍等重试
- 终端乱码：换用 iTerm2 / Terminal.app 均可，已用标准 ANSI 颜色
