# Terminal Design Spec (Summary)

The canonical spec is the Chinese edition: [终端设计规范](/zh/reference/tui-design). This page summarizes the rules that apply everywhere.

## Visual states

- Selection pointer: `❯ ` in `primary`; selected text is `primary` + bold
- Current / effective item: trailing ` ← current` in `success`
- Dangerous items: `error` (plus bold when selected); dangerous confirmations `[y/N]` are `warning` + bold
- List dialog borders: flat `─` (`primary`), top and bottom only; input boxes use rounded `╭ ╮ ╰ ╯`

## Colors

- Only semantic tokens via the painter; raw SGR is banned outside `theme.mjs` (guard-enforced)
- Palettes (dark / light) pass a contrast audit: text ≥ 4.5:1, secondary ≥ 3:1, borders ≥ 1.5:1, focus border ≥ 3:1
- Hint lines are entirely `textMuted` — no per-key highlighting

## Keyboard

- Arrows navigate, PgUp/PgDn page, Enter selects, Esc cancels, `D` deletes (letter keys require non-searchable lists)
- Character comparison always via `printableChar()`; function keys via `matchesKey`
- Esc is two-stage: clear the query first, cancel second

## Terminal title, notifications, footer

- **OSC title** (`util/tui/title.mjs`): OSC 0 sets window + icon title, assembled in `tui.terminalTitle` item order as `state | session | app` (e.g. "generating | New session | AuroraAgent"); an empty item list disables it. Cleared on exit and suspend, re-set on resume. Dynamic segments are stripped of ESC / BEL / newlines.
- **Notifications** (`util/tui/notify.mjs`): three channels — OSC9, OSC777, bel — selected by `tui.notifications` (`when` × `method` × `events`). `auto` picks OSC777 on known terminals, else OSC9; `unfocused` probes focus via `osascript` (200ms timeout, 3s cache) and treats failure as unfocused. Notifications are async and never block rendering.
- **Footer** (`util/tui/footer.mjs`): one line, `model · harness · thinking · permission [· plan · title · goal · generating · tokens/cost]`; optional segments are trimmed right-to-left when narrow. The goal chip (`accent`) looks like `13K / 50K · 2min30s` (usage / budget · active time; the budget half is omitted when unset). Counts and durations use compact formatting (matching MiniMax): tokens stay raw `<1K`, take `K` `<1M` (rounded when `>=10`, e.g. `12500→13K`), else `M`; time is `Ns` (`<60s`) / `NminNs` (`<60min`, seconds never dropped) / `NhNminNs`.

## Vocabulary

Key tokens are capitalized (`Enter` / `Esc` / `Tab` / `Backspace` / `D`); descriptions are lowercase (`navigate` / `select` / `cancel` / `page` / `delete` / `clear`); segments join with ` · `. Leaving a dialog is always `cancel`.
