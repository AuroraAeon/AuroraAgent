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

## Vocabulary

Key tokens are capitalized (`Enter` / `Esc` / `Tab` / `Backspace` / `D`); descriptions are lowercase (`navigate` / `select` / `cancel` / `page` / `delete` / `clear`); segments join with ` · `. Leaving a dialog is always `cancel`.
