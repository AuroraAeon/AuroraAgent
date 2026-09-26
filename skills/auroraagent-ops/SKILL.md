---
name: auroraagent-ops
description: AuroraAgent 项目自身操作速查：数据目录、常用命令、服务生命周期、测试与发布规约、禁止事项
---

# AuroraAgent 自身操作技能

操作用户本机的 AuroraAgent（本地 Agent 运行时：终端 + 网页双客户端，后端零依赖）时遵循本规范。

## 规则

- 数据目录三级回退：`AURORAAGENT_DATA_DIR` 环境变量 > 同目录已有 `auroraagent.config.json`（源码开发态）> `~/Library/Application Support/AuroraAgent`（App 态）。数据与 Bundle 解耦。
- 机密文件永不进 git：`auroraagent.config.json`、`usage.jsonl`、`providers.json`、`sessions/`。Key 泄露即安全事故。
- 后端只用 Node 内置模块、ESM `.mjs`、无构建步骤；前端依赖仅限 `web-ui/`，产物随仓库提交在 `public/app/`。
- 改 `web-ui/` 源码后必须 `npm run build:web` 并提交 `public/app/` 产物（运行时零构建的保证）。
- 版本号只改 `package.json` 一处；品牌名 AuroraAgent 仅作品牌与文档名，包名 / Bundle ID / LaunchAgent label / 数据目录约定不变。
- 提交规约：小改动、快提交、勤推送；`npm test` 全绿才准提交；中文提交信息。

## 词表

- harness：minimal / standard / ultimate 三档模式契约（系统提示、工具集、轮次上限 1 / 24 / 64、压缩阈值）。
- turn：一次用户请求驱动的多轮模型循环；tool_calls 为空或触顶即结束。
- provider：内置 LongCat（只读，内存合成）或用户自定义提供方（`providers.json`）。
- LaunchAgent：`com.auroraagent.app` 常驻服务，日志落 `~/Library/Logs/com.auroraagent.app.log`。
- 端口冲突时 web.mjs 按 1 秒间隔重试最多 60 次——这是设置页切换自启时新旧实例平滑交接的基石，不要改。

## 工作流

1. 改代码前先读 `AGENTS.md`（项目宪法）与相关模块头注。
2. 一个可独立验证的小改动 → `npm test` 全绿 → `git add <具体文件>` → 中文 commit → push。
3. 触及上游行为（请求格式、错误映射、模型目录解析、tools 拼装）时额外跑 `npm run check`（会花少量钱）。
4. 发布：`npm run publish`（构建前端 + 打 .app + 重启服务），只能在 Bundle 外的源码目录执行。

## 禁止

- 禁止在 Bundle 内执行 `npm run app:build`（构建会先删掉整个 .app）。
- 禁止 `rm -rf` 删目录；用 Node `fs.rmSync` 并二次确认路径。
- 禁止触碰 `~/Documents/cc-switch`（其他项目的仓库）。
- 禁止改动厂商事实层：模型 ID、显示名映射规则、价格常量 `PRICE`、纯色测试结论。
- 禁止在产品 UI 里加 emoji；图标一律内联 SVG 或 `public/vendors/*.svg`。
- 禁止用 `--force` 绕过推送失败，禁止改写已推送的历史。
