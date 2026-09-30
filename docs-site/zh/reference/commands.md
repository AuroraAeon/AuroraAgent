# 命令与斜杠命令

## npm 脚本

| 命令 | 用途 |
| --- | --- |
| `npm run chat` | 终端 Agent 会话（`-p "问题"` 单次提问） |
| `npm run web` | 网页工作台（默认 8787） |
| `npm test` | e2e 测试（mock 上游，不花真钱） |
| `npm run check` | 真实上游连通自检（花少量钱） |
| `npm run dev:web` | 前端开发态（vite 5173，`/api` 代理 8787） |
| `npm run build:web` | 构建前端产物到 `public/app/` |
| `npm run service` / `service:status` / `service:remove` | LaunchAgent 安装 / 状态 / 卸载 |
| `npm run publish` | 构建前端 + 打 `.app` + 重启服务（仅限 Bundle 外源码目录） |
| `npm run color` | 纯色识别回归测试（真实调用） |
| `npm run docs:dev` / `docs:build` / `docs:notes` | 文档站开发 / 构建 / 生成发布笔记 |
| `npm run bench` / `bench:smoke` / `bench:full` | 性能基准（basic / smoke / full 三套件，本地回归参考，非门禁） |

## 终端斜杠命令

`/new` `/sessions` `/model` `/harness` `/think` `/temp` `/max` `/key` `/plan` `/goal` `/queue` `/cron` `/btw` `/mcp` `/help` `/quit`；每个技能自动生成 `/<技能名>`。

- `/goal` 家族（终端与网页 Composer 同解析）：`/goal`（无参看状态）/ `/goal <目标内容>`（设立；有未完成目标时改写文本，可带 `budget=50K`）/ `/goal budget=50K`（改预算，`clear` 清除；旧式 `/goal budget 50000` 等价）/ `/goal edit`（目标文本回填续编）/ `/goal clear`（移除；`cancel` / `delete` 为同义别名）/ `/goal pause|resume|stop` / `/goal help`：目标模式用户面操作（网页端生成中亦可输入，直走 goal REST），详见 [Goal 模式指南](/zh/guide/goal-mode)
- `/queue`：消息队列（生成中继续发的消息自动排队，前一条结算后接力）。`/queue` 列出等待中的消息（位置 + 摘要）、`/queue send <序号>` 立即发送、`/queue drop <序号>` 移除、`/queue clear` 清空；详见 [消息队列](/zh/guide/message-queue)
- `/cron`：定时任务（到点在当前会话跑一轮 Agent）。`/cron` 无参列出、`/cron add <名称> | <表达式> | <到期内容>` 新建（表达式写 cron 五段或 `every <分钟>`）、`/cron remove <id>` 删除、`/cron run <id>` 立即跑、`/cron on|off <id>` 启停；详见 [定时任务](/zh/guide/scheduled-tasks)
- `/btw <问题>`：侧边对话，继承当前会话历史开聊，不落盘不进会话列表；`Ctrl+/` 切换、空提示符 `Ctrl+C` 丢弃

## 运行时工具（模型侧）

`read_file` `list_dir` `grep` `glob` `web_fetch` `write_file` `edit_file` `shell` `todo` `skill` `task`（子代理）`create_goal` `update_goal` `get_goal`（目标模式，仅 Standard / Ultimate）`cron`（定时任务，仅 Standard / Ultimate，默认要权限）`computer_use`（屏幕操作，仅 Ultimate，默认要权限）；MCP 工具以 `mcp__<服务器>__<工具>` 加入。屏幕操作见 [屏幕操作指南](/zh/guide/screen-control)。
