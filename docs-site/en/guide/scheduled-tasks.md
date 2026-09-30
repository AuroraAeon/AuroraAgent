# Scheduled Tasks

Let AuroraAgent do something at a given time: when the task comes due, its `prompt` is injected as a user message into the target session and one Agent turn runs. Localized from OpenBitFun v1.0.2 #3149, implemented with zero dependencies in `util/jobs/` (`cron-expr.mjs` / `store.mjs` / `schedule.mjs` / `bus.mjs` / `http.mjs`) and `util/agent/cron-tool.mjs`.

## Two schedule forms

| Form | Syntax | Notes |
| --- | --- | --- |
| Five-field cron | `min hour day month weekday`, e.g. `30 9 * * 1-5` | Supports wildcards, single values, ranges, steps and comma lists; weekday `0` and `7` are equivalent; when both day and weekday are restricted, Vixie OR semantics apply (either match fires) |
| Fixed interval | `every <minutes>` | Minimum 60 seconds, maximum 366 days |

An unsatisfiable expression (such as `0 0 30 2 *`, since February has no 30th) is syntactically valid but never fires: the task is still created, `nextRunAt` stays empty, and the UI shows no next run until you fix the expression.

## Three entry points

| Entry | What it does |
| --- | --- |
| Model | the `cron` tool: `add` / `update` / `list` / `remove` / `run` / `get_time` (Standard / Ultimate only; every call needs confirmation because a due run spends tokens) |
| Terminal | the `/cron` family: `/cron add <name> \| <expression> \| <prompt>`, `/cron remove <id>`, `/cron run <id>`, `/cron on\|off <id>`, and a bare `/cron` to list |
| Web | the "Scheduled tasks" settings panel plus `GET/POST /api/jobs`, `DELETE /api/jobs/:id`, `POST /api/jobs/:id/run\|toggle` |

All three share one `<data directory>/jobs.json` (atomic write with a strictly increasing `updatedAt` epoch). Cap: 200 tasks. Job shape: `{ id, name, sessionId, prompt, schedule, enabled, createdAt, updatedAt, lastRunAt, lastStatus, lastError, nextRunAt }`.

## Scheduling and single ownership

An in-process 1-second ticker picks due tasks and runs them single-flight (the same task never runs twice concurrently). A due run goes through the ordinary turn entry: if the target session is busy the prompt is queued, otherwise it starts directly.

Two instances can briefly coexist during a port handover, so scheduling ownership is guarded by a single-owner lock at `<data directory>/jobs.lock`: `O_EXCL` creation plus PID liveness probing plus a heartbeat, and an instance that loses the race retries with backoff — never a double run. Tasks that come due while the service is down are recorded as `missed` and retried once on next startup within a 6-hour grace window; beyond that window they are skipped.

## Change signal

Creating a task that the UI never picked up is an old annoyance. Changes from the `cron` tool, REST and due-run accounting all fan out through `util/jobs/bus.mjs` as `jobs_changed`: turn SSE subscribers, the `GET /api/jobs/events` long connection, the settings panel and the terminal `/cron` all re-read on it, so you never discover a stale list only after switching categories.
