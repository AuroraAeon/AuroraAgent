---
layout: home

hero:
  name: AuroraAgent
  text: Local Agent Runtime
  tagline: Terminal + web clients share one Agent Loop; zero-dependency backend on Node 18+; ships as a standalone macOS Application.
  actions:
    - theme: brand
      text: Quick Start
      link: /en/guide/quick-start
    - theme: alt
      text: Terminal Design Spec
      link: /en/reference/tui-design

features:
  - title: One runtime, two clients
    details: Terminal TUI and web workbench share sessions, tools, permissions, usage ledger and transcript projection (util/agent/transcript.mjs).
  - title: Zero-dependency backend
    details: Node built-ins only, ESM, no build step; frontend dependencies are confined to web-ui/ and its build is committed — zero build at runtime.
  - title: Permissions first
    details: Read-only by default, writes and execution need consent; three permission modes layered with session-level always-allow rules.
  - title: Extensible
    details: Skills, sub-agent dispatch (task) and MCP servers (experimental) all flow through one tool interface.
---

## In thirty seconds

```bash
npm run chat     # terminal agent session
npm run web      # web workbench at http://localhost:8787
```

Current built-in provider: **Meituan LongCat-2.5-Preview** (OpenAI / Anthropic dual protocol). Base URL, model catalog and API key are all configuration — adding a provider changes no architecture.
