# 自定义提供方

除内置的美团 LongCat 外，可添加任意 **OpenAI 兼容** 或 **Anthropic Messages** 上游。

## 添加

网页设置 → 提供方 → 添加自定义提供方：

1. 填 Base URL 与 API Key（密钥格式实时校验）
2. 「发现模型」拉取上游模型目录（只读），勾选要加入的模型
3. 保存后模型选择器按提供方分组展示，`/api/chat` 与 Agent Loop 均可选用

## 路由规则

- 显式传 `provider` 优先；未传时按模型 ID 反查所属提供方；未知模型仍回退内置提供方
- 内置提供方只读；自定义提供方存储于 `<数据目录>/providers.json`（原子落盘，含密钥，不提交仓库）

## 协议差异

`util/wire.mjs` 负责把内部统一的 OpenAI 形状（含 `tool_calls`）翻译成目标协议：Anthropic 线路的 `system` 抽离、`tool_use` / `tool_result` 块转换、SSE 帧翻译（`input_json_delta` → `tool_calls` delta），前端与 Loop 因此只需认识一种帧格式。
