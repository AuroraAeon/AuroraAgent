# Screen Control (computer_use)

`computer_use` lets the model look at your screen and drive the frontmost graphical interface: observe with a screenshot first, then click, type, press keys, scroll or launch apps at pixel coordinates taken from that screenshot. Localized from OpenBitFun v1.0.2 #3191, implemented as a zero-dependency macOS subset in `util/agent/computer.mjs`.

## Capability boundary

This subset only assembles built-in macOS commands — no third-party binaries, no native extensions:

- `osascript` (System Events) for window bounds and for dispatching clicks / typing / keys / scrolling
- `screencapture -R<x,y,w,h>` for capture, `sips -Z 1568` to scale the long edge to 1568, and JPEG quality reduction when the result exceeds 1.5MB
- screenshots land in `<data directory>/shots/<session id>/<timestamp>.png` and the whole directory is removed when the session is deleted

Deliberately out of scope (upstream these are Windows/Linux specific or need native extensions): UIA / AT-SPI control trees, direct native window input injection, and a resident background observation loop. That leaves "screenshot plus coordinates" as the only observation channel — the model cannot read a button's name, only guess by pixel position, which is why the standard flow insists on observing before acting.

## Gating and authorization

- `computer_use` is only collected in **Ultimate** mode; Minimal and Standard do not have this tool
- policy defaults to `ask`: **every call needs your explicit confirmation**, and foreground-stealing actions such as activating another app must never silently escalate privileges
- two system authorizations are probed before each call; if either is missing you get Chinese guidance (where the switch is, and that a restart is required) instead of repeated retries against a black screen:
  - Accessibility: System Settings → Privacy & Security → Accessibility
  - Screen Recording: System Settings → Privacy & Security → Screen Recording

## What one call looks like

One call is one "scoped control session": declare the scope (target app; omitted means the current frontmost app's window) → a batch of actions (max 40 per call) → a receipt per action → an observation freshness note.

| Action | Params | Effect |
| --- | --- | --- |
| `observe` | — | Screenshot cropped to the target window (full screen when bounds are unavailable); the image is returned to the model with the tool result |
| `click` / `double_click` / `right_click` | `x` `y` | Click at global screen coordinates (top-left origin) |
| `type` | `text` | Type text; newlines are dispatched as the return key |
| `key` | `key` | A key such as `return` / `tab` / `escape` / `up` / `cmd+c` |
| `scroll` | `dx` `dy` | Scroll deltas; negative `dy` scrolls up |
| `wait` | `ms` | Wait, capped at 5000ms |
| `open_app` | `app` | Activate an app (needs the Automation permission) |

On the web you get a screenshot thumbnail you can click to enlarge; the terminal only prints the path and size summary. The screenshot also enters the model context as a multimodal tool result (OpenAI `image_url` / Anthropic `tool_result` image block), so later rounds still "remember" what was seen.

An abort (stop button / `Ctrl+C`) cascades: no further actions are dispatched and the running child process is killed, leaving no stray processes.

## When not to use it

Batch repetitive work (the same click a hundred times) does not suit it: every call needs confirmation, and the model's coordinate judgment goes stale as the interface changes. Re-`observe` whenever the interface changes; do not click a new interface using an old screenshot.
