# 常用命令与服务生命周期

## 常用命令

| 命令 | 用途 | 注意 |
| --- | --- | --- |
| `npm test` | e2e 测试（mock 上游） | 每次提交前必跑；不花真钱 |
| `npm run check` | 真实 API 连通自检 | 会花少量钱 |
| `PORT=8788 npm run web` | 开发态网页服务 | 避开 8787 正式端口 |
| `npm run dev:web` | 前端开发态（vite 5173） | 只动 `web-ui/` 时用 |
| `npm run build:web` | 构建前端产物到 `public/app/` | 改了 `web-ui/` 后必跑并提交产物 |
| `npm run typecheck:web` | `web-ui` 类型检查 | CI 不装前端依赖，本地改 `web-ui/` 后跑 |
| `npm run chat` | 终端 Agent 会话 | 与网页共用 Loop / 会话 / 账本 |
| `npm run bench` / `bench:smoke` / `bench:full` | 性能基准 | 本地回归参考，不作 CI 门禁 |
| `npm run service` / `service:status` / `service:remove` | 安装 / 查看 / 卸载 LaunchAgent | — |
| `npm run publish` | 构建前端 + 打 .app + 重启服务 | 只能在 Bundle 外的源码目录执行 |

调试：`LOG_LEVEL=debug npm run web`；常驻服务日志在 `~/Library/Logs/com.auroraagent.app.log`。

## 服务生命周期

- 安装：`npm run service` 生成并加载 `~/Library/LaunchAgents/com.auroraagent.app.plist`。
- 状态：`npm run service:status`；卸载：`npm run service:remove`。
- plist 生成规则在 `tools/install-service.mjs` 与 `web.mjs` 内置逻辑两处，改动必须同步。
- 打包 `.app` 走 `tools/build-app.mjs`（含自保护）。
