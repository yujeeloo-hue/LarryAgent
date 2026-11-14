import type { TrayHostDeps } from "./usagePopup.js";

/**
 * Pure decision for the tray left click's tiers (Windows appTray.ts;
 * macOS menuBarIcon.ts intentionally keeps the two-tier legacy routing).
 * Extracted from the Electron event handler so the tier order is unit
 * tested (trayClickRoute.test.ts) without a live Tray — the handler in
 * appTray.ts applies the resulting action with its TrayHostDeps.
 *
 * Tier order matters and is load-bearing:
 *   1. not open             → reopen the window (hidden-to-tray, Cmd+H);
 *                            even with the popup open, the window wins —
 *                            it blur-closes the popup when it takes focus
 *                            (macOS; the Windows popup is focusless)
 *   2. open + popup shown   → dismiss the popup (second-click toggle,
 *                            preserved from the pre-focus-tier behavior:
 *                            on macOS the popup is focused while shown,
 *                            so the foreground check below would lie
 *                            there; on Windows the popup is focusless and
 *                            this is simply the toggle-close)
 *   3. open, not foreground → bring the window to the front (obscured by
 *                            another app or minimized to the taskbar)
 *   4. open + foreground    → toggle the usage popup (opens it)
 */
export type TrayLeftClickAction =
  | "open-window"
  | "usage-popup"
  | "focus-window";

export type TrayLeftClickRouteDeps = Pick<
  TrayHostDeps,
  "isMainWindowOpen" | "isMainWindowForeground"
> & {
  /** True when the usage popup panel is currently open. */
  isUsagePopupOpen: () => boolean;
};

export function resolveTrayLeftClickAction(
  deps: TrayLeftClickRouteDeps,
): TrayLeftClickAction {
  if (!deps.isMainWindowOpen()) return "open-window";
  if (deps.isUsagePopupOpen()) return "usage-popup";
  if (!deps.isMainWindowForeground()) return "focus-window";
  return "usage-popup";
}
