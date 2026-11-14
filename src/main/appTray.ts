import { app, Tray, nativeTheme } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appNotify } from "./appNotify.js";
import type { TrayHostDeps, UsagePopupController } from "./usagePopup.js";
import { resolveTrayLeftClickAction } from "./trayClickRoute.js";
import { createRightClickToggle } from "./trayRightClick.js";
import { trayResidentMode } from "../platformCaps.js";

/**
 * Windows resident mode — the tray half.
 *
 * The close button hides the main window instead of quitting (see the
 * win.on("close") interceptor in index.ts), so the tray icon is the app's
 * only guaranteed way back in; the explicit quit path lives in the usage
 * popup footer (right-click). The tray is therefore created *before*
 * close-to-tray is armed: setupResidentTray returns false when it fails,
 * and index.ts keeps the plain close-to-quit behavior instead of stranding
 * a hidden app with no icon.
 *
 * macOS is untouched — trayResidentMode is false there and every export
 * stays inert.
 */

let tray: Tray | undefined;
let hiddenNotifyShown = false;

/**
 * One-shot toast the first time a close hides the window instead of quitting
 * (later hides stay silent — the user already knows the drill).
 */
export function notifyHiddenToTrayOnce(): void {
  if (!trayResidentMode || hiddenNotifyShown) return;
  hiddenNotifyShown = true;
  // Self-owned notification (corner popup — the window is hidden, so the
  // app is background by definition). No system Notification anywhere.
  // Transient by design (no `inbox`): a one-shot orientation hint has
  // nothing to say later, so it must not collect in the message center.
  appNotify({
    title: "Larry Agent is still running",
    body: "The window was hidden to the tray. Left-click the icon to reopen it; right-click for the usage popup (Quit lives in its footer).",
  });
}

/** Windows shell theme can differ from the app theme. */
function resolveResidentTrayIconPath(fallbackPath: string): string {
  const base = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), "resources");
  const name = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
    ? "dogHead-dark.ico"
    : "dogHead-light.ico";
  const path = join(base, "tray", name);
  // A missing optional asset must not disable close-to-tray's return path.
  return existsSync(path) ? path : fallbackPath;
}

/** Create the resident tray icon. Returns true when the tray is live. */
export function setupResidentTray(
  deps: TrayHostDeps,
  iconPath: string | undefined,
  usagePopup: UsagePopupController,
): boolean {
  if (tray) return true;
  if (!trayResidentMode || !iconPath) return false;
  try {
    tray = new Tray(resolveResidentTrayIconPath(iconPath));
  } catch (err) {
    console.error("[tray] create failed — close stays quit", err);
    return false;
  }
  const updateTrayIcon = (): void => {
    if (!tray || tray.isDestroyed()) return;
    try {
      tray.setImage(resolveResidentTrayIconPath(iconPath));
    } catch (err) {
      console.error("[tray] theme icon update failed", err);
    }
  };
  nativeTheme.on("updated", updateTrayIcon);
  app.once("before-quit", () => nativeTheme.off("updated", updateTrayIcon));
  tray.setToolTip("Larry Agent");
  // Click routing (index.ts decides what "open" means): left-click on a
  // closed window reopens it; on an open usage popup it dismisses it
  // (second-click toggle; on macOS the popup takes focus while shown, so
  // a foreground check would misroute that click — tier order covers
  // both platforms); on a visible-but-background window (obscured by
  // another app, or minimized to the taskbar) it brings the window to the
  // front instead of popping the usage panel; only a foreground window
  // toggles the usage popup (usagePopup.ts) anchored at the icon via
  // Tray.getBounds(); right-click always toggles the popup — its footer
  // carries Settings / Quit, so the former Show/Quit context menu is gone.
  tray.on("click", () => {
    if (!tray || tray.isDestroyed()) return;
    const route = resolveTrayLeftClickAction({
      isMainWindowOpen: deps.isMainWindowOpen,
      isMainWindowForeground: deps.isMainWindowForeground,
      isUsagePopupOpen: usagePopup.isOpen,
    });
    switch (route) {
      case "open-window":
        deps.openMainWindow();
        return;
      case "focus-window":
        deps.focusMainWindow();
        return;
      case "usage-popup":
        usagePopup.toggle(tray.getBounds());
        return;
    }
  });
  // Windows fires `right-click` twice per physical click (press + the
  // WM_CONTEXTMENU echo after release) — filter the close-proximity echo
  // while resetting after the echo window so missing echoes never swallow
  // the next gesture (trayRightClick.ts).
  const rightClickToggle = createRightClickToggle((bounds) =>
    usagePopup.toggle(bounds),
  );
  tray.on("right-click", () => {
    if (!tray || tray.isDestroyed()) return;
    rightClickToggle(tray.getBounds());
  });
  return true;
}
