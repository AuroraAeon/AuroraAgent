# Custom Providers

Beyond the built-in Meituan LongCat, add any **OpenAI-compatible** or **Anthropic Messages** upstream.

## Adding one

Settings → Providers → Add custom provider:

1. Base URL + API key (key format validated live)
2. "Discover models" pulls the upstream catalog (read-only); pick what you want
3. Saved providers group in the model picker and are routable from both `/api/chat` and the agent loop

## Routing

Explicit `provider` wins; otherwise the provider is resolved from the model ID; unknown models still fall back to the built-in provider. Built-in providers are read-only; custom ones live in `<dataDir>/providers.json` (atomic write, includes keys, never committed).

## Protocol differences

`util/wire.mjs` translates the internal OpenAI shape (with `tool_calls`) into the target protocol: Anthropic system extraction, `tool_use` / `tool_result` blocks, and SSE frame translation (`input_json_delta` → `tool_calls` delta) — so clients and the loop only ever see one frame format.
