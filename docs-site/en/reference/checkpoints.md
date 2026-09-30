# Checkpoints & Rollback

Before every user turn, AuroraAgent takes a snapshot of the working directory (a checkpoint). You can later roll the whole workspace back to that snapshot while keeping the session history — the context accumulated in the conversation survives, the code returns to how it was when the turn began, and you can try a different approach.

Snapshots are only taken for top-level user turns: sub-agent changes count as part of the parent turn, and side conversations (`/btw`) are never persisted, so they have nothing to roll back to. A failed snapshot only logs a warning; it never blocks the turn.

## Two snapshot paths

The path is chosen automatically based on whether the working directory is a git repository; no configuration is involved:

| Path | Condition | Snapshot contents | Storage |
| --- | --- | --- | --- |
| Git snapshot | Working directory is a git repo | Every working-tree change, including untracked files not excluded by `.gitignore` | A private ref inside the repo |
| Content mirror | Non-git directory | The original contents of files modified by `write_file` / `edit_file` before the write | `<data dir>/backups/<session id>/<turn>/` |

### Git snapshot

- The snapshot is pinned in the private namespace `refs/auroraagent/checkpoints/<session id>/<turn>`: invisible to you (it never appears in `git stash list`), but it keeps the snapshot objects reachable so git cannot garbage-collect them
- Untracked files are folded in as a third parent commit, so newly created files are restored too
- A persistent scratch index lets git's stat cache skip files unchanged since the previous turn, instead of re-hashing the whole workspace every turn
- When the working tree is clean with no untracked files, the snapshot degrades to a HEAD checkpoint (records the current position; rolling back returns to that commit)

### Content mirror

- Only touched files are mirrored, never the whole workspace, so large repositories stay cheap
- Newly created files are recorded as "did not exist before" and are deleted again on rollback
- The trade-off: files created inside a `shell` process are outside its reach

## Rollback

By default a rollback touches **workspace files only, not the conversation** — the conversation is often the most valuable product, and you may want to retry with a different approach after the code is back. Trimming the conversation requires an explicit choice.

- Both the web and terminal flows show a diff preview first: the files touched after that turn, so you decide with eyes open
- The git path restores inside a transaction: a private snapshot of the current workspace is taken first, then the target checkpoint is applied; if the apply fails, the current state is reset back, and an error is only raised when the reset fails too
- Restoring is refused on repositories whose branch has moved forward: `reset --hard` would silently push those commits off the branch, so refusing beats destroying history
- Trimming the conversation keeps that turn's user message and drops every record after it; an out-of-range turn returns unchanged with a reason

## Web entry

Hovering a user message row reveals a "Roll back here" button. The preview dialog rolls back files by default; "trim the conversation to this turn" must be checked explicitly. Sessions with a turn in flight and side conversations cannot be rolled back.

## Terminal commands

| Command | Effect |
| --- | --- |
| `/checkpoint` | List this session's checkpoints (turn / time / note) |
| `/checkpoint diff <turn>` | Preview before rollback: the files that would change |
| `/checkpoint restore <turn> [chat]` | Roll back; the conversation is trimmed only with `chat` |
| `/checkpoint clean` | Remove every checkpoint for this session |

## HTTP API

| Method and path | Effect |
| --- | --- |
| `GET /api/agent/checkpoints?sessionId=` | List checkpoints (including the snapshot path type) |
| `GET /api/agent/checkpoints/preview?sessionId=&turnIndex=` | Rollback preview: files touched after that turn |
| `POST /api/agent/checkpoints/restore` | Roll back; `restoreFiles` (default true) / `restoreChat` (default false) |
| `DELETE /api/agent/checkpoints` | Clear this session's checkpoints (refs and mirror backups) |

## Limits

- At most 40 checkpoints are kept per session; the oldest are deleted first
- Deleting a session clears its git refs and mirror backup directories
- For sessions never explicitly deleted, scratch directories are reclaimed by a 14-day age sweep
- A successful snapshot emits a `checkpoint_created` event (visible to SSE subscribers)
