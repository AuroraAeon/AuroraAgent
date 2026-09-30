# 定时任务

让 AuroraAgent 在指定时间替你做一件事：到点后在目标会话里把 `prompt` 当作用户消息跑一轮 Agent。语义本地化 OpenBitFun v1.0.2 的 #3149，零依赖实现在 `util/jobs/`（`cron-expr.mjs` / `store.mjs` / `schedule.mjs` / `bus.mjs` / `http.mjs`）与 `util/agent/cron-tool.mjs`。

## 两种排程

| 形态 | 写法 | 说明 |
| --- | --- | --- |
| cron 五段 | `分 时 日 月 周`，如 `30 9 * * 1-5` | 支持星号 / 单值 / 区间 / 步进 / 逗号列表；周日 `0` 与 `7` 等价；日与周都是具体值时按 Vixie 的 OR 语义（两者其一命中即跑） |
| 固定间隔 | `every <分钟>` | 间隔下限 60 秒、上限 366 天 |

无解的表达式（如 `0 0 30 2 *`，2 月没有 30 日）语法合法但永远不触发：任务照建，`nextRunAt` 为空，界面显示「已停用」之外的「无下次运行时间」，改对表达式才会重新武装。

## 三种操作入口

| 入口 | 能做什么 |
| --- | --- |
| 模型 | `cron` 工具：`add` / `update` / `list` / `remove` / `run` / `get_time`（仅 Standard / Ultimate；每次调用都要权限确认，因为到期会花 token） |
| 终端 | `/cron` 家族：`/cron add <名称> \| <表达式> \| <到期内容>`、`/cron remove <id>`、`/cron run <id>`、`/cron on\|off <id>`、无参列出 |
| 网页 | 设置页「定时任务」面板 + `GET/POST /api/jobs`、`DELETE /api/jobs/:id`、`POST /api/jobs/:id/run\|toggle` |

三个入口共用同一份 `<数据目录>/jobs.json`（原子落盘 + `updatedAt` 纪元严格推进），单条上限 200 个任务。任务形状：`{ id, name, sessionId, prompt, schedule, enabled, createdAt, updatedAt, lastRunAt, lastStatus, lastError, nextRunAt }`。

## 调度与单实例

进程内 1 秒 ticker 挑选到期任务，单飞执行（同一任务不会并发跑两份）。到期执行走的是普通 turn 入口：目标会话忙就进消息队列排队，空闲才直接开跑。

端口交接期可能出现两个实例短暂共存，因此调度权由 `<数据目录>/jobs.lock` 单实例 owner 锁保证：`O_EXCL` 创建 + PID 活性探活 + 心跳续约，抢不到锁的实例按退避重试，绝不会双跑。服务停机期间到期的任务先记 `missed`，下次启动在 6 小时宽限内补跑一次，超宽限则跳过。

## 变更信号

建了任务界面却不刷新是个老问题。cron 工具、REST、到期记账三条路径的变更都经 `util/jobs/bus.mjs` 扇出 `jobs_changed`：turn SSE 订阅方、`GET /api/jobs/events` 长连接、设置面板与终端 `/cron` 都据此重读，不等你切一遍分类才发现列表是旧的。
