# Commands & Slash Commands

## npm scripts

| Command | Purpose |
| --- | --- |
| `npm run chat` | terminal agent session (`-p "q"` for one-shot) |
| `npm run web` | web workbench (port 8787) |
| `npm test` | e2e tests against a mock upstream |
| `npm run check` | real upstream smoke (costs a tiny amount) |
| `npm run dev:web` | frontend dev server (vite 5173, `/api` proxied to 8787) |
| `npm run build:web` | build frontend into `public/app/` |
| `npm run service` / `service:status` / `service:remove` | LaunchAgent install / status / remove |
| `npm run publish` | build frontend + `.app` + restart service (source dir outside the bundle only) |
| `npm run color` | solid-color regression (real calls) |
| `npm run docs:dev` / `docs:build` / `docs:notes` | docs site dev / build / generate release notes |
| `npm run bench` / `bench:smoke` / `bench:full` | performance benchmarks (basic / smoke / full suites; local regression reference, not a gate) |

## Terminal slash commands

`/new` `/sessions` `/model` `/harness` `/think` `/temp` `/max` `/key` `/plan` `/goal` `/btw` `/mcp` `/help` `/quit`; every skill gets `/<skill-name>`.

- `/goal` family (one parser for the terminal and the web Composer): `/goal` (no argument shows status) / `/goal <objective>` (create; rewrites the text when a goal is unfinished, accepts a trailing `budget=50K`) / `/goal budget=50K` (change the budget, `clear` removes the cap; the legacy `/goal budget 50000` is equivalent) / `/goal edit` (fill the objective back for another pass) / `/goal clear` (remove) / `/goal pause|resume|stop` / `/goal help`: goal-mode user operations, see the [Goal Mode guide](/en/guide/goal-mode)
- `/btw <question>`: side conversation that inherits the current session history, never persisted and absent from the session list; `Ctrl+/` toggles, `Ctrl+C` on an empty side prompt discards

## Runtime tools (model side)

`read_file` `list_dir` `grep` `glob` `web_fetch` `write_file` `edit_file` `shell` `todo` `skill` `task` `create_goal` `update_goal` `get_goal` (goal mode, Standard / Ultimate only); MCP tools join as `mcp__<server>__<tool>`.
