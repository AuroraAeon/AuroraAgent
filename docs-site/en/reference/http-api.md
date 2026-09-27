# HTTP API

Same-origin `/api/*`, all JSON; SSE frames are `event:` + `data:` lines.

## Chat base

| Method & path | Notes |
| --- | --- |
| `POST /api/chat` | streaming chat: `{ messages, model?, provider?, thinking?, imagePath? }` |
| `GET /api/models` | model catalog (built-in + custom providers) |
| `GET/POST /api/providers`, `PUT/DELETE /api/providers/:id` | provider CRUD |
| `POST /api/providers/discover` | pull upstream catalog (read-only) |

## Agent runtime

| Method & path | Notes |
| --- | --- |
| `GET /api/agent/harnesses` | harness list |
| `GET/POST /api/agent/sessions` | list / create (titleMode defaults to the global setting) |
| `GET/PATCH/DELETE /api/agent/sessions/:id` | detail (`{ meta, records }`) / rename & switch (incl. titleMode) / delete |
| `POST /api/agent/sessions/:id/fork` | fork a session: copies meta and full transcript into a new session (new id / timestamps / "（copy）" name suffix); goals are not copied |
| `POST /api/agent/turn` | run a turn (SSE); single active turn (409); when the session still has the default name, the first round summarizes a title from the input and emits `session_renamed` (titleMode resolves as request body > session meta > global config) |
| `POST /api/agent/abort` | abort, keeping generated content |
| `POST /api/agent/permission` | `{ requestId, decision: allow/deny/always }` |
| `POST /api/agent/plan` | `{ sessionId, decision: approve/reject }` |
| `GET /api/agent/skills` | skill catalog |
| `GET /api/files/search?sessionId=&q=` | read-only file search inside the session workspace (path-jailed, dependency dirs skipped); 404 for unknown sessions |

## Goal (goal mode)

| Method & path | Purpose |
| --- | --- |
| `GET /api/agent/goal/:id` | read a session's goal (`{ goal: null }` when none) |
| `POST /api/agent/goal` | create `{ sessionId, objective, tokenBudget? }`; 409 `GOAL_STATUS_CONFLICT` when an unfinished goal exists, 400 for a blank objective, 404 for unknown sessions |
| `POST /api/agent/goal/pause` · `/resume` · `/stop` | user-side transitions; resuming `complete` / `budget_limited` to active is rejected with 409 |
| `POST /api/agent/goal/budget` | set the token budget `{ sessionId, tokenBudget, expectedUpdatedAt }`; 409 `GOAL_STALE` on a stale epoch, 400 for an invalid budget |

## Settings

| Method & path | Purpose |
| --- | --- |
| `GET/POST /api/settings` | read settings / toggle autostart |
| `GET/POST /api/settings/tui` | read / write terminal preferences (`terminalTitle` order + `notifications` triple); 400 on bad values, 405 for other methods |
| `GET/POST /api/settings/proxy` | read / write the Agent sandbox outbound proxy (`agentProxy`: `http://host:port`, empty = direct); 400 on bad values such as socks5, 405 for other methods |

## MCP (experimental; 404 when disabled)

| Method & path | Notes |
| --- | --- |
| `GET/POST /api/mcp/servers` | list / upsert |
| `POST /api/mcp/servers/:id/probe` | test connection and list tools |
| `DELETE /api/mcp/servers/:id` | remove |
