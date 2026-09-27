# Goal Mode

Goal mode attaches a **cross-round session goal** to a conversation: the model advances, verifies, and continues on its own until the goal is complete, blocked, or out of budget — and you can pause, resume, or re-budget at any time. The semantics mirror MiniMax-code's thread-goal capability, re-implemented with zero dependencies for a local single-user tool (`util/agent/goal/`).

## When to use it

- Multi-round tool work you do not want to babysit round by round: "keep working until this repo's tests are green"
- Independent completion verdicts instead of the model grading its own homework
- Hard rails on autonomous progress: token budget, round budget, active time, and no-progress breakers

Not for one-shot questions. The model only calls `create_goal` when you explicitly ask it to watch a goal — it never infers goals from ordinary tasks.

## Three-party authority

| Party | Powers |
| --- | --- |
| Model | `update_goal` proposes `complete` / `blocked`; changes `token_budget` only in a round where you explicitly asked, with a fresh `get_goal` snapshot |
| User | Every transition except re-activating an exhausted goal: pause, stop, resume `paused` / `blocked` / `usage_limited` |
| System | Ledger-bound: auto-transitions to `budget_limited` when `tokensUsed >= tokenBudget` |

At most one goal per session (`<dataDir>/goals/<sessionId>.json`, atomic write); a new goal replaces the old one only after it is `complete`.

## The six-state machine

`active` / `paused` / `blocked` / `complete` / `budget_limited` / `usage_limited`.

- **Terminal states** (`complete` / `blocked` / `budget_limited` / `usage_limited`) stop auto-continuation. Whether they can resume is a separate question: `complete` is terminal for good — no transition out is allowed; resuming `complete` / `budget_limited` to active is always rejected with 409
- Every transition carries a `statusReason` from a closed set (e.g. `complete(verifier_met)`, `paused(no_progress)`, `budget_limited(token)`), shown verbatim in the terminal and the web UI

## Model-side tools

Names and schemas match codex / minimax-code so models need zero learning time; collected in Standard / Ultimate only, not in Minimal.

| Tool | Purpose |
| --- | --- |
| `create_goal(objective, token_budget?)` | create a goal; fails if an unfinished goal exists |
| `update_goal(mode?, status?, summary?, token_budget?, expected_goal_id?, expected_updated_at?)` | propose a terminal state, or (only when explicitly requested) change the budget |
| `get_goal()` | read the current goal: status, timestamps, usage, budget |

`update_goal` keeps two modes strictly separate: the default proposal mode (`status` proposes `complete` / `blocked` with a `summary`); budget mode must immediately follow a `get_goal` snapshot and pass only `token_budget` + `expected_goal_id` + `expected_updated_at` (CAS epoch check, stale snapshot → 409). Mixing fields is rejected; `null` fillers are exempt.

## Budget and breakers

- **Token budget**: `tokensUsed` accumulates through the usage ledger each round; on exhaustion the goal moves to `budget_limited(token)` and a single tool-free wrap-up round runs — summarizing what was done, what was not, and why it stopped, plus how to re-budget and continue
- **Round / time budgets**: `goal.mainTurns` (continuation rounds) and `goal.activeSeconds` (in-turn active seconds) move the goal to `budget_limited(main_turn)` / `budget_limited(active_time)`; `graceSteps` is the grace period after exhaustion (default 1)
- **Re-arming**: raising or clearing `token_budget` restores a `budget_limited(token)` goal to `active` (model side via CAS budget mode, user side via `/goal budget`)
- **Dual breakers**: a repeated normalized reply fingerprint (`noProgressStreak`) and consecutive tool-free rounds (`noToolStreak`) share the threshold `goal.repeatedReplyLimit` (default 3) and never accumulate together; either trips the goal into `paused(no_progress)`

## Verification tiers

`goal.verification`: `none` (default) / `evaluator` / `subagent`.

- **evaluator**: one low-temperature request through the same route with a small fast model, verdict `met` / `not_met` / `impossible` / `inconclusive` (`goal.evaluatorModel` required; maxTokens 4096, 60s timeout, verdict-layer retries capped at 1); the model's own `summary` is always submitted as untrusted data, and the objective, summary, and transcript are data for the verifier, never instructions. An `inconclusive` verdict (including a degraded incomplete payload) triggers at most one retry. On `not_met` the verifier must also list a `missing` array of concrete gaps (one sentence each, at most 50), surfaced in the continuation feedback, the banner, and the terminal summary
- **subagent**: an independent read-only profile (`goal-verifier-readonly`) dispatched through the sub-agent system
- **Evidence shape** `goal.evidence`: `brief` (default) / `transcript`
- **Settlement**: `met` → `complete(verifier_met)`; `impossible` → `blocked(verifier_impossible)`; `repeatedNotMetLimit` (default 5) consecutive `not_met` with an unchanged gap set → `paused(no_progress)` (a changed gap set restarts the count); `inconclusive` pauses attributed by `code` (`schema_error` → `paused(verifier_protocol)`, otherwise `paused(verifier_unavailable)`); a broken verifier → `paused(verifier_unavailable)`. Never a silent pass

No implicit routing: evaluator only runs when `goal.evaluatorModel` is explicitly configured.

## Auto-continuation

Adapted to the single-SSE-turn model with no queue subsystem: within a turn, when the model stops calling tools while the goal is still `active`, with no terminal proposal and no budget / breaker trip, a goal-continuation system reminder extends the round (capped by both the harness round limit and the goal's main-turn budget). A new user message ends the continuation; the goal state carries into your next turn. While waiting for permission, plan approval, or verification, `goal_wait_changed` (`executionWait`) is emitted so both clients render "waiting" instead of "stuck".

Rewriting the objective mid-turn (web `/goal edit` / Composer or REST) does not leave the in-flight model in the dark: its next round receives a "Goal updated" reminder — the new objective is wrapped as untrusted data (`<untrusted_objective>`) with a budget snapshot (used / cap / remaining, `unlimited` when uncapped) — so it adjusts course instead of continuing work that only served the old objective. A pending terminal proposal for the old objective is discarded at the same time (mirrors MiniMax `renderObjectiveUpdatedPrompt` and binding-staleness cancellation).

## User-side operations

The terminal and the web Composer share one `/goal` parser (`util/agent/goal/command.mjs`, the single source of truth, mirroring MiniMax-code's `thread-goal-command`), so both clients behave identically:

```bash
/goal                          # current goal: status / objective / usage / budget / latest verification / available actions
/goal Rewrite the README install section    # create a goal; rewrites the objective when one is unfinished
/goal Fix the login bug budget=50K          # create a goal and set the token budget in one shot (K / M suffix)
/goal budget=50K               # change only the current budget; the legacy /goal budget 50000 also works
/goal budget=clear             # clear the cap (clear / null / none / off / 0 are synonyms)
/goal edit                     # fill the current objective back into the input box for another pass
/goal clear                    # remove the goal (cancel / delete are aliases; alongside stop's "mark complete", clear removes it outright)
/goal pause                    # pause (active → paused)
/goal resume                   # resume (paused / blocked / usage_limited → active)
/goal stop                     # mark complete and stop tracking (complete(user_requested))
/goal help                     # command help
```

Web: type the commands above straight into the chat box (a message starting with `/goal` is intercepted instead of sent); view / help / errors reply as system messages, create becomes "rewrite the objective" when a goal is unfinished, and budget changes carry a fresh `expectedGoalId` + `expectedUpdatedAt` snapshot. The GoalBanner above the conversation shows the status chip, objective, tokens / turns / live elapsed, budget cap, the latest verification verdict (with the first two `missing` gaps on `not_met`, extra ones counted as `+N`), and a status-tailored action hint; while `active` and waiting on permission / verification the chip switches to a wait label (matching MiniMax goalPresentation), and when a goal turns `complete` the banner hides and a same-source completion receipt is appended to the message stream. Pause / resume / stop are one click away.

The REST surface is `GET /api/agent/goal/:id`, `POST /api/agent/goal` (create; 409 `GOAL_STATUS_CONFLICT` while a goal is unfinished), `POST /api/agent/goal/edit` (rewrite; 400 `GOAL_BAD_OBJECTIVE` for a blank text, 409 when complete), `POST /api/agent/goal/clear` (idempotent removal, returns `{cleared}`), and `POST /api/agent/goal/{pause,resume,stop,budget}`.

Event protocol (shared SSE): `goal_created` / `goal_status_changed` / `goal_usage_updated` / `goal_wait_changed`.

## Configuration

The `goal` section of `auroraagent.config.json` (per-leaf fallback + clamping + startup warning — one bad value never disables the whole mode):

| Field | Default | Meaning |
| --- | --- | --- |
| `verification` | `none` | tier: `none` / `evaluator` / `subagent` |
| `evaluatorModel` | empty | required for evaluator; setting it implies evaluator |
| `evidence` | `brief` | evidence shape: `brief` / `transcript` |
| `repeatedReplyLimit` | 3 | shared breaker threshold |
| `repeatedNotMetLimit` | 5 | consecutive `not_met` (counted only while the gap set is unchanged) before `paused(no_progress)` |
| `graceSteps` | 1 | grace rounds after round / time exhaustion (0–3) |
| `mainTurns` | 0 | continuation round cap, 0 = unlimited |
| `activeSeconds` | 0 | in-turn active seconds cap, 0 = unlimited |
| `evaluatorMaxTokens` | 4096 | evaluator per-request cap |
| `evaluatorTimeoutSeconds` | 60 | evaluator timeout |
| `evaluatorMaxRetries` | 1 | evaluator retry cap |
