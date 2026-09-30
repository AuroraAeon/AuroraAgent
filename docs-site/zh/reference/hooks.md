# 事件钩子

事件钩子把「可执行脚本」挂到 Agent 生命周期的各个节点上：脚本经标准输入收到事件数据（JSON），经标准输出回一段控制指令。适合做格式化检查、敏感操作拦截、把会话动态同步进项目文档这类「每次都要做、但不想每次都对模型讲一遍」的事。

实验特性，默认关闭：设环境变量 `AURORAAGENT_EXPERIMENTAL_HOOKS=1` 后重启服务生效。

## 放置即生效

不写配置文件、不写注册表——**文件名即事件名**，放进目录即生效，删掉即失效。

| 来源 | 路径 | 优先级 |
| --- | --- | --- |
| 项目钩子 | `<工作目录>/.auroraagent/hooks/` | 高（可随仓库共享给团队） |
| 个人钩子 | `<数据目录>/hooks/` | 低（跨项目常驻） |

同名时项目钩子覆盖个人钩子。后缀决定解释器：无后缀（文件自身可执行）/ `.sh` / `.bash` / `.zsh` / `.mjs` / `.cjs` / `.js` / `.py`。钩子脚本不放子目录。

例：`<工作目录>/.auroraagent/hooks/PreToolUse.sh` 在每次工具执行前触发；`PostToolUse.mjs` 在每次工具执行后触发。事件名大小写与下划线不敏感，`PreToolUse` 与 `pre_tool_use` 等价。

## 十个事件

| 事件名 | 触发时机 | 可用控制 |
| --- | --- | --- |
| `prompt_submit` | 用户提交，记录落盘前 | 改写输入 / 追加上下文 / 取消 |
| `turn_start` | 回合开始 | 追加上下文 / 取消 |
| `round_start` | 模型轮开始 | 追加上下文 |
| `pre_tool_use` | 工具执行前 | 取消 / 转权限确认 / 改写入参 |
| `post_tool_use` | 工具执行后 | 追加上下文 |
| `pre_compact` | 上下文压缩前 | 取消本次压缩 |
| `turn_end` | 回合正常结束 | 追加上下文 |
| `turn_error` | 回合失败 | 追加上下文 |
| `turn_abort` | 用户中止 | 追加上下文 |
| `session_shutdown` | 进程退出 | 仅可经 `/hooks test` 手动触发 |

`session_shutdown` 没有自动接入点：进程退出时无法可靠地 spawn 子进程，只供手动测试。

## 事件数据（stdin）

payload 是经 stdin 送入的一行 JSON。公共字段所有事件都有：`hookName` / `timestamp` / `sessionId` / `turnId` / `round` / `workspace` / `agentId` / `parentAgentId`；事件专属数据（工具名与参数、压缩原因等）按名挂在固定键上。环境变量 `AURORAAGENT_HOOK_EVENT` 也带当前事件名。

## 控制指令（stdout）

脚本退出码为 0 时，标准输出被解析成 JSON 控制指令。JSON 前后打印的日志会被忽略（取最后一段能解析的）。

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `cancel` | `true` | 取消这次动作（工具不执行 / 压缩跳过 / 回合中止）；粘性，任一钩子说取消即取消 |
| `review` | `true` | 转交权限通道，用户显式确认后才继续（复用既有的权限门控） |
| `context` | 字符串 | 追加进上下文的文本；所有钩子合计上限 50KB，超限从最旧的开始砍 |
| `overrideInput` | 对象 | 改写入参（工具参数 / 用户输入）；后者覆盖前者 |
| `systemPrompt` | 字符串 | 追加进系统提示 |

### 退出码语义

| 退出码 | 行为 |
| --- | --- |
| `0` | 正常，按解析出的控制指令行事 |
| `2` | 显式取消，stderr 首行作原因 |
| 其它非零 | 脚本自己失败了：记日志、按「无控制」继续（fail-open，钩子写错不该让回合崩掉） |

单个钩子失败或超时不影响其它钩子，也不影响这一轮。

## 超时与资源

- 超时默认 10 秒、封顶 60 秒；hook 是锦上添花，没有资格把用户挂死
- 标准输出超过 1MB 判失败；标准错误保留最后 256KB
- 回合中断时级联杀掉在跑的钩子子进程
- 零依赖 spawn，不用 shell 字符串拼命令（脚本路径含空格或怪字符时 shell 注入是真的会出事）

## 查看与测试

| 入口 | 用法 |
| --- | --- |
| 终端 | `/hooks` 列出已发现的钩子；`/hooks events` 看十个事件说明；`/hooks test <事件名>` 用构造的 payload 手动触发一次 |
| 网页 Composer | `/hooks` 家族命令，与终端同解析 |
| HTTP | `GET /api/agent/hooks?workspace=` 回报已发现钩子、门控状态与事件词表 |

门控关闭时，`/hooks` 给的是开启指引而不是空列表——「没配钩子」和「钩子被关掉了」是两件事，用户分得清。

## 示例

`<数据目录>/hooks/PostToolUse.mjs`：每次工具执行后，把改动同步进变更日志。

```javascript
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  const payload = JSON.parse(raw);
  const tool = payload.tool || '';
  if (tool === 'write_file' || tool === 'edit_file') {
    process.stdout.write(JSON.stringify({ context: '本次改动需同步更新 CHANGELOG。' }));
  }
});
```
