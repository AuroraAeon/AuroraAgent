# 快速开始

## 环境要求

- macOS（依赖 LaunchAgent 与 `~/Library` 目录约定）
- Node 18+，无其他依赖

## 安装 Key

没配 Key 时按提示操作：打开 <https://longcat.chat/platform/api_keys> 创建 Key，然后三选一：

1. 终端对话里输入 `/key sk-你的Key`（自动保存到配置）
2. `export AURORAAGENT_API_KEY="sk-你的Key"`
3. 写进配置文件的 `apiKey` 字段

## 两种客户端

| 命令 | 形态 | 适用 |
| --- | --- | --- |
| `npm run chat` | 终端 TUI（`util/agent/terminal.mjs`） | 键盘流工作、SSH 场景 |
| `npm run web` | 网页工作台（React 产物，`public/app/`） | 富渲染：diff、公式、工具卡 |

两端共用同一套数据目录、会话、用量账本——在终端开的会话，网页里能看到并继续。

## 第一个任务

打开任意一端，输入「看看工作目录里有什么文件」。你会看到：

1. 模型决定调用 `list_dir`（只读工具，默认放行）
2. 工具卡片展示参数与结果
3. 模型基于结果给出答复，底部是本轮 tokens 与费用脚注

如果模型要写文件或执行命令，会先弹出权限卡：**允许**（仅这一次）/ **总是允许**（本会话后续同类放行）/ **拒绝**（结果回给模型，循环继续）。

## 自检与排障

```bash
npm run check        # 真实上游连通自检（Key → 模型列表 → 一条最小请求）
npm test             # e2e 测试（mock 上游，不花真钱）
```

常驻服务日志在 `~/Library/Logs/com.auroraagent.app.log`；调试时 `LOG_LEVEL=debug npm run web`。
