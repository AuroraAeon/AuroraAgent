# 性能基准报告 opt-static-304

- 时间: 2026-09-27T08:00:41.905Z
- 环境: Node v24.21.0 · darwin-arm64
- 套件: full

| 场景 | wall | 峰值 RSS | 子进程 CPU（用户+系统） | 细节 |
| --- | --- | --- | --- | --- |
| startup | 114 ms | 56.6 MiB | 11.3 + 2.4 ms | {"healthWaitMs":114} |
| upstream-100 | 119 ms | 105 MiB | 106.8 + 13.1 ms | {"healthWaitMs":109,"requests":100,"bytes":1602700,"frames":6600} |
| history-300 | 404 ms | 176.2 MiB | 118.9 + 26.6 ms | {"healthWaitMs":108,"turns":5,"targetRounds":300,"bytes":483708,"frames":1940} |

说明: 每场景独立冷启动进程对；数字随机器与负载波动，只与历史基线对比，不作门禁。
