# Terminal TUI

`npm run chat` — same Loop, sessions and ledger as the web client; interactions follow the [terminal design spec](../reference/tui-design).

## Slash commands

`/new` `/sessions` `/model` `/harness` `/think` `/temp` `/max` `/key` `/plan` `/mcp` `/help` `/quit`; every skill also gets a `/<skill-name>` command. Use `npm run chat -- -p "question"` for one-shot prompts.

## Interaction details

- List dialogs: `❯` pointer + `← current` marker + hint line (`↑↓ navigate · Enter select · Esc cancel`)
- Type to search; `Backspace clear`; two-stage Esc (clear query first, then cancel)
- Dim streaming thoughts, single-line tool status, permission prompts `y` / `n` / `a`
- Footer status bar: model · mode · thinking · cwd · tokens / cost
- Character comparison always goes through `printableChar()` (Kitty CSI-u decoding)
