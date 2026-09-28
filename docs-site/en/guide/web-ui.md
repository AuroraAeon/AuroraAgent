# Web Workbench

`npm run web` serves `http://localhost:8787` (React 19 + Vite 7 + TypeScript; source in `web-ui/`, build committed in `public/app/`, zero build at runtime).

## Layout

- **Sidebar**: brand, new session, session list (relative time, mode, rounds), settings; after the first message of a new session, its title is auto-summarized from that message (local derivation by default, no model call; the composer can also switch to model-summarized titles — one extra small request per new session, falling back to local derivation on failure; manually renamed sessions are kept)
- **Conversation**: streamed answers with an activity line (round / tools / elapsed), collapsible thinking, tool cards (status / params / result / diff / todos), inline permission cards, plan cards, per-round usage footnotes
- **Composer**: auto-growing textarea, `/` slash command menu (commands and skills merged, filtered as you type: argument-free commands run on Enter, the rest complete for you; valid commands get a green hint, unknown ones a yellow hint), `/goal` goal commands (same parser as the terminal, see the [Goal Mode guide](/en/guide/goal-mode)), harness switch, permission mode dropdown, title mode (local / model summary), model picker grouped by provider (its second-level menu carries the thinking effort: standard / off, per session); the plan mode switch moved into the `/plan` command and shows as a status chip in the composer when on
- **Side conversation** (`/btw <question>`): a one-shot temporary branch that inherits the current session history; it is never persisted, never listed, and never takes over the goal. A banner above the composer offers returning to the main conversation or discarding it, and `Ctrl+/` toggles between the two (same key as the terminal)
- **Goal bar** (a single line docked above the composer when a goal exists): status chip, objective, tokens / turns / live elapsed, budget cap, a compact verdict chip, and pause / resume / stop buttons; it hides on completion and the receipt goes to the message stream

## Design discipline

- Semantic tokens live in `web-ui/src/tokens.css`; components never hard-code colors
- Zero emoji; icons are inline SVG
- No CDN, no Markdown / state-management libraries; animations in native CSS
- Hand-written Markdown subset renderer; code blocks go through a zero-dependency highlighter with lossless tokenization
- LaTeX via self-hosted KaTeX (`trust: false`; `\href` / `\includegraphics` / HTML extensions rejected; parse failures fall back to raw source)
