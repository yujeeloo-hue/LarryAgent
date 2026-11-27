---
title: Computer Use troubleshooting
category: computer-use
summary: "Symptoms and fixes for common Computer Use failures: no effect, wrong coordinates, permissions, OCR misses, blocked input, batch stops and sign-in loops."
keywords: [troubleshooting, computer use, click no effect, wrong position, permission, ocr, input_blocked, batch stopped, 排障, 失败, 点击无效]
related_tools: [computer_system, computer_mouse, computer_ui, computer_screen, computer_batch, computer_handoff]
version: 1
updated_at: 2026-11-27
---

## Click had no visible effect

- Check `result.delivery.mode`. If it was `background` or `accessibility`, retry ONCE with `borrow_pointer: true`.
- The target may need focus first: click the window (or `computer_ui windows` → click it) before typing.
- The page may still be loading: `computer_screen wait_for` the expected text instead of clicking again.
- Do not repeat the same failing click without new evidence (fresh screenshot, different target, changed state).

## Clicked the wrong place

- Coordinates are global (macOS points, Windows physical pixels). Run `computer_system info` and compare display origins and scale.
- Prefer centers returned by `computer_ui find` / `computer_screen find_text` / `locate` over coordinates estimated from a screenshot.
- With several monitors, secondary displays can have negative coordinates.

## Permissions

- macOS: `computer_system info` shows Accessibility / Screen Recording; `request_permissions` prompts. After granting Screen Recording, the app usually needs a restart.
- Windows: OCR needs an installed OCR language.

## OCR misses text

- Use `lang` `en` for English-only UI, or a tight `region`.
- Text in icons or canvas may not be recognized: try `computer_ui find`, or `capture` + `read_image`.
- Small fonts: capture a smaller region to raise effective resolution.

## Input blocked (Windows)

- `input_blocked` or "Input cannot reach windows of elevated (administrator) apps": the target runs elevated or is on the secure desktop (UAC, lock screen). Hand the step to the user with `computer_handoff`.

## The app's own window is in the way

- Covering windows are hidden automatically (`avoid_occlusion`). `computer_system hide_jellybot` hides them explicitly; they return at turn end or with `show_jellybot`.
- Do not use `computer_ui` on the app's own window; use `computer_screen`.

## Batch stopped early

- Read the stopping reason: failure, changed window, dialog, user takeover or handoff checkpoint.
- Steps after the stop were skipped; any step that may have applied is unknown until verified with a screenshot or `wait_for`.
- Handle dialogs and window switches with single tools, then batch again.

## Sign-in keeps failing

- If a password is already present (autofill / masked characters), click Sign in ONCE and wait for the result before asking for a password.
- On visible rejection use `computer_handoff kind=password sign_in_failed=true`. Never type or request passwords in chat.
- After a handoff is skipped, declined or times out, do not perform that step.

## Typing problems

- Wrong window received keys: make the target frontmost and focused first; verify with `wait_for until=focused` in a batch.
- Sites that detect bots: `speed: "human"` (optionally `interval_ms` / `jitter_ms`).
