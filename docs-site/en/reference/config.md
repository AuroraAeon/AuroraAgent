# Config & Environment

## Data directory fallback

1. `AURORAAGENT_DATA_DIR`
2. an existing `auroraagent.config.json` next to the source (dev mode)
3. otherwise `~/Library/Application Support/AuroraAgent` (app mode)

## Config fields

`apiKey` / `model` / `thinking` / `temperature` / `maxTokens` / `permissionMode` / `planMode` / `titleMode` / `goal` / `tui`.

### goal section (goal mode)

Per-leaf fallback + clamping + startup warning. Full semantics: [Goal Mode guide](/en/guide/goal-mode).

| Field | Default | Meaning |
| --- | --- | --- |
| `verification` | `none` | tier: `none` / `evaluator` / `subagent` |
| `evaluatorModel` | empty | required for evaluator; setting it implies evaluator |
| `evidence` | `brief` | evidence shape: `brief` / `transcript` |
| `repeatedReplyLimit` | 3 | shared breaker threshold |
| `repeatedNotMetLimit` | 5 | consecutive `not_met` before `blocked(verifier_impossible)` |
| `graceSteps` | 1 | grace rounds after round / time exhaustion (0–3) |
| `mainTurns` | 0 | continuation round cap, 0 = unlimited |
| `activeSeconds` | 0 | in-turn active seconds cap, 0 = unlimited |
| `evaluatorMaxTokens` | 4096 | evaluator per-request token cap |
| `evaluatorTimeoutSeconds` | 60 | evaluator timeout (seconds) |
| `evaluatorMaxRetries` | 1 | evaluator retry cap |

### tui section (terminal preferences)

Read and written via `GET/POST /api/settings/tui` (Settings dialog, "Terminal" panel); the terminal reads it once at startup, so changes apply on next launch.

| Field | Default | Meaning |
| --- | --- | --- |
| `terminalTitle` | `['state','session','app']` | OSC title item order (deduplicated, order preserved); `[]` disables |
| `notifications.when` | `unfocused` | `unfocused` / `always` / `never` |
| `notifications.method` | `auto` | `auto` / `osc9` / `osc777` / `bel` |
| `notifications.events` | all four | `turn-complete` / `turn-failed` / `permission-required` / `question-required` |

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
