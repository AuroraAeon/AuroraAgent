# 性能基准报告 opt-tools-cache

- 时间: 2026-09-27T07:58:38.530Z
- 环境: Node v24.21.0 · darwin-arm64
- 套件: full

| 场景 | wall | 峰值 RSS | 子进程 CPU（用户+系统） | 细节 |
| --- | --- | --- | --- | --- |
| startup | 114 ms | 56.5 MiB | 11.3 + 1.5 ms | {"healthWaitMs":114} |
| upstream-100 | 114 ms | 102.7 MiB | 103.9 + 12 ms | {"healthWaitMs":110,"requests":100,"bytes":1602700,"frames":6600} |
| history-300 | 415 ms | 169.7 MiB | 123 + 28.3 ms | {"healthWaitMs":109,"turns":5,"targetRounds":300,"bytes":483707,"frames":1940} |

说明: 每场景独立冷启动进程对；数字随机器与负载波动，只与历史基线对比，不作门禁。
