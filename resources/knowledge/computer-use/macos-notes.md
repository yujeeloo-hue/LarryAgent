---
title: Computer Use on macOS
category: computer-use
summary: "macOS specifics: screen-point coordinates, Accessibility and Screen Recording permissions, menu bar and Dock delivery, handoff tips and window capture."
keywords: [macos, computer use, accessibility, screen recording, permissions, screen points, dock, menu bar, capture_app_window, 权限, 辅助功能, 屏幕录制]
related_tools: [computer_system, computer_ui, computer_screen, computer_mouse, computer_handoff, capture_app_window]
version: 1
updated_at: 2026-11-27
---

## Permissions

- Two macOS permissions are required: **Accessibility** (input and the accessibility tree) and **Screen Recording** (screenshots and OCR).
- `computer_system info` shows both statuses with fix hints; `computer_system request_permissions` triggers the system prompts.
- After the user grants Screen Recording the app usually needs a restart before captures work. If info still reports it missing, ask the user to quit and reopen the app.

## Coordinates

- Global coordinates are screen POINTS (not pixels). Retina scale is reported per display by `computer_system info`.
- `computer_screen` without `region` captures the main display; pass a region for other displays.

## Accessibility tree

- Roles are AX roles (`AXButton`, `AXTextField`, `AXSecureTextField`, …); UI Automation names are also accepted.
- `app` accepts a pid, bundle id (e.g. `com.google.Chrome`) or app name.
- `menubar` lists the frontmost app's menu items; `dock` lists Dock icons.

## Delivery

- Menu bar, Dock and Control Center clicks go through accessibility. Most other clicks are delivered straight to the target window without moving the user's cursor.
- `cmd` is the Command key.

## Handoff tips

- `computer_handoff` shows a tip beside the target on macOS (plus the conversation card). A password handoff needs `target.app` to locate the secure field (`AXSecureTextField`).

## Window capture

- `capture_app_window` (macOS only, ScreenCaptureKit) saves the largest visible window of an app (`app_name`, absolute `.png` `output`, optional `window_title`). It needs Screen Recording and a restart after the first grant.
