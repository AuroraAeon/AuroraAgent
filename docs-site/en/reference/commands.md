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

`/new` `/sessions` `/model` `/harness` `/think` `/temp` `/max` `/key` `/plan` `/goal` `/queue` `/cron` `/btw` `/mcp` `/help` `/quit`; every skill gets `/<skill-name>`.

- `/goal` family (one parser for the terminal and the web Composer): `/goal` (no argument shows status) / `/goal <objective>` (create; rewrites the text when a goal is unfinished, accepts a trailing `budget=50K`) / `/goal budget=50K` (change the budget, `clear` removes the cap; the legacy `/goal budget 50000` is equivalent) / `/goal edit` (fill the objective back for another pass) / `/goal clear` (remove; `cancel` / `delete` are aliases) / `/goal pause|resume|stop` / `/goal help`: goal-mode user operations (also accepted while a turn is generating on the web, routed straight to the goal REST surface), see the [Goal Mode guide](/en/guide/goal-mode)
- `/queue`: message queue (messages sent while a turn is generating line up automatically and are relayed after the previous one settles). `/queue` lists waiting messages (position + summary), `/queue send <n>` sends one now, `/queue drop <n>` removes one, `/queue clear` clears the queue; see the [Message Queue guide](/en/guide/message-queue)
- `/cron`: scheduled tasks (a turn runs in the current session when due). A bare `/cron` lists, `/cron add <name> | <expression> | <prompt>` creates one (the expression is a five-field cron or `every <minutes>`), `/cron remove <id>` deletes, `/cron run <id>` runs now, `/cron on|off <id>` toggles; see the [Scheduled Tasks guide](/en/guide/scheduled-tasks)
- `/btw <question>`: side conversation that inherits the current session history, never persisted and absent from the session list; `Ctrl+/` toggles, `Ctrl+C` on an empty side prompt discards

## Runtime tools (model side)

`read_file` `list_dir` `grep` `glob` `web_fetch` `write_file` `edit_file` `shell` `todo` `skill` `task` `create_goal` `update_goal` `get_goal` (goal mode, Standard / Ultimate only) `cron` (scheduled tasks, Standard / Ultimate only, asks by default) `computer_use` (screen control, Ultimate only, asks by default); MCP tools join as `mcp__<server>__<tool>`. See the [Screen Control guide](/en/guide/screen-control).
