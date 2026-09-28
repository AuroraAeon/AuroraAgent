# Custom Providers

Beyond the built-in Meituan LongCat, add any **OpenAI-compatible** or **Anthropic Messages** upstream.

## Adding one

Settings → Providers → Add custom provider:

1. Base URL + API key (key format validated live)
2. "Discover models" pulls the upstream catalog (read-only); pick what you want
3. Saved providers group in the model picker and are routable from both `/api/chat` and the agent loop

## Routing

Explicit `provider` wins; otherwise the provider is resolved from the model ID; unknown models still fall back to the built-in provider. Built-in providers are read-only; custom ones live in `<dataDir>/providers.json` (atomic write, includes keys, never committed).

## Failover

With several providers whose catalogs overlap, a **429 rate limit / 5xx server error / network failure** from the primary provider is retried against another provider that serves the same model — the conversation continues and the user never sees an error. This is the local counterpart of upstream "automatic account rotation".

- **Connection-phase only**: switching happens before the upstream has emitted a single byte; once bytes are flowing, failures propagate as before (the client already has partial content)
- **Never switched**: 400 / 401 / 402 / 403 / 404 / 422 surface as-is — those are configuration, auth, or billing problems that another route would only mask
- **Candidate rule**: other providers whose catalog contains the model, that have an API key, and that this request chain has not tried yet (built-in first); no provider is retried twice within one chain
- **Sticky within a turn**: after a successful switch the new provider is kept for the rest of the turn, avoiding flapping; usage is billed to the provider that actually produced the tokens — failed attempts consume nothing and are not recorded
- **Knobs**: `providerFailover` (on by default) and `providerFailoverMaxAttempts` (including the first attempt, default 3, clamped 1–5) — Settings → Failover panel, or env `AURORAAGENT_FAILOVER` / `AURORAAGENT_FAILOVER_MAX_ATTEMPTS`
- **Visible**: the web UI drops a notice ("Switched provider: A → B (rate limited, attempt 1)"), the terminal prints one line; the decision logic lives in `util/llm/failover.mjs`, the orchestration in `util/llm/provider.mjs`

## Protocol differences

`util/wire.mjs` translates the internal OpenAI shape (with `tool_calls`) into the target protocol: Anthropic system extraction, `tool_use` / `tool_result` blocks, and SSE frame translation (`input_json_delta` → `tool_calls` delta) — so clients and the loop only ever see one frame format.
