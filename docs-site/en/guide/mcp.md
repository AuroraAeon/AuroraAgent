# MCP Servers (Experimental)

AuroraAgent ships a [Model Context Protocol](https://modelcontextprotocol.io) client (`util/mcp/`, pure Node, JSON-RPC 2.0). Connected servers expose tools as `mcp__<server>__<tool>` in the agent toolbox, gated by the same permission policy (ask by default).

## Enable

```bash
AURORAAGENT_EXPERIMENTAL_MCP=1 npm run web
```

Experimental flags: `AURORAAGENT_EXPERIMENTAL_<NAME>` for one, `AURORAAGENT_EXPERIMENTAL_FLAG` for all; off by default.

## Management

- **Web**: Settings → MCP servers — add (stdio command + args, or HTTP + SSE endpoint), test connection, see tool counts and status, delete
- **Terminal**: `/mcp` status command
- Config lands in `<dataDir>/mcp.json` (atomic write, never committed)

A failing server never blocks the others; its error is surfaced in the status.
