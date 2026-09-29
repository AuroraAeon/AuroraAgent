# 数据目录与机密文件

## 数据目录三级回退

`util/config.mjs` 单一实现，`web.mjs` / `chat.mjs` / `check.mjs` / `tools/install-service.mjs` 共用：

1. `AURORAAGENT_DATA_DIR` 环境变量（LaunchAgent 显式指定）
2. 同目录已存在 `auroraagent.config.json` → 用当前目录（源码开发态）
3. 否则 `~/Library/Application Support/AuroraAgent`（App 态，数据与 Bundle 解耦）

5.0.0 起旧命名数据目录一次性迁移：旧目录整体搬迁含 Key 保留、旧 config 就地改名。

## 机密文件永不进 git

`auroraagent.config.json`、`usage.jsonl`、`providers.json`、`sessions/`。Key 泄露即安全事故。

## 依赖例外

- 后端零依赖：只用 Node 18+ 内置模块，无构建步骤。
- 前端依赖仅限 `web-ui/`（react / react-dom / katex / vite / typescript / @vitejs/plugin-react / @types/*），构建产物随仓库提交在 `public/app/`，后端与 Bundle 运行时不接触 node_modules。
- 文档站依赖例外仅 `docs-site/`（VitePress 唯一依赖），`docs-site/node_modules` 与构建产物不提交。
