# Event Hooks

Event hooks attach executable scripts to points in the agent lifecycle: a script receives the event data as JSON on standard input and returns a control instruction on standard output. They fit work that must happen every time but should not be re-explained to the model every time — format checks, blocking sensitive operations, syncing session output into project docs.

This is experimental and off by default: set `AURORAAGENT_EXPERIMENTAL_HOOKS=1` and restart the service.

## Drop in and it runs

No config file, no registry — **the file name is the event name**. Put it in the directory and it is live; delete it and it is gone.

| Source | Path | Priority |
| --- | --- | --- |
| Project hooks | `<workspace>/.auroraagent/hooks/` | High (shareable with the team through the repo) |
| Personal hooks | `<data dir>/hooks/` | Low (present across projects) |

Project hooks override personal hooks with the same name. The extension picks the interpreter: no extension (the file must be executable itself) / `.sh` / `.bash` / `.zsh` / `.mjs` / `.cjs` / `.js` / `.py`. Hook scripts live flat in the directory, not in subdirectories.

Example: `<workspace>/.auroraagent/hooks/PreToolUse.sh` fires before every tool execution; `PostToolUse.mjs` fires after. Event names are case- and underscore-insensitive, so `PreToolUse` and `pre_tool_use` are equivalent.

## The ten events

| Event | Fires when | Available controls |
| --- | --- | --- |
| `prompt_submit` | User submits, before the record is persisted | Rewrite input / append context / cancel |
| `turn_start` | Turn begins | Append context / cancel |
| `round_start` | Model round begins | Append context |
| `pre_tool_use` | Before a tool executes | Cancel / route to permission / rewrite arguments |
| `post_tool_use` | After a tool executes | Append context |
| `pre_compact` | Before context compaction | Cancel this compaction |
| `turn_end` | Turn ends normally | Append context |
| `turn_error` | Turn fails | Append context |
| `turn_abort` | User aborts | Append context |
| `session_shutdown` | Process exits | Manual trigger via `/hooks test` only |

`session_shutdown` has no automatic attachment point: spawning a child process reliably during process exit is not possible, so it exists for manual testing.

## Event data (stdin)

The payload is a single line of JSON delivered on stdin. Common fields are present on every event: `hookName` / `timestamp` / `sessionId` / `turnId` / `round` / `workspace` / `agentId` / `parentAgentId`. Event-specific data (tool name and arguments, compaction reason, and so on) sits on fixed keys. The environment variable `AURORAAGENT_HOOK_EVENT` also carries the current event name.

## Control instructions (stdout)

When the script exits with code 0, standard output is parsed as a JSON control instruction. Log lines printed around the JSON are ignored (the last parseable segment wins).

| Field | Type | Effect |
| --- | --- | --- |
| `cancel` | `true` | Cancel this action (tool not executed / compaction skipped / turn aborted); sticky — any hook saying cancel cancels |
| `review` | `true` | Route to the permission channel; continue only after explicit user confirmation (reuses the existing permission gate) |
| `context` | string | Text appended into context; all hooks combined are capped at 50KB, trimmed from the oldest when exceeded |
| `overrideInput` | object | Rewrite arguments (tool arguments / user input); later hooks override earlier ones |
| `systemPrompt` | string | Text appended into the system prompt |

### Exit codes

| Code | Behavior |
| --- | --- |
| `0` | Success; act on the parsed control instruction |
| `2` | Explicit cancel; the first line of stderr is the reason |
| Any other non-zero | The script itself failed: log it and continue as "no control" (fail-open — a broken hook must not crash the turn) |

One hook failing or timing out affects neither the other hooks nor the turn.

## Timeouts and resources

- Timeout defaults to 10 seconds and is capped at 60; a hook is a bonus, it has no right to hang the user
- Standard output over 1MB counts as failure; the last 256KB of stderr is kept
- Aborting a turn cascades a kill to running hook child processes
- Zero-dependency spawn, never a shell string (shell injection is a real hazard when script paths contain spaces or odd characters)

## Inspect and test

| Entry point | Usage |
| --- | --- |
| Terminal | `/hooks` lists discovered hooks; `/hooks events` shows the ten events; `/hooks test <event>` triggers one with a synthetic payload |
| Web Composer | The `/hooks` family, parsed the same way as the terminal |
| HTTP | `GET /api/agent/hooks?workspace=` returns discovered hooks, gate status, and the event vocabulary |

With the gate off, `/hooks` shows how to enable it rather than an empty list — "no hooks configured" and "hooks are switched off" are different things, and you can tell them apart.

## Example

`<data dir>/hooks/PostToolUse.mjs`: after every tool execution, ask for a changelog sync when files changed.

```javascript
let raw = '';
process.stdin.on('data', (d) => { raw += d; });
process.stdin.on('end', () => {
  const payload = JSON.parse(raw);
  const tool = payload.tool || '';
  if (tool === 'write_file' || tool === 'edit_file') {
    process.stdout.write(JSON.stringify({ context: 'This change must sync CHANGELOG.' }));
  }
});
```
