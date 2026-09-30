# AGENTS.md — 文档站写作规约

> 适用范围：`docs-site/` 整棵树。与根 `AGENTS.md` 冲突时，根文件管工程纪律，本文件管**怎么写文档**。
> 基准：读者分层 / 术语表 / 格式决策，落到零依赖本地工具的实际形态。

## 0. 站点结构（单一事实来源）

- `zh/` 为主语言（默认 locale），`en/` 为镜像；两边结构必须一一对应（同文件名、同标题层级）
- 三类内容：`guide/`（怎么做）、`reference/`（速查：命令 / API / 配置）、`release-notes/`（发布笔记）
- 首页 `index.md` 只放定位、快速开始与特性摘要，不堆细节
- 终端设计规范的单一真值源是 `zh/reference/tui-design.md`（自 `docs/` 迁入）；`en/reference/tui-design.md` 是其摘要

## 1. 读者分层

| 读者 | 需求 | 对应页面 |
| --- | --- | --- |
| 新用户 | 五分钟跑起来 | `zh/guide/quick-start` |
| 日常用户 | 界面 / 命令 / 配置速查 | `reference/*` |
| 二次开发者 | 架构、协议、扩展点 | `zh/guide/agent-loop`、`providers`、`mcp` |
| 贡献者 | 工程纪律 | 根 `AGENTS.md` |

写作时先定「这页是写给谁的」，再决定深度：guide 允许讲原理，reference 只放可查的事实。

## 2. 术语表（全站统一，中英一致）

| 中文 | English | 说明 |
| --- | --- | --- |
| 轮次 | round | 一次模型请求 + 其工具调用 |
| 回合 | turn | 一次用户输入驱动的完整循环 |
| 模式 / Harness | harness | minimal / standard / ultimate 三档 |
| 提供方 | provider | 上游 API 供应方 |
| 技能 | skill | frontmatter + Markdown 的任务规范 |
| 子代理 | sub-agent | task 工具派发的受限会话 |
| 权限门控 | permission gate | policy.mjs 的 allow / ask / deny |
| 数据目录 | data directory | 三级回退的配置与会话根 |

禁止自造同义词（如把「轮次」写成「循环」指代 round）。

完整词汇表（含 Avoid 清单与文案规约）见 `zh/reference/terminology.md`，以该页为单一事实源。

## 3. 格式决策

- 命令、路径、标识符一律反引号；URL 用 `<https://…>` 或反引号（裸 URL 会被构建判死链）
- 表格优于长列表；每页一个 H1；H2/H3 承载目录
- 代码块必须标语言；命令行示例用 `bash`
- 中英页面**结构一致**，不做自由增删；英文页不是逐字翻译，允许按英文表达习惯重组句子
- 不写「如上所述」「下图所示」这类依赖位置的表述——页面会被检索与局部阅读

## 4. 写作纪律

- 文档描述**代码的真实行为**；发现文档与代码冲突，以代码为准并顺手修正文档（与根规约一致）
- 不写营销话术；数字（上限、阈值、端口）必须与代码一致，不确定就现查
- 新增行为进 `release-notes`：`npm run docs:notes` 从 git 历史生成，里程碑段落可手写补充
- 零 emoji；图标走站点 logo 与 GitHub 外链
- 本目录是**开发期依赖例外**（VitePress）：`docs-site/node_modules` 与构建产物不提交；后端与运行时零接触
