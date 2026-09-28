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
| Padding | `12px` horizontal / `6px` vertical |
| Title | `12px` / `500`, `6px` gap to the shortcut |
| Key cap `kbd` | `16px` high, `6px` radius, `6px` horizontal padding, `10px` / `500`, `--kbd-bg` / `--kbd-ink`; monospace on non-Apple platforms, system font on Apple |
| Behavior | Shows **instantly** on hover / focus (no delay), `120ms` fade-and-scale, closes on `Esc` or blur, repositions during scroll and resize, only one open at a time |

Menus: compact rows, `8px` rounded shell, low-contrast hover / selected fills, fixed small gaps between option rows. Each submenu is an independent overlay; its shell radius does not inherit the trigger.

## 10. Accessibility and Long Copy

- Keyboard is a first-class path: global shortcuts (`Ctrl/Cmd+K` new session, `Ctrl/Cmd+B` toggle sidebar, `/` focus the composer), unified `:focus-visible` rings.
- Semantic state colors always pair with readable text; never convey state by color alone.
- Layouts tolerate longer translations and narrow windows; icons prefer text labels (tooltips carry the explanation where labels are absent).
- The product contains **zero emoji**; icons are inline SVG or `public/vendors/*.svg` (guard-enforced).

## 11. New / Reworked UI Checklist

- [ ] New colors landed in both themes of `tokens.css` and pass the contrast guard (body 4.5 / faint 3.0).
- [ ] No hard-coded semantic colors in components; everything references tokens.
- [ ] Spacing from the 4 / 8 / 12 / 16 / 20–24 steps; `16px` icon baseline; control heights 28 / 32 / 36 / 38.
- [ ] Radius steps down by visible container nesting; overlays never exceed `14px`; full radius only for pills and circles.
- [ ] Transitions touch only color / opacity / transform; no `transition:all`; `prefers-reduced-motion` considered.
- [ ] Overlays use `--shadow-pop`; hierarchy built on background contrast first.
- [ ] Everything is keyboard-operable; icon-only buttons have tooltips or text labels.
- [ ] Verified in both themes (the guard checks tokens, not layout).
