# Config & Environment

## Data directory fallback

1. `AURORAAGENT_DATA_DIR`
2. an existing `auroraagent.config.json` next to the source (dev mode)
3. otherwise `~/Library/Application Support/AuroraAgent` (app mode)

## Config fields

`apiKey` / `model` / `thinking` / `temperature` / `maxTokens` / `permissionMode` / `planMode` / `titleMode` / `agentProxy` / `providerFailover` / `providerFailoverMaxAttempts` / `goal` / `tui`.

### goal section (goal mode)

Per-leaf fallback + clamping + startup warning. Full semantics: [Goal Mode guide](/en/guide/goal-mode).

| Field | Default | Meaning |
| --- | --- | --- |
| `verification` | `none` | tier: `none` / `evaluator` / `subagent` |
| `evaluatorModel` | empty | required for evaluator; setting it implies evaluator |
| `evidence` | `brief` | evidence shape: `brief` / `transcript` |
| `repeatedReplyLimit` | 3 | shared breaker threshold (2–10; nudge on the 2nd observation, trip on the Nth) |
| `repeatedNotMetLimit` | 5 | consecutive `not_met` (counted only while the gap set is unchanged) before `paused(no_progress)` |
| `graceSteps` | 1 | grace rounds after round / time exhaustion (0–3) |
| `mainTurns` | 0 | continuation round cap, 0 = unlimited |
| `activeSeconds` | 0 | in-turn active seconds cap, 0 = unlimited |
| `evaluatorMaxTokens` | 4096 | evaluator per-request token cap |
| `evaluatorTimeoutSeconds` | 60 | evaluator timeout (seconds) |
| `evaluatorMaxRetries` | 1 | evaluator retry cap |

### providerFailover / providerFailoverMaxAttempts (multi-provider failover)

Read and written via `GET/POST /api/settings/failover` (Settings → Failover panel); changes apply to the next request. Behavior details live in the [custom providers guide](/en/guide/providers).

| Field | Default | Meaning |
| --- | --- | --- |
| `providerFailover` | `true` | retry against another provider serving the same model on 429 / 5xx / network failure |
| `providerFailoverMaxAttempts` | `3` | total attempts including the first (clamped 1–5; 1 effectively disables) |

Env `AURORAAGENT_FAILOVER` (`0` off / `1` on) and `AURORAAGENT_FAILOVER_MAX_ATTEMPTS` (1–5) take precedence over the file.

### tui section (terminal preferences)

### agentProxy (outbound proxy for the Agent sandbox)

Outbound requests made by Agent tools (`web_fetch` and friends) connect directly by default; sites whose direct connection is reset (Wikipedia, for example) can be reached through a local HTTP proxy. Read and written via `GET/POST /api/settings/proxy` (Settings dialog, "Network" panel); changes take effect immediately and do not affect model upstream requests.

| Form | Notes |
| --- | --- |
| empty (default) | direct connection |
| `http://127.0.0.1:7890` | canonical form; common ports: Clash / mihomo 7890, Surge 6152, V2Ray 10809 |
| `127.0.0.1:7890` | bare `host:port`, normalized with an `http://` prefix |

Other protocols such as socks5 are not supported yet (the error message says so); HTTP targets go through a forward proxy and HTTPS targets through a CONNECT tunnel. Implementation lives in `util/proxy.mjs`.

Read and written via `GET/POST /api/settings/tui` (Settings dialog, "Terminal" panel); the terminal reads it once at startup, so changes apply on next launch.

| Field | Default | Meaning |
| --- | --- | --- |
| `terminalTitle` | `['state','session','app']` | OSC title item order (deduplicated, order preserved); `[]` disables |
| `notifications.when` | `unfocused` | `unfocused` / `always` / `never` |
| `notifications.method` | `auto` | `auto` / `osc9` / `osc777` / `bel` |
| `notifications.events` | all four | `turn-complete` / `turn-failed` / `permission-required` / `question-required` |

### ignore / sanitizeChildEnv / promptCache (security and prompt cache)

| Key | Default | Notes |
| --- | --- | --- |
| `ignore.enabled` | `true` | Master switch for the `.auroraagentignore` no-entry gate (only `false` turns it off) |
| `sanitizeChildEnv` | `true` | Sanitize the `shell` tool's child environment: drops variables matching `KEY` / `TOKEN` / `SECRET` / `PASSWORD` / `CREDENTIAL`, keeping only the runtime essentials `PATH` / `HOME` / `SHELL` / `TMPDIR` / `LANG` / `LC_*` / `USER` / `LOGNAME` / `TERM` / `TZ` / `PWD` / `ZDOTDIR` |
| `promptCache` | `auto` | Prompt cache mode `auto` / `off`; it only takes effect when the provider also declares `capacity.supportsPromptCache`, see [Prompt Cache](/en/reference/prompt-cache) |

### rules section (rule toggle table)

| Key | Default | Notes |
| --- | --- | --- |
| `rules.<rule name>` | On | One boolean toggle per rule; `false` disables that rule (the file stays, activation is still evaluated) |

Rule files themselves are edited on disk, see [Rules](/en/reference/rules).

## Environment variables

| Variable | Effect |
| --- | --- |
| `AURORAAGENT_API_KEY` | API key (overrides config) |
| `AURORAAGENT_BASE_URL` | upstream base URL (overrides config) |
| `AURORAAGENT_THEME` | terminal theme `dark` / `light` / `auto` |
| `AURORAAGENT_FAILOVER` | `0` disables multi-provider failover / `1` enables (overrides the file) |
| `AURORAAGENT_FAILOVER_MAX_ATTEMPTS` | total failover attempts 1–5 (overrides the file) |
| `AURORAAGENT_EXPERIMENTAL_MCP` | enable the MCP experiment |
| `AURORAAGENT_EXPERIMENTAL_HOOKS` | enable the event hooks experiment |
| `AURORAAGENT_NO_RIPGREP` | when `1`, `grep` / `glob` always take the pure-JavaScript fallback path (no ripgrep) |
| `AURORAAGENT_EXPERIMENTAL_FLAG` | enable all experiments |
| `PORT` / `NO_OPEN` | web port / do not open a browser |
| `LOG_LEVEL` | `debug` for verbose logs |

## Never-committed secrets

`auroraagent.config.json`, `usage.jsonl`, `providers.json`, `mcp.json`, `sessions/` — all gitignored. A leaked key is a security incident.
