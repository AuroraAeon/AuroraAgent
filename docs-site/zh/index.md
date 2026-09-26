---
layout: home

hero:
  name: AuroraAgent
  text: 本地 Agent 运行时
  tagline: 终端 + 网页双客户端共用同一套 Agent Loop；后端零依赖，只需 Node 18+；可打包为独立 macOS Application。
  actions:
    - theme: brand
      text: 快速开始
      link: /zh/guide/quick-start
    - theme: alt
      text: 终端设计规范
      link: /zh/reference/tui-design

features:
  - title: 双客户端同源
    details: 终端 TUI 与网页工作台共享同一套会话、工具、权限、用量账本与转录投影（util/agent/transcript.mjs）。
  - title: 零依赖后端
    details: 只用 Node 内置模块，ESM、无构建步骤；前端依赖仅限 web-ui/，产物随仓库提交，运行时零构建。
  - title: 权限先行
    details: 只读放行、写与执行需确认；权限三档（始终询问 / 必要时询问 / 完全自动）与会话级「总是允许」规则叠加。
  - title: 能力可扩展
    details: 技能（skills/）、子代理派发（task）、MCP 服务器（实验特性）统一走同一工具接口与权限门控。
---

## 三十秒了解

```bash
npm run chat     # 终端 Agent 会话
npm run web      # 网页工作台 http://localhost:8787
```

当前接入厂商：**美团 LongCat-2.5-Preview**（OpenAI / Anthropic 双协议兼容）。Base URL、模型目录、Key 全部是配置项——接入新厂商不改架构；更常见的路径是在设置页直接添加自定义提供方。
