---
title: Computer Use batches and user handoff
category: computer-use
summary: "Running 2–6 predictable steps in one computer_batch call, its step types and stop rules, and handing steps, passwords, QR codes and confirmations to the user."
keywords: [computer_batch, computer_handoff, batch, handoff, password, qr code, sign in, confirm, 批量, 登录, 密码, 扫码]
related_tools: [computer_batch, computer_handoff, computer_ui, computer_screen, computer_keyboard]
guide_for: [computer_batch, computer_handoff]
version: 1
updated_at: 2026-11-27
---

## When to batch

- 2–6 predictable steps in ONE already-active app window (shortcut → type → wait → click). Every step done inside a batch saves one model round.
- Explore, switch windows or handle dialogs with the ordinary tools; use `computer_handoff` for real user interaction.
- Send `computer_batch` as the ONLY Computer Use call in that response.

## computer_batch arguments

```json
{"app": "Google Chrome", "window_title": "Inbox", "steps": [
  {"action": "press", "keys": ["cmd", "l"]},
  {"action": "type", "text": "https://example.com/reports\n", "target": {"role": "AXTextField", "name": "Address and search bar"}},
  {"action": "wait_for", "until": "appears", "target": {"name": "Monthly report"}, "timeout_s": 4},
  {"action": "click", "target": {"name": "Monthly report"}}
]}
```

- `app` (required): frontmost app name, bundle id or pid. `window_title`: optional title substring verified at the start.
- `steps`: 1–6 items, one of:
  - `click` — `target` by exact `name` / `role` / `automation_id`.
  - `press` — `keys` (1–5, main key last); optional `target` = focused element to verify first.
  - `type` — `text` (≤ 160 chars, single line; a trailing `\n` presses Return) into the exact `target` field. Never passwords.
  - `wait_for` — `until` `appears` | `disappears` | `focused`, `target`, `timeout_s` 0.25–5 (default 2).
  - `handoff` — checkpoint: `kind` `user_action` (default) | `confirmation` | `password` | `qr_code`, `reason` ≤ 200.
- Include `wait_for` to verify results or keyboard focus whenever the app exposes it.

## Stop rules and results

- The batch verifies the window before and after input and stops on a failure, changed window, dialog, user takeover or handoff checkpoint.
- Returns completed and skipped steps, the stopping reason and a fresh screenshot when available.
- Treat any possibly applied step as unknown until verified.
- Put a `handoff` checkpoint before any step that needs user confirmation.

## computer_handoff kinds

| kind | Use |
| --- | --- |
| `action` (default) | A step only the user can do, then Done. Add `wait_for` to finish automatically when the screen changes |
| `choice` | Pick one of 2–6 `options` (`label` ≤ 40, `detail` ≤ 60); `allow_custom` for typed answers |
| `confirm` | Before a destructive or irreversible step (default timeout 5 minutes) |
| `password` | Sign-in password (never in chat or arguments) |
| `qr_code` | Scan a login QR code |

- `title` (required): short imperative or question in the user's language (< ~60 chars). `message`: one sentence. `confirm_label` / `cancel_label`.
- `target`: `region` or an element (`app`, `role`, `name`, `window_title`, `index`) to point at; omitted → corner tip. On macOS a tip appears beside the target plus a conversation card; whichever answers first wins.
- `wait_for`: `until` `appears` | `disappears` (element) | `title_contains` (`app` window title contains `text`) | `screen_shows` (OCR text; with a decision model also a description), checked every 1.5 s. `app` required except for `screen_shows`.
- `timeout_s`: 10–3600; default none (confirm 300).
- Returns outcome, optional choice, `password_present` / `password_filled`, answer channel and wait time. After `skipped`, `declined` or `timeout`, do NOT perform that step.

## Browser sign-in procedure

1. Check for autofill: `password_present=true` (from `computer_ui`) or visible masked characters means the password is already there.
2. If present: click the enabled Sign in button ONCE, then verify the outcome. While sign-in is pending, wait for its result.
3. If it fails and a new password is needed: `computer_handoff kind=password sign_in_failed=true`.
4. If the field is genuinely empty and autofill cannot supply it: `kind=password` without `sign_in_failed`.
5. For password handoffs set `target.app` and focus the real password field, or set `target.region` tightly around it. The desktop card fills a verified field directly.
6. QR login: `kind=qr_code` with `target.region` tightly around the whole code and its blank border.
- Never reveal or request a password in chat, options or tool arguments. Saved logins (Setting → Computer Use → Saved logins) may fill a password without asking.
