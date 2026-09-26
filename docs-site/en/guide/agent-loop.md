# Agent Loop Architecture

One turn is several "model rounds": stream → execute tool calls behind the permission gate → feed results back → repeat, until the model stops calling tools or hits the harness round cap. Implementation: `util/agent/loop.mjs`.

## Harness modes

| Mode | Purpose | Tools | Round cap | Compact ratio |
| --- | --- | --- | --- | --- |
| Minimal | direct answers for clear goals | none | 1 | 90% |
| Standard | daily tasks with verification | all | 24 | 70% |
| Ultimate | complex exploration and synthesis | all | 64 | 60% |

## Built-in tools

`read_file` `list_dir` `grep` `glob` `web_fetch` `write_file` `edit_file` `shell` `todo` `skill` `task` (sub-agents). File tools are jailed to the session workspace; shell runs in the workspace with a timeout (30s default, 120s cap).

## Permission modes and plan mode

- **Permission modes**: `always_ask` / `ask_when_needed` (default) / `never_ask`; deny rules and session rules always win
- **Plan mode**: the plan round only uses read-only / search / todo tools; execution starts after you approve

## Context compaction

When estimated tokens exceed the window threshold, early conversation is folded into a `summary` record via one model call, keeping recent turns verbatim. Failures never block the main flow.

## Sub-agents

The `task` tool spawns child turns with restricted harnesses: real child sessions on disk, inheriting workspace and session rules, depth capped at 2, up to 4 per turn, cascading abort.
