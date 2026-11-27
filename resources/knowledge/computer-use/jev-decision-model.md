---
title: Computer Use decision model (Jev)
category: computer-use
summary: "What the optional System One decision model changes in Computer Use (verification, fuzzy OCR, locate, pursue, described waits) and how it behaves when unset."
keywords: [jev, decision model, system one, jevProvider, pursue, locate, verification, expect, 决策模型]
related_tools: [computer_screen, computer_mouse, computer_handoff]
version: 1
updated_at: 2026-11-27
---

## What it is

- An optional, app-global System One decision model (e.g. TypeSafe Jev, Liquid d1, Cloudflare Clef) configured in Setting → Models → Decision model (`jevProvider`: `{ id: "jev", name, baseUrl, modelId }`, key stored as `jev`). Default suggestion: base URL `https://openrouter.ai/api`, model `typesafe/jev-1.14`.
- It speeds up OCR-based Computer Use: picks click targets, checks results and drives short click sequences locally without a full model round per step.
- When it is not configured, Computer Use keeps its non-Jev paths; nothing breaks.

## Effects by tool

| Feature | With decision model | Without |
| --- | --- | --- |
| `computer_mouse click` `expect` | `result.verification` yes / no / unclear plus dialog and error flags — often lets you skip a screenshot | Verification skipped |
| `computer_screen find_text` | OCR misspellings also match | Literal substring match |
| `computer_screen wait_for` | `text` may be a description ("search results are listed") | Literal text only |
| `computer_screen locate` | Returns one center for the described target | Returns OCR lines for you to choose |
| `computer_screen pursue` | Available | Not available |
| `computer_handoff wait_for until=screen_shows` | Description allowed | Literal text only |

## Using pursue well

- Give a short goal reachable with clicks and scrolls only, e.g. "open Settings, then Account".
- It stops before typing, before steps with material effects the goal does not clearly authorize, and whenever unsure; read the returned steps and screen text and continue yourself.
- `max_steps` default 6.

## Limits

- `expect` cannot check keyboard focus or which window is in front (`not_checkable`).
- Verification is based on visible text; confirm critical outcomes yourself.
