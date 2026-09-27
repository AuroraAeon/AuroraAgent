# 性能基准报告 baseline-6.0.0

- 时间: 2026-09-27T07:56:05.333Z
- 环境: Node v24.21.0 · darwin-arm64
- 套件: full

| 场景 | wall | 峰值 RSS | 子进程 CPU（用户+系统） | 细节 |
| --- | --- | --- | --- | --- |
| startup | 118 ms | 56.5 MiB | 11.4 + 2.7 ms | {"healthWaitMs":118} |
| upstream-100 | 130 ms | 102.7 MiB | 109.3 + 13.8 ms | {"healthWaitMs":112,"requests":100,"bytes":1602700,"frames":6600} |
| history-300 | 479 ms | 157.2 MiB | 137.7 + 31.3 ms | {"healthWaitMs":111,"turns":5,"targetRounds":300,"bytes":483709,"frames":1940} |

说明: 每场景独立冷启动进程对；数字随机器与负载波动，只与历史基线对比，不作门禁。
