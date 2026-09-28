# Terminology & Copy

> This page is the complete single source of truth for AuroraAgent domain vocabulary and user-facing copy: check it before writing docs, UI labels, or error messages. The terminology table in the docs-site `AGENTS.md` is a condensed version of this page.
> The vocabulary discipline is ported from ZCode's `CONTEXT.md`: every core concept has exactly **one** name with an Avoid list; inventing synonyms is a defect, not a style choice.

---

## 1. Domain Vocabulary

| Chinese | English | Definition | Avoid |
| --- | --- | --- | --- |
| 会话 | session | A resumable conversation context with title, metadata, and transcript | "chat" (for any exchange), "history" |
| 回合 | turn | One complete cycle driven by a single user input; may contain several rounds | "round" (that is 轮次), "request" |
| 轮次 | round | One model request plus the tool calls it triggers | "loop", "iteration", "step" |
| 工具 | tool | A capability the agent can invoke: eleven built-ins / skills / MCP | "function", "capability" (vague) |
| 权限门控 | permission gate | The three effects `allow` / `ask` / `deny` and the three `permissionMode` levels | "authorization" (mechanism vs action), "approval" |
| 目标 | goal | One goal per session in Goal mode: six-state machine plus three-axis budget | "task" (that is the todo tool), "plan" |
| 模式 / Harness | harness | The minimal / standard / ultimate capability contract | "tier" (vague), "mode" (clashes with plan mode) |
| 技能 | skill | A frontmatter + Markdown task spec, loaded on demand via `/<skill-name>` or the `skill` tool | "prompt template", "preset instruction" |
| 子代理 | sub-agent | A restricted session dispatched by the `task` tool; its final answer is aggregated back | "subtask", "child process" |
| 侧边对话 | side conversation | The `/btw` one-question-one-answer branch: in-memory, never persisted, never owns the goal | "temporary session", "draft session" |
| 提供方 | provider | An upstream API supplier: built-in (read-only) and custom (`providers.json`) | "channel", "vendor" (spoken only) |
| 故障转移 | failover | On connection-phase errors (429 / 5xx / network), automatically retry via another provider of the same model | "retry" (failover switches route), "load balancing" |
| 账本 | usage ledger | The append-only `usage.jsonl` usage record, priced per provider | "billing", "fee table" |
| 导轨态 | rail mode | The sidebar collapsed into a 56px icon rail: one top-left button showing the brand mark at rest and the toggle icon plus shortcut hint on hover | "mini sidebar", "icon mode" |
| 数据目录 | data directory | The config and session root with three-level fallback (env var / same directory / `~/Library`) | "config directory" (only part of it) |

## 2. Copy Rules

- **Errors = cause + next step**: say why, and tell the user what to do. Example: "API key invalid (401): re-enter it in Settings → General"; never just "auth failed".
- **Hints and labels = short verb-first labels**: buttons and menu items are named for the action ("Toggle sidebar", "New session"); states are nouns ("Generating", "Waiting for approval").
- **Speak in human units**: usage as `13K / 50K`, durations as `2min30s`; never surface implementation terms like "tokenization" or "character-level".
- **Zero emoji**: none in the UI, error messages, or terminal banners; icons are inline SVG or `public/vendors/*.svg`.
- **Chinese-English consistency**: the same concept uses the English column above across both languages; English pages may restructure sentences but never rename concepts.
- **Terminal exceptions**: CLI conventions such as `Esc cancel` and `y/n/a` belong to the TUI spec (`tui-design.md`) and are exempt from the short-label rule.

## 3. Examples

| Scenario | Write this | Not this |
| --- | --- | --- |
| Upstream 401 | API key invalid (401): re-enter it in Settings → General | auth failed / unauthorized |
| Sidebar toggle tooltip | Toggle sidebar + `⌘B` (`Ctrl+B` on non-Apple platforms) | Collapse / expand sidebar |
| Failover notice | Primary provider returned 429; retried via "XX" | switching route / retrying |
| Goal budget exhausted | Goal budget used up and wrapped up; adjust with `/goal budget` | budget exceeded |
| Empty session list | No sessions yet; send the first message to start | no data / empty |
