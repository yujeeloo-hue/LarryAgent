import { app, BrowserWindow, screen } from "electron";
import type { ComputerUseWindowHost } from "../tools/computerUse/windowAvoidance.js";
import type { Rect } from "../tools/computerUse/types.js";
import { isComputerUseOverlayWindow } from "./computerUseOverlay/overlayWindowRegistry.js";

function liveVisibleWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (win) => !win.isDestroyed() && win.isVisible() && !win.isMinimized() && !isComputerUseOverlayWindow(win),
  );
}

// Computer-use tools address Windows in physical pixels, while Electron reports DIPs.
function toToolCoordinates(win: BrowserWindow): Rect {
  const bounds = win.getBounds();
  return process.platform === "win32" ? screen.dipToScreenRect(win, bounds) : bounds;
}

export function createComputerUseWindowHost(mainWindow?: () => BrowserWindow | null): ComputerUseWindowHost {
  const hidden = new Set<BrowserWindow>();

  return {
    visibleWindowRects: () => liveVisibleWindows().map(toToolCoordinates),

    isAppFocused: () => BrowserWindow.getFocusedWindow() !== null,

    focusMainWindow() {
      const win = mainWindow?.();
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      if (process.platform === "darwin") app.show();
      win.show();
      win.focus();
    },

    hideAll() {
      const windows = liveVisibleWindows();
      if (windows.length === 0) return 0;
      for (const win of windows) hidden.add(win);
      if (process.platform === "darwin") {
        // win.hide() alone keeps JellyBot the active app, so keystrokes would still land here.
        app.hide();
      } else {
        for (const win of windows) win.hide();
      }
      return windows.length;
    },

    restoreAll({ focus }) {
      const windows = [...hidden].filter((win) => !win.isDestroyed());
      hidden.clear();
      if (focus && windows.length > 0 && process.platform === "darwin") app.show();
      windows.forEach((win, index) => {
        if (focus && index === 0) {
          win.show();
          win.focus();
        } else if (!win.isVisible()) {
          win.showInactive();
        }
      });
      return windows.length;
    },
  };
}
