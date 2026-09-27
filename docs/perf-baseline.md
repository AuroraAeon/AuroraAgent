# 性能基线与方法论

本文件记录 AuroraAgent 的性能基准方法论与 6.0.0 → 6.1.0 的优化轨迹。数字为本地单次测量，
随机器与负载波动，只与自己的历史基线对比，**不作为提交门禁**。

## 方法论

对齐 MiniMax-code `docs/performance-ci.md` 的场景化基准思路，按本地工具形态落地：

- **场景化**：每个场景独立起一对进程（mock 上游 + 临时数据目录的 `web.mjs`），冷启动、
  互不污染；mock 参数随场景声明（见 `tools/perf/scenarios.mjs`）。
- **三场景**：
  - `startup`：服务起到 `/api/health` 就绪（最小请求体）
  - `upstream-100`：100 次 `/api/chat` 流式请求（每次约 4 KiB，64 字符分片，零延迟）——
    压速测底座 SSE 透传全链路
  - `history-300`：300 个 agent 工具轮（跨 5 个 turn 累积约 2.4 MiB 历史）——
    压上下文组装、转录增长与压缩路径
- **采样**：wall time、子进程 CPU（`process.resourceUsage`，微秒）、峰值 RSS（`ps` 50ms 轮询）；
  任一指不可用时记 `null`，不造假。
- **运行**：`npm run bench`（basic）、`npm run bench:smoke`（仅 startup，冒烟断言）、
  `npm run bench:full`（全套）；报告落 `docs/perf/<label>.{json,md}`。

## 6.0.0 优化前基线

| 场景 | wall | 峰值 RSS | 子进程 CPU（用户+系统） |
| --- | --- | --- | --- |
| startup | 118 ms | 56.5 MiB | 11.4 + 2.7 ms |
| upstream-100 | 130 ms | 102.7 MiB | 109.3 + 13.8 ms |
| history-300 | 479 ms | 157.2 MiB | 137.7 + 31.3 ms |

## 优化轨迹

| 提交 | 改动 | history-300 wall | 说明 |
| --- | --- | --- | --- |
| 基线 | — | 479 ms | — |
| `perf(stream)` | SSE 泵背压暂停/恢复 | 390 ms | 慢客户端场景杜绝上游帧在内存无限堆积；吞吐顺带受益 |
| `perf(tools)` | tools[] 拼装缓存 | 415 ms | 消除每轮 function 形状重建；本轮数字在噪声区间 |
| `perf(session)` | jsonl 投影缓存 | 389 ms | 侧栏列表 / 会话读取不再反复解析全量转录 |
| `perf(web)` | 静态资源 ETag/304 | 404 ms | SPA 外壳 no-store → no-cache；重复访问省产物传输 |

**关于连接复用**：`util/llm/provider.mjs` 走 Node 内置 `fetch`（undici 全局 dispatcher 默认
keep-alive），实测显式加 `http.Agent` 无增益，故不做这层改动——记录结论而非堆改动。

## 复现

```bash
npm run bench:smoke   # 冒烟：起进程对 + 出报告，退出 0 即设施可用
npm run bench:full -- --label my-baseline
```
