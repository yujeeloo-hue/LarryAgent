---
title: Computer Use input and screen tools
category: computer-use
summary: "Coordinates, locating targets (accessibility, OCR, screenshots), mouse and keyboard semantics, delivery modes and the look → act → verify loop for computer_* tools."
keywords: [computer use, computer_mouse, computer_keyboard, computer_ui, computer_screen, computer_system, coordinates, click, ocr, accessibility, 截图, 点击, 坐标]
related_tools: [computer_system, computer_mouse, computer_keyboard, computer_ui, computer_screen, computer_batch, computer_handoff, read_image]
guide_for: [computer_system, computer_mouse, computer_keyboard, computer_ui, computer_screen]
version: 1
updated_at: 2026-11-27
---

## Core loop

1. **Look** — find the target with the cheapest reliable source: `computer_ui` (accessibility tree) → `computer_screen locate` / `find_text` (OCR) → `computer_screen capture` + `read_image` only when the first two cannot see it.
2. **Act** — one input (`computer_mouse`, `computer_keyboard`, `computer_ui click`), or a `computer_batch` for 2–6 predictable steps in one window.
3. **Verify** — `computer_screen wait_for` (or a click's `expect` with a decision model), not a shell sleep or repeated screenshots.

Each model round is the slowest part of computer use: batch predictable steps, use `wait_for` / `locate` / `pursue`, and avoid capture-then-read_image loops.

## Coordinates

- Global coordinates everywhere: macOS screen points; Windows physical pixels. Secondary displays may have negative coordinates.
- `computer_system info` reports displays (origin / size / scale), permissions with fix hints, helper version and the frontmost pid — check it first when coordinates or permissions look wrong.
- `region` = `[x, y, width, height]` in the same global coordinates. Omitted region: macOS main display; Windows all displays.

## computer_system

- `action`: `info` (default) | `request_permissions` (macOS prompts) | `hide_jellybot` | `show_jellybot` (`focus` optional). Permission level 0.
- The app hides its own windows automatically when they cover a target or hold keyboard focus (`avoid_occlusion`, default true); they come back when the turn ends.
- Never drive the app's own UI through `computer_ui` (reading its own accessibility tree in-process traps the app); look at it with `computer_screen`.

## computer_ui (accessibility)

- `windows` — an app's on-screen windows and whether it is frontmost (a listed window means the app is running; click it to activate).
- `find` — elements by `role` and/or `name` (exact > prefix > substring, case-insensitive) in `app` (pid, macOS bundle id or app name, Windows process name or window title); optional `window_title`, `timeout` (default 5 s). Returns frames and centers.
- `click` — find then click match `index` (default 0); `dry_run` returns the target only.
- `dock` — Dock / taskbar icons (click to launch or activate). `menubar` — menu items of the frontmost app (`menu` filter, e.g. `File` / `文件`). `hit_test` — element at (`x`, `y`).
- Roles accept either vocabulary: `AXButton` / `ButtonControl` / `Button`.

## computer_screen (screenshots and OCR)

| action | Use |
| --- | --- |
| `capture` | Save PNG (optional `region`, `path`) and show it; inspect with `read_image` |
| `find_text` | OCR for `text` (substring, case-insensitive), returns a center ready to click; `index` for later matches |
| `read_text` | Every recognized line with centers |
| `wait_for` | Poll every 0.7 s until `text` shows (up to `timeout_s`, default 10) |
| `locate` | Element matching a description (`target`); one center with a decision model, otherwise OCR lines to choose from |
| `pursue` | Decision model only: reach a short `goal` with up to `max_steps` (default 6) local clicks / scrolls |

- `lang`: `zh-Hans` (default, also reads English) | `en`.
- `wait_for`, `locate`, `pursue` read the front window (or `app`'s window), else the whole screen.
- `pursue` stops before typing, before any step with a material effect the goal does not clearly authorize, and whenever unsure; it returns steps done and the current screen text.

## computer_mouse

- `action`: `position` | `move` | `click` | `drag` | `scroll` | `hold` | `release`.
- `click`: optional `x` / `y` (omit to click in place), `button` left|right|middle, `clicks` 1–3, `modifiers` (e.g. `["cmd","shift"]`; `cmd` = Ctrl on Windows), `hold` seconds (default 0.05), `duration` glide.
- `drag`: `from_x`, `from_y`, `to_x`, `to_y`. `scroll`: at the pointer, `delta_y` > 0 up / < 0 down, `delta_x` > 0 right, `unit` line (default) | pixel.
- `expect`: visible text you expect after a click; with a decision model `result.verification` says yes / no / unclear plus dialog / error flags. Not for keyboard focus or window order (`not_checkable`).
- You drive your own virtual pointer; the user's cursor does not move. Delivery (`result.delivery.mode`): `background` (straight to the window; clicking activates the app), `accessibility` (sliders, title-bar moves / edge resizes, macOS menu bar / Dock / Control Center, Windows taskbar / Start / tray / UWP-WinUI), or `borrowed` (physical cursor briefly moved and restored: bare desktop, cross-app drag and drop, some web drag handlers, Windows clicks with modifiers).
- If a delivered action had no visible effect, retry ONCE with `borrow_pointer: true`.

## computer_keyboard

- Input goes to the focused app — make sure the right window is frontmost first.
- `press` — one `key` (`return`, `tab`, `esc`, `space`, `backspace`, `delete`, arrows, `home`, `end`, `pageup`, `pagedown`, `f1`–`f12`, or one character of any script) with optional `modifiers` (`cmd` / `ctrl` / `shift` / `alt` (option) / `win` / `fn`).
- `combo` — `keys`: modifiers then the main key, e.g. `["cmd","c"]`.
- `type` — `text` char by char (newlines press Return). `speed` auto (default: URLs and text ≥ 24 chars fast, short text human-paced) | fast | human; `interval_ms` / `jitter_ms` for human pacing when a site watches typing rhythm.
- Never type passwords; use `computer_handoff kind=password` (read_knowledge("computer-use/batch-and-handoff")).

## Permissions and dry runs

- `computer_system` and `computer_handoff` are level 0; mouse, keyboard, ui, screen and batch are level 1 (Bypass permissions).
- `dry_run: true` returns the plan without acting (mouse, keyboard, ui click).
- Platform specifics: read_knowledge("computer-use/windows-notes") / read_knowledge("computer-use/macos-notes"). Failures: read_knowledge("computer-use/troubleshooting").
