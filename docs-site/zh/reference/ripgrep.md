# 检索加速（ripgrep）

`grep` 与 `glob` 两个运行时工具优先调用 [ripgrep](https://github.com/BurntSushi/ripgrep)，没装时自动回退到纯 JS 遍历。功能两条路径完全一致，差别只在速度：大仓库上差一个量级。

## 解析顺序

`util/ripgrep.mjs` 按固定顺序找可用的 `rg`：

1. `tools/bin/<架构>/rg`——随仓库提交的捆绑二进制（只覆盖 macOS 的 arm64 与 x64 两个架构）
2. `PATH` 里的 `rg`——用户自己装的版本
3. 都找不到：回退纯 JS 遍历（功能不缺，只是慢）

## 捆绑二进制

零依赖底线只允许「随仓库提交的二进制」这一种例外，ripgrep 是唯一一个。

```bash
node tools/download-ripgrep.mjs            # 只下当前架构
node tools/download-ripgrep.mjs --all      # 下全部 macOS 架构（arm64 + x64）
node tools/download-ripgrep.mjs 14.1.1     # 指定版本（默认 14.1.1）
```

打 `.app` 时拷贝清单包含 `tools/bin`，Bundle 里随行。下载器本身零依赖：https 直连 + 手动跟随 302 + `node:zlib` 解 gzip + 手写 tar 头解析。

## 两条路径行为一致

回退路径与 ripgrep 路径给出相同答案，靠的是 ripgrep 侧显式 `--no-ignore --hidden`：忽略规则不由 ripgrep 判，而是由 `util/agent/tools.mjs` 单一真值源负责（依赖目录黑名单 + `.auroraagentignore` 禁入区）。否则用户装没装 rg、装什么版本，会改变模型能看到哪些文件。

环境变量 `AURORAAGENT_NO_RIPGREP=1` 强制走回退路径——用于比对两条路径的答案，也让测试真跑回退实现。

## 忽略文件

工作目录根放一份 `.auroraagentignore` 就能把 `.env`、`node_modules/`、密钥目录挡在模型的读写工具之外，比逐条对模型讲「别动那个文件」可靠。语法是 gitignore 子集：`#` 注释、`!` 取反、结尾 `/` 表示目录、`*` `**` `?` `[]`、不含斜杠按基名任意深度匹配、`!include <file>` 递归引入（拒绝穿越到工作目录外）。文件改动 150ms 防抖热加载，无需重启。命中时工具结果带锁定标记与中文原因。配置段 `ignore.enabled` 设为 `false` 可整体关闭（缺省开）。
