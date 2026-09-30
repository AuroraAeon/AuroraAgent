# Prompt Cache

Prompt caching lets the upstream charge cached prices for the unchanged request prefix — the system prompt, tool definitions, and the historical part of a long conversation are usually resent verbatim every round, and a cache hit lowers both cost and time to first token. AuroraAgent instruments this automatically per protocol; nothing needs to be marked by hand.

## The switch

Both conditions must hold. If either fails, the request bytes are identical to before the feature existed (asserted by tests):

| Condition | Where | Default |
| --- | --- | --- |
| Provider declares support | `capacity.supportsPromptCache` in the provider editor | Not declared (undeclared always counts as unsupported) |
| Config mode | `promptCache`: `auto` / `off` | `auto` |

Sending one extra field to a line that does not understand `cache_control` / `prompt_cache_key` is a 400, so "undeclared" is never enabled on the provider's behalf; you opt in explicitly in the provider editor. Mode changes take effect on the next request.

## Breakpoint placement

**Anthropic Messages line**

- The system prompt becomes a block array, with one breakpoint at the end of the stable segment
- One breakpoint on the last `tools[]` entry
- Two on the conversation tail: the final user message and the assistant message just before it
- Four breakpoints in total, respecting the upstream limit

**OpenAI-compatible line**

- Carries `prompt_cache_key`: the first 32 hex characters of a sha1 over provider id + model + stable system segment — deterministic and stable across rounds, so consecutive turns in a session hit the same cache partition
- The rest of the request body stays byte-stable (`deferred` tools still stay out of the top-level `tools[]`), so the prefix does not wobble by a single byte

## Visible in usage

Cache hits and writes land in the usage ledger (`cachedTokens` / `cacheWriteTokens`) and surface in the settings usage panel: one conditional line under the totals (hidden when everything is zero) and a "Cache" column in the recent requests table. These two numbers are **not folded into the input column** — they are another billing dimension, and mixing them in would make the panel disagree with the bill.
