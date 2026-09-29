# Web Design Spec

> This file is the single source of truth for the AuroraAgent web workbench (`web-ui/`) visuals and interaction. Read it before adding or reworking any interface, and check your work against the checklist at the end.
> It distills the reusable parts of ZCode's `DESIGN.md` into this project's zero-dependency CSS. The terminal counterpart is `tui-design.md`; the two do not overlap.
> Implemented in `web-ui/src/tokens.css` (design tokens, dual theme) and `web-ui/src/app.css` (component styles). Token contrast and motion discipline are enforced by `test/guards.mjs`.

---

## 1. Product Character

The interface aims for **calm, dense, and operational** rather than decorative. Design for:

- Long sessions: dozens of tool rounds per task, so visual noise must stay low
- High information density: express density through text hierarchy (primary / secondary / faint), not through more borders and colors
- Keyboard-driven workflows: shortcuts are a first-class interaction path
- Dual themes: dark by default, light via same-named variable overrides

Avoid marketing-style spacing, large brand-color fills, playful gradients as the default language, and ambiguous hierarchy between background, card, and overlay surfaces.

## 2. Design Token Roles

Components must never hard-code semantic colors; always reference `tokens.css` variables. Dual themes work through same-named overrides in `:root` (dark) and `:root[data-theme="light"]` (light), with zero component code changes.

| Role | Tokens | Usage |
| --- | --- | --- |
| Page / workspace background | `--bg` | Bottom-most app background |
| Panel / sidebar | `--panel` / `--sidebar-fill` | Structural surfaces; sidebar has its own fill plus hover / active interaction levels |
| Low-elevation container | `--surface` / `--surface-hover` | Cards, input areas, other low-level surfaces |
| Lines | `--line` / `--line-strong` / `--panel-line` | Default border, strong border, panel separator |
| Text primary / secondary / faint | `--text` / `--dim` / `--faint` | Body, metadata, placeholders and weakest hints |
| Accent | `--accent` / `--accent-hi` / `--accent-soft` / `--accent-line` | The single accent source (blue segment of the brand mark); never a large fill |
| Semantic state | `--ok` / `--warn` / `--danger` / `--think` (each with `-ink` / `-bg` / `-line` variants) | Success / warning / danger / thinking; only for real semantics, never to make a block louder |
| Diff view | `--diff-add` / `--diff-del` / `--diff-meta` | Added / removed lines and metadata; do not substitute success / danger colors |
| Overlays | `--tooltip-bg` / `--tooltip-line` / `--tooltip-ink`, `--kbd-bg` / `--kbd-ink`, `--shadow-pop` / `--shadow-card` | Tooltips, key caps, overlay shadows |

New colors must land in both themes and pass the guard's WCAG thresholds (body ≥ 4.5:1, faintest metadata ≥ 3.0:1).

## 3. Typography

- Body text uses the `15px/1.65` system stack (`-apple-system` → `PingFang SC` → …); paths, commands, code, identifiers, and shortcuts are always monospace.
- Hierarchy comes from weight and color: labels and headings use `500`; avoid heavier weights.
- Do not rely on truncation as the only way a component survives long copy; layouts must tolerate longer translations.

## 4. Spacing Rhythm

Base unit is `4px`. Repeat only a few steps; no arbitrary values:

| Step | Usage |
| --- | --- |
| `4px` | Tight icon-to-text spacing |
| `8px` | Control padding and inline gaps |
| `12px` | Dense list rows and menu rows |
| `16px` | Standard card and panel padding |
| `20px`–`24px` | Larger section breaks and dialog interiors |

## 5. Icon and Control Sizes

- **`16px` is the default icon baseline**; secondary toolbar icons may use `13`–`15px` but stay consistent within a screen.
- Three control heights dominate: `28px` (icon buttons / compact controls), `32px` (list rows), `36px` (section heads); primary buttons `38px`. Reuse existing steps instead of inventing new height systems.
- Icon-only buttons stay square. Do not promote every action to primary; keep a clear action hierarchy within each panel.

## 6. Radius Hierarchy

Radius steps down by nesting of **visible rounded containers**, not by component importance:

- Containers: `14px` (`--radius`) → `12px` → `10px` → `8px` → `6px` → `4px`
- Overlays (dialogs / menus / tooltips) never exceed `14px`: tooltip and menu shells `8px`, key caps and small inline pieces `6px`
- `99px` / `999px` are reserved for pills and circles; buttons, tags, and counters do not qualify merely by component type

## 7. Overlays and Elevation

Build hierarchy primarily through **background contrast and borders**, then restrained shadows: menus / tooltips / dialogs use `--shadow-pop`, ordinary cards use `--shadow-card`. No large soft shadows for ordinary layout. Overlay surfaces (e.g. `--tooltip-bg`) sit quietly above content and never blend with card backgrounds.

## 8. Motion

- Transition only **color / opacity / transform**; three durations `120ms` / `150ms` / `180ms` with the unified `--ease` curve.
- Overlay entrances use `@starting-style` (fade plus slight scale, `120ms`); disabled under `prefers-reduced-motion: reduce`.
- **`transition:all` is forbidden** (guard-enforced). ZCode lesson: in long sessions and continuous interactions it batches non-composited animations such as scrollbar color and sizing, amplifying main-thread style / layout pressure.
- Motion clarifies state change; it does not decorate the screen.

## 9. Menu and Tooltip Density Language

Tooltip spec (replicating ZCode's `ControlHintTooltip`, implemented dependency-free in `ControlTooltip.tsx` + `.ct-tip`):

| Part | Spec |
| --- | --- |
| Shell | `8px` radius, `1px` `--tooltip-line` border, `--tooltip-bg` fill, `--shadow-pop` |
| Padding | `10px` horizontal / `4px` vertical; `4px` right when a key cap is present; `12px` / `8px` when a description is present |
| Title | `12px` / `500`, `8px` gap to the shortcut (`6px` with a description) |
| Key cap `kbd` | `16px` high, `6px` radius, `6px` horizontal padding, `10px` / `500`, `--kbd-bg` / `--kbd-ink`; monospace on non-Apple platforms, system font on Apple |
| Behavior | Shows **instantly** on hover / focus (no delay), `120ms` fade-and-scale, closes on `Esc` or blur, repositions during scroll and resize, only one open at a time |

Menus: compact rows, `8px` rounded shell, low-contrast hover / selected fills, fixed small gaps between option rows. Each submenu is an independent overlay; its shell radius does not inherit the trigger.

## 10. Workspace Header and Top Overlay

The Header is always-on at `48px` (ZCode `h-12`): the inner row uses `p-2` / `gap-2` / `justify-between` / `overflow-hidden`, and the title area sizes to its content instead of stretching (its parent is the drag region; stretching it would leave blank space undraggable). The divider is an inset shadow rather than a border (it does not participate in layout, so it aligns exactly with the top of the main area).

- **Left group** (`gap-1`): workspace context button (`28px` ghost square; hover reveals an info card, click pins it — workspace path with `~` abbreviation, last activity, git branch, the branch read straight from `.git/HEAD` by `GET /api/workspace`), session title (`14px` / `600`, `max-width:400px`, container-query narrow tiers `30vw` / `22vw`, double-click to rename in place), and a more menu (`28px` ghost, closes on select)
- **Right group** (`gap-0.5`): help menu (docs / feedback links plus the shortcut and about panels; the trigger carries a "Help" tooltip, matching ZCode's ControlHintTooltip wrapping the DropdownMenuTrigger) + settings
- **Top overlay** (ported from ZCode `DesktopTopOverlay`): always-on absolute layer with `pointer-events:none` outside and `auto` on the interactive container — clicks on blank space still belong to the sidebar below; the toggle button shows a `20px` brand tile (radius `6px`) at rest and fades in a `16px` panel icon on hover (absolutely centered), with a tooltip reading "toggle sidebar + ⌘B/Ctrl+B"; back / forward (session navigation history, ported from ZCode `taskNav`: a browser-style back/forward stack, disabled at the stack ends, with `Ctrl/Cmd+[` and `Ctrl/Cmd+]` bound to the same actions — a clean division of labor with the ladder track TurnNavigator along the conversation edge: that one walks previous / next question within a session, this one walks sessions); the new-task button follows the `isNewTaskButtonVisible` semantics with a `opacity` / `width` `300ms` transition (visible only when collapsed, icon taken from lucide's exact `MessageCirclePlus` path — a chat bubble plus a plus sign, not a bare plus); the update entry appears only when a new version is found (ZCode lesson: the collapsed state must not hide global entries behind a width threshold)
- **Yielding**: when the sidebar collapses, the Header row pads its left edge (measured overlay width + `8px`); the sidebar reserves a `48px` overlay band at its top; the main column auto-collapses the sidebar below `360px` (collapse only, never auto-expand)
- **Sidebar body** (ported from ZCode `WorkspaceSidebar`): the expanded state has no large logo — the `aside` starts with a `48px` empty drag band (the overlay floats above it) and the brand lives only inside the overlay toggle button; session rows are `32px` (ZCode `TaskListItem`): a `10px` left inset + a `16px` leading slot + an `8px` gap shift the title right, and the slot carries a `14px` grey spinner while the session runs (the spinner means "this session has live work" — switching sessions mid-run is allowed and the old turn keeps going, so the spinner is driven by a per-session id set rather than derived from "current session + busy"; `prefers-reduced-motion` slows the rotation); the first item below the band is the new-task button (ZCode `NewTaskButtonGroup`: `w-full h-8 rounded-lg` ghost, `pl-2.5 pr-2.5 gap-2`, `MessageCirclePlus 16px` + "new task" + a `12px` shortcut label on the right; no tooltip in the normal state — the button already shows its label and shortcut, another tooltip would just repeat them); appearance lives in the settings dialog's "Appearance" first-level section (ZCode `appearance` section): the interface theme is a `Select` dropdown (`260px`, options carry `Monitor` / `Moon` / `Sun` icons plus a check indicator), not a segmented control — with icons the segmented control cannot fit them, and the dropdown matches the rest of the settings page (full option set in section 13)
- Entry buttons share one spec: `28px` + radius `8px` + only background / color transitions (ZCode lesson: `transition-all` animates size changes while resizing the window)

## 11. The Composer (ported from ZCode `ChatPromptEditor`)

- **Input shell**: `border-radius:16px`, `12px` padding, `12px` block gap; `:focus-within` only swaps the border and background colors, with no glow — a focused state should not light up like an error.
- **Toolbar**: `flex` + `align-items:flex-end` + `gap:12px`, always a single line, never wrapping; the left group is `flex:1 min-width:0` (content left-aligned; compression eats blank space), the right group is `margin-left:auto` + `shrink:0` + `gap:6px` (model picker and send / stop pinned right).
- **Entry buttons**: every toolbar entry shares one spec — `28px` ghost square (radius `8px`, no border, `padding:0 8px`, `4px` icon-to-label gap, background / color transitions only) — plus, harness, permission and title alike; no new height tiers. Send is a `28px` brand button (`IconArrowUp`), swapping to a neutral square stop button while generating.
- **"Add context" plus menu**: the first button of the left group (reusing the zero-dependency `Menu`: portal singleton root, full ARIA keyboard set, Esc / Tab / outside-click close). Two items: **upload files** — reads local text files and inserts them as `<file name="…">…</file>` blocks in the composer (the backend has no attachment storage, so inserting content is the landed form of "add context" and the model can read it immediately; `200KB` per file, at most `5` per batch, with binary / oversized files given a clear reason and a next step instead of silent drops); **reference workspace files** — appends a single `@` at the end, raising the existing mention palette (the same read-only file search behind `@` mentions).
- **Narrow-screen fitting**: when the toolbar overflows, the whole group collapses to icon buttons (text labels hidden, buttons stay square); it neither widens nor wraps — the composer width stays stable and never jumps as labels appear and disappear (ZCode `useComposerToolbarFit` first tier).

## 12. Conversation Timeline Density (ported from ZCode Message / Reasoning / ToolSummaryRow)

A run of tool calls during streaming must not become a stack of cards. The summary row is a **borderless inline row**: `align-self:flex-start` + `width:fit-content` hugging its content, one line of icon (14px, dim) + kind (weight 500) + resource (monospace, truncated, no chip) + status word, `gap:8px`, `3px` vertical padding — one call occupies one line.

- **The expand chevron is hidden at rest**: it fades in only when hovering the summary row (`opacity:0 → 1`) and stays visible rotated `225°` when expanded (ZCode: `opacity-0 group-hover:opacity-100` + `rotate-90`).
- **Full content is collapsed by default**: params / output / diff / todos / sub-agent roster render only after expanding, dropping into a panel below the row with its own border and background (radius `10px`) — zero footprint collapsed, a real container expanded.
- **Semantic borders live on the expanded panel only**: accent for the authorization (ask) state, danger for failed / rejected; collapsed rows carry state through the status word color instead of outlining the row.
- **While running**: the status word shows "executing" inline (animated dots + text), no extra row, no box; failure reasons go to a hover tooltip on the status word (ZCode `statusTooltip` semantics).
- Sub-agents indent `18px` with a `2px` accent hairline marking hierarchy instead of starting a new card.

**Message rows** (ported from ZCode `Message` / `MessageContent`): **no avatars** — neither user nor assistant renders one; hierarchy comes from alignment and fill color, not decoration. User messages push the whole row right with `justify-end`, the bubble hugs its content (`width:fit-content`, capped at `max-width:min(640px,82%)`), radius `8px`, `--surface-hover` fill, `10px 16px` padding, all four corners rounded (no bubble tail). Assistant messages sit left and fill the column (`w-fit` grows naturally with content), with thinking / tools / prose interleaved in order of occurrence. System (compaction) and notice rows take a muted strip form instead of competing with the conversation.

**Thinking process** (ported from ZCode `Reasoning` / `ReasoningTrigger`): the same density language as tool summaries — a borderless inline row: brain icon `16px` (the exact lucide `brain` path, ZCode `size-4`) + a "thinking / thought" label (weight 500, subtlest color, whole row brightens on hover), `gap:8px` throughout, text at `text-ui-base` (`1rem`, scales with the UI font size). While streaming and collapsed the label shimmers in color only (color-only animation, frozen under `prefers-reduced-motion`), a `·` separator follows the label, and the last non-empty line trails on the right as a single-line rolling summary (fixed-width viewport pushed to the end as tokens grow, masked by a `16px` fade on both sides only when overflowing — the newest thought always stays visible; ZCode `resolveReasoningStreamingSummary` + `getReasoningSummaryMaskStyle`). The `16px` chevron is transparent at rest, appears on hover, and turns `90°` when expanded. Expanded content: a `12px` top offset + `8px` left offset + a `1px` guide line on the left + `14px` indent, capped at `240px` with internal scrolling, rendered as **plain text** (no Markdown — re-parsing long thoughts on every streaming chunk drops frames, the same trade-off ZCode makes). **Both streaming and completed states start collapsed** (ZCode: a default-open streaming reasoning keeps squeezing tools and prose, so only the running caption stays); it auto-collapses when streaming ends unless the user manually expanded it (ZCode `autoCollapse` semantics). The body is stripped of leading blank lines first (models often emit `\n\n` before the thought, which would otherwise leave the first expanded line blank). Body normalization, summary resolution and overflow detection live in the pure-function layer `web-ui/src/reasoning.mjs` (Node tests import the same file). The duration caption ("thought · Ns") is deliberately **not** ported: the projection layer records no thinking start/end timestamps, and inventing seconds would be fabrication, so only the "thought" label remains.

## 13. Appearance Settings

The settings dialog's "Appearance" first-level section (ported from ZCode's `appearance` section, `Palette` icon, placed right after "General") carries three blocks, all browser-local (`localStorage` persistence, pre-seeded before first paint by the inline script in `index.html`):

- **Interface settings**: interface theme (`Select` dropdown, `260px`; `System` / `Dark` / `Light` options carry `Monitor` / `Moon` / `Sun` icons plus a check indicator) + interface font size (`12–20px` number field, commits on blur or Enter, clamped, Esc restores the draft).
- **Code settings**: light and dark code themes, one `Select` each (`Default (Aurora)` / `GitHub` / `Vitesse` / `Catppuccin` / `High contrast`, each with its own `--code-key/str/num/com/fn/type` palette — the zero-dependency highlighter colors by token class, no Shiki) + show line numbers (`Switch`) + wrap long lines (`Switch`) + code font size (`12–20px`, independent of the interface font size).
- **Code preview**: two cards side by side rendering a real Markdown code block, each overriding the palette variables; the card matching the current interface mode is badged "Active".

Two engineering rules:

- **Interface font size moves text only**: every `font-size` in `app.css` is rem-based (`1rem` = interface font size) with unitless line-height ratios that scale along; icons, spacing and radii stay in `px` (mirroring ZCode's "update only the font-size base variable" discipline).
- **Line numbers follow the preference structurally**: `Markdown` splits the highlighted token sequence per line and renders line by line, with the number pinned to the scrolling left edge via `position:sticky` and a backdrop covering scrolled code; preferences broadcast through a tiny external store (`useSyncExternalStore`), so toggling the setting re-renders immediately.

## 14. Accessibility and Long Copy

- Keyboard is a first-class path: global shortcuts (`Ctrl/Cmd+K` new session, `Ctrl/Cmd+B` toggle sidebar, `Ctrl/Cmd+[` back and `Ctrl/Cmd+]` forward, `/` focus the composer), unified `:focus-visible` rings.
- Semantic state colors always pair with readable text; never convey state by color alone.
- Layouts tolerate longer translations and narrow windows; icons prefer text labels (tooltips carry the explanation where labels are absent).
- The product contains **zero emoji**; icons are inline SVG or `public/vendors/*.svg` (guard-enforced).

## 15. New / Reworked UI Checklist

- [ ] New colors landed in both themes of `tokens.css` and pass the contrast guard (body 4.5 / faint 3.0).
- [ ] No hard-coded semantic colors in components; everything references tokens.
- [ ] Spacing from the 4 / 8 / 12 / 16 / 20–24 steps; `16px` icon baseline; control heights 28 / 32 / 36 / 38.
- [ ] Radius steps down by visible container nesting; overlays never exceed `14px`; full radius only for pills and circles.
- [ ] Transitions touch only color / opacity / transform; no `transition:all`; `prefers-reduced-motion` considered.
- [ ] Overlays use `--shadow-pop`; hierarchy built on background contrast first.
- [ ] Everything is keyboard-operable; icon-only buttons have tooltips or text labels.
- [ ] Verified in both themes (the guard checks tokens, not layout).
