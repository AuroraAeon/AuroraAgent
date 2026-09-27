# 性能基准报告 opt-stream-backpressure

- 时间: 2026-09-27T07:57:06.848Z
- 环境: Node v24.21.0 · darwin-arm64
- 套件: full

| 场景 | wall | 峰值 RSS | 子进程 CPU（用户+系统） | 细节 |
| --- | --- | --- | --- | --- |
| startup | 113 ms | 56.4 MiB | 10.9 + 2 ms | {"healthWaitMs":113} |
| upstream-100 | 124 ms | 103.4 MiB | 107.1 + 14.2 ms | {"healthWaitMs":109,"requests":100,"bytes":1602700,"frames":6600} |
| history-300 | 390 ms | 160.6 MiB | 114.3 + 26.6 ms | {"healthWaitMs":108,"turns":5,"targetRounds":300,"bytes":483707,"frames":1940} |

说明: 每场景独立冷启动进程对；数字随机器与负载波动，只与历史基线对比，不作门禁。
