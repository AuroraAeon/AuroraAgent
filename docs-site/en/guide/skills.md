# Skills

A skill is a directory: `SKILL.md` (frontmatter + body) plus optional `references/`, `scripts/`, and `assets/`. Skills load through **progressive disclosure** — only the name and description stay in everyday context.

## Three levels of disclosure

| Level | Content | Loaded when | Cost |
| --- | --- | --- | --- |
| L1 Catalog | `name` + `description` | always, at session start | ~50–100 tokens each, capped by a 4000-token catalog budget |
| L2 Instructions | the `SKILL.md` body | when the skill is triggered | keep under ~5000 tokens / 500 lines |
| L3 Resources | `references/`, `scripts/`, `assets/` | only when the body references them | zero until accessed |

On activation the server returns a structured wrapper: the body, the skill's **absolute directory**, and a list of bundled resources (names and sizes only, never pre-read). The model then reads what it needs with `read_file` using absolute paths — skill directories are a **read-only allowlist root** for file tools, while write tools stay jailed to the session workspace. Scripts under `scripts/` run through `shell` with absolute paths and keep the existing timeout and permission gate.

## Invocation

1. **Explicit**: type `/<skill-name> [args]` in either client (terminal command or web `/` palette; resolved server-side)
2. **Implicit**: the model calls the `skill` tool when your request matches a description

A skill with `implicit: false` keeps only the explicit path and stays out of the model-visible catalog.

## Locations

| Path | Source | Notes |
| --- | --- | --- |
| `skills/` | built-in | shipped with the repo |
| `<dataDir>/skills/` | user | custom skills, effective after restart |

A user skill shadows a built-in one with the same name. Loading is lenient: an over-long `description`, a body over 500 lines, or a `name` that differs from its parent directory only produce warnings; a skill is skipped only when `name` or `description` is missing or the body is empty.

## Directory layout

```text
my-skill/
├── SKILL.md            # required: frontmatter + instructions
├── references/         # optional: docs read on demand
├── scripts/            # optional: scripts run via shell (code never enters context)
└── assets/             # optional: templates, images, and other output material
```

Resource indexing is bounded: at most 4 levels deep and 200 entries, skipping noise directories such as `.git`, `node_modules`, and build output. `SKILL.md` itself is not counted as a resource.

## Frontmatter fields

| Field | Required | Constraint | Meaning |
| --- | --- | --- | --- |
| `name` | yes | 1–64 chars, lowercase letters / digits / hyphens | should match the parent directory |
| `description` | yes | 1–1024 chars | the only routing signal the model sees |
| `license` | no | short string | skill license |
| `compatibility` | no | ≤500 chars | environment requirements, e.g. `Requires Node 18+` |
| `metadata` | no | indented `key: value` block | arbitrary extra metadata |
| `allowed-tools` | no | space-separated tool names | tools allowed for the turn after activation (scopes like `Bash(git:*)` are not parsed) |
| `implicit` | no | `false` / `no` / `0` / `off` | when set, only `/<skill-name>` may invoke it |

## Writing one

````markdown
---
name: my-skill
description: one sentence on when to use it (the model only reads this). Use when the user asks for X or mentions Y
---

# Rules

- first rule

# Workflow

1. step one
2. step two

# Further reading

- everything about domain A: `references/domain-a.md`
- everything about domain B: `references/domain-b.md`

# Forbidden

- things to avoid
````

Write the description as if the model decides from that sentence alone — be specific, decidable, and list the contexts that should trigger it. Keep the body tight and move detail into `references/`; keep references one level deep (linked directly from `SKILL.md`) instead of chaining files.

## Context lifecycle

- **Compaction-safe**: `skill` tool results and `/<skill-name>` injections are preserved verbatim during context compaction — skill rules must survive the whole session.
- **De-duplicated**: re-activating the same skill within a turn returns a short acknowledgement instead of repeating the body.
