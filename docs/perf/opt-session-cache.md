# 性能基准报告 opt-session-cache

- 时间: 2026-09-27T07:59:20.897Z
- 环境: Node v24.21.0 · darwin-arm64
- 套件: full

| 场景 | wall | 峰值 RSS | 子进程 CPU（用户+系统） | 细节 |
| --- | --- | --- | --- | --- |
| startup | 115 ms | 56.6 MiB | 11.2 + 1.7 ms | {"healthWaitMs":115} |
| upstream-100 | 118 ms | 103.8 MiB | 107.7 + 13.2 ms | {"healthWaitMs":110,"requests":100,"bytes":1602700,"frames":6600} |
| history-300 | 389 ms | 160.2 MiB | 113.1 + 26.6 ms | {"healthWaitMs":109,"turns":5,"targetRounds":300,"bytes":483707,"frames":1940} |

说明: 每场景独立冷启动进程对；数字随机器与负载波动，只与历史基线对比，不作门禁。
