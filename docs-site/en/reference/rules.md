# Rules

Rules inject project conventions into the system prompt conditionally: how the workspace is organized, how commit messages are written, which directories must not be touched. Write the convention once and it is present in every later round, with no need to repeat it to the model.

The division of labor with skills: a skill is an **on-demand** capability package (its body loads only when the model or the user invokes it); a rule is a **standing or path-scoped** convention. Rules therefore have no invocation entry point, only an activation check; and because they stand, they must be governed by a token budget.

## Three sources

| Source | Path | Priority |
| --- | --- | --- |
| Project constitution | `<workspace>/AGENTS.md` | High (the whole file always applies when it has no frontmatter) |
| Project rules | `<workspace>/.auroraagent/rules/*.md` | Medium |
| Personal rules | `<data dir>/rules/*.md` | Low |

On name collisions the later source overrides the earlier one, so project conventions win over personal ones.

## File format

Markdown with a relaxed YAML frontmatter (the same subset used by skills):

```markdown
---
name: typescript-conventions
description: TypeScript conventions: types first, no any, naming rules
paths: ["src/**/*.ts", "web-ui/src/**/*.tsx"]
---

The body is the rule text injected into the system prompt.
```

| Field | Required | Notes |
| --- | --- | --- |
| `name` | Yes | The rule name, also the key in the toggle table |
| `description` | Yes | One line; the only identifying signal when the budget forces a degraded display |
| `paths` | No | Glob array for conditional activation; semantics below |
| `always` | No | `true` makes the rule always apply, ignoring `paths` |

Missing frontmatter, an empty `name` / `description`, or an empty body makes the file count as absent (the load warning explains why). `description` is capped at 1024 characters and the body at 500 lines; exceeding either is a soft warning, not a block.

## paths conditional activation

`paths` decides whether the files touched in a round count as candidates — candidates come from files mentioned in the user input and from files that entered the context in session records, at most 64 of them.

| Form | Semantics |
| --- | --- |
| `paths` omitted | Always applies (without the key there is no condition to evaluate) |
| `paths: []` | Explicitly off (turn a single rule off while keeping the file and its toggle state) |
| `paths` present but no candidates | Not activated (no evidence, no path rules — the conservative choice) |
| Invalid type | Fail-open, treated as always applies (bad data must not silently swallow a rule) |
| `always: true` | Always applies, ignoring `paths` |

Glob matching is a self-implemented picomatch subset: `*` does not cross `/`; `**` crosses directories at any depth (including zero); `?` is a single character; `[abc]` `[a-z]` `[!abc]` are character classes; a leading `/` anchors at the workspace root, otherwise the pattern matches at any depth; a trailing `/` means a directory and everything under it; dotfiles participate by default.

## Token budget

Rule bodies standing in context share a 4000-token budget: when the activated bodies exceed it, the excess degrades to a name + description line — never dropped entirely (a silently lost convention is far more dangerous than a few tokens).

## Toggles

| Entry point | Usage |
| --- | --- |
| Terminal | `/rules` lists (source / condition / active or not); `/rules on <name>` enables; `/rules off <name>` disables |
| Web Composer | The `/rules` family, parsed the same way as the terminal |
| HTTP | `GET /api/settings/rules` returns the discovered rules and current toggle values; `POST` replaces the toggle table wholesale |

The rule files themselves are edited on disk; the toggle table only switches them on and off. Changes take effect on the next request.
