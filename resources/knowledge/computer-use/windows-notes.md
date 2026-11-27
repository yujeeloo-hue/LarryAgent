---
title: Computer Use on Windows
category: computer-use
summary: "Windows specifics: physical-pixel coordinates, UI Automation roles, taskbar and Start delivery, OCR language packs, elevated windows and secure desktop limits."
keywords: [windows, computer use, ui automation, dpi, physical pixels, elevated, uac, ocr language, taskbar, 管理员, 屏幕识别]
related_tools: [computer_mouse, computer_keyboard, computer_ui, computer_screen, computer_system]
version: 1
updated_at: 2026-11-27
---

## Coordinates and displays

- Global coordinates are PHYSICAL pixels; secondary displays may have negative coordinates. Use `computer_system info` for each display's origin, size and scale.
- `computer_screen` without `region` covers all displays.

## Accessibility (UI Automation)

- `computer_ui` uses Windows UI Automation. Roles use control-type names (`ButtonControl`, `EditControl`, …) but AX-style names (`AXButton`) and short names (`Button`) are accepted.
- `app` accepts a pid, process name or window title.
- `computer_batch` targets may use `automation_id` when known — the most stable identifier on Windows.

## Mouse and keyboard

- `cmd` in modifiers and combos means Ctrl. `win` is the Windows key.
- Taskbar, Start, system tray and UWP / WinUI clicks are delivered through accessibility.
- Clicks WITH modifiers borrow the physical cursor briefly and restore it.
- Clicking a window activates its app, like a real click; `computer_ui dock` lists taskbar buttons to launch or activate apps.

## OCR

- OCR uses the Windows OCR engine and needs an OCR language installed (Settings → Time & language → Language → add the language with its optical character recognition feature). `lang` `zh-Hans` reads Chinese and English.

## Elevated windows and secure desktop

- Input cannot reach windows of elevated (administrator) apps unless the app itself runs elevated. The worker reports `input_blocked` ("SendInput was blocked … The target may be an elevated window or a secure desktop").
- UAC prompts, the lock screen and Ctrl+Alt+Del screens run on the secure desktop and cannot be driven. Hand these steps to the user with `computer_handoff kind=action`.
