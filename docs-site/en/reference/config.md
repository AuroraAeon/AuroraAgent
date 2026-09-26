# Config & Environment

## Data directory fallback

1. `AURORAAGENT_DATA_DIR`
2. an existing `auroraagent.config.json` next to the source (dev mode)
3. otherwise `~/Library/Application Support/AuroraAgent` (app mode)

## Config fields

`apiKey` / `model` / `thinking` / `temperature` / `maxTokens` / `permissionMode` / `planMode`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `AURORAAGENT_API_KEY` | API key (overrides config) |
| `AURORAAGENT_BASE_URL` | upstream base URL (overrides config) |
| `AURORAAGENT_THEME` | terminal theme `dark` / `light` / `auto` |
| `AURORAAGENT_EXPERIMENTAL_MCP` | enable the MCP experiment |
| `AURORAAGENT_EXPERIMENTAL_FLAG` | enable all experiments |
| `PORT` / `NO_OPEN` | web port / do not open a browser |
| `LOG_LEVEL` | `debug` for verbose logs |

## Never-committed secrets

`auroraagent.config.json`, `usage.jsonl`, `providers.json`, `mcp.json`, `sessions/` — all gitignored. A leaked key is a security incident.
