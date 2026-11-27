import { app, Tray, nativeTheme } from "electron";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { appNotify } from "./appNotify.js";
import type { TrayHostDeps, UsagePopupController } from "./usagePopup.js";
import { resolveTrayLeftClickAction } from "./trayClickRoute.js";
import { createRightClickToggle } from "./trayRightClick.js";
import { trayResidentMode } from "../platformCaps.js";


let tray: Tray | undefined;
let hiddenNotifyShown = false;

export function notifyHiddenToTrayOnce(): void {
  if (!trayResidentMode || hiddenNotifyShown) return;
  hiddenNotifyShown = true;
  appNotify({
    title: "Larry Agent is still running",
    body: "The window was hidden to the tray. Left-click the icon to reopen it; right-click for the usage popup (Quit lives in its footer).",
  });
}

function resolveResidentTrayIconPath(fallbackPath: string): string {
  const base = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), "resources");
  const name = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI
    ? "dogHead-dark.ico"
    : "dogHead-light.ico";
  const path = join(base, "tray", name);
  return existsSync(path) ? path : fallbackPath;
}

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
  const rightClickToggle = createRightClickToggle((bounds) =>
    usagePopup.toggle(bounds),
  );
  tray.on("right-click", () => {
    if (!tray || tray.isDestroyed()) return;
    rightClickToggle(tray.getBounds());
  });
  return true;
}
