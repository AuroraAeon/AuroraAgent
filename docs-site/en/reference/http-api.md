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
| `GET/POST /api/agent/sessions` | list / create |
| `GET/PATCH/DELETE /api/agent/sessions/:id` | detail (`{ meta, records }`) / rename & switch / delete |
| `POST /api/agent/turn` | run a turn (SSE); single active turn (409); when the session still has the default name, the first round summarizes a title from the input and emits `session_renamed` |
| `POST /api/agent/abort` | abort, keeping generated content |
| `POST /api/agent/permission` | `{ requestId, decision: allow/deny/always }` |
| `POST /api/agent/plan` | `{ sessionId, decision: approve/reject }` |
| `GET /api/agent/skills` | skill catalog |

## MCP (experimental; 404 when disabled)

| Method & path | Notes |
| --- | --- |
| `GET/POST /api/mcp/servers` | list / upsert |
| `POST /api/mcp/servers/:id/probe` | test connection and list tools |
| `DELETE /api/mcp/servers/:id` | remove |
