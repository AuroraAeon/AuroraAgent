# Quick Start

## Requirements

- macOS (relies on LaunchAgent and `~/Library` conventions)
- Node 18+, nothing else

## API key

Create a key at <https://longcat.chat/platform/api_keys>, then pick one:

1. `/key sk-yourKey` inside the terminal session (saved automatically)
2. `export AURORAAGENT_API_KEY="sk-yourKey"`
3. the `apiKey` field of the config file

## Two clients

| Command | Form | For |
| --- | --- | --- |
| `npm run chat` | Terminal TUI (`util/agent/terminal.mjs`) | keyboard flow, SSH |
| `npm run web` | Web workbench (React build in `public/app/`) | rich rendering: diffs, math, tool cards |

Both share the same data directory, sessions and usage ledger — a session started in the terminal is visible and resumable on the web.

## First task

Ask "list the files in the workspace" in either client. You will see the model call `list_dir` (read-only, allowed by default), the tool card with params and result, and a per-round usage footnote with tokens and cost. Write and shell tools ask for permission first: **Allow once** / **Always allow** (session rule) / **Deny** (the reason goes back to the model and the loop continues).

## Self-check

```bash
npm run check        # real upstream smoke (costs a tiny amount)
npm test             # e2e tests against a mock upstream
```
