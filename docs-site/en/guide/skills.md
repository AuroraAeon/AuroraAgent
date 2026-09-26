# Skills

A skill is a Markdown file with YAML frontmatter: `name` + `description` + body. Only the catalog (name + description) stays in the system prompt; the body is loaded on demand — it never occupies everyday context.

## Invocation

1. **Explicit**: type `/<skill-name> [args]` in either client (terminal command or web `/` palette; resolved server-side)
2. **Implicit**: the model calls the `skill` tool when your request matches a description

## Locations

| Path | Source | Notes |
| --- | --- | --- |
| `skills/` | built-in | shipped with the repo |
| `<dataDir>/skills/` | user | custom skills, effective after restart |

## Writing one

````markdown
---
name: my-skill
description: one sentence on when to use it (the model only reads this)
---

# Rules

- first rule

# Workflow

1. step one
2. step two

# Forbidden

- things to avoid
````

Write the description as if the model decides from that sentence alone — be specific and decidable.
