import { app, BrowserWindow, ipcMain, screen } from "electron";
import type { Rectangle } from "electron";
import { join } from "node:path";
import { readWorkspaceSettings } from "../settings/index.js";
import { resolveThemeId } from "../settings/types.js";
import {
  clampUsagePopupHeight,
  computeUsagePopupRect,
  USAGE_POPUP_DEFAULT_HEIGHT,
  USAGE_POPUP_WIDTH,
} from "./usagePopupGeometry.js";
import {
  HOVER_ANCHOR_MARGIN_PX,
  HOVER_DWELL_MS,
  HOVER_PANEL_MARGIN_PX,
  HOVER_POLL_MS,
  nextHoverLeaveState,
  type HoverNearRect,
} from "./usagePopupHover.js";


export const USAGE_POPUP_ACTION_CHANNEL = "usagePopup:action";
export const USAGE_POPUP_PRESENT_CHANNEL = "usagePopup:present";

export type UsagePopupAction =
  | { type: "close" }
  | { type: "resize"; height: number }
  | { type: "new-task" }
  | { type: "settings" }
  | { type: "quit" };

export type UsagePopupPresentPayload = {
  theme?: string;
  accentColor?: string | null;
  visible: boolean;
};

export type UsagePopupDeps = {
  getMainWindow: () => BrowserWindow | undefined;
  onNewTask: () => void;
  onSettings: () => void;
  onQuit: () => void;
};

export type UsagePopupController = {
  toggle: (trayBounds: Rectangle) => void;
  close: () => void;
  isOpen: () => boolean;
  prewarm: () => void;
};

export type TrayHostDeps = {
  isMainWindowOpen: () => boolean;
  openMainWindow: () => void;
  isMainWindowForeground: () => boolean;
  focusMainWindow: () => void;
};

const BLUR_CLOSE_DEBOUNCE_MS = 100;

const FOCUSABLE_POPUP = process.platform === "darwin";

function macPanelBackground(theme: string): string {
  if (theme === "light") return "#ffffff";
  return "#1b1b1b";
}

const MAC_LIGHT_PANEL_OPACITY = 0.95;

async function resolvePopupAppearance(): Promise<{
  theme: string;
  accentColor: string | null;
}> {
  try {
    const settings = await readWorkspaceSettings(app.getPath("userData"));
    return {
      theme: resolveThemeId(settings),
      accentColor: settings?.accentColor ?? null,
    };
  } catch {
    return { theme: "dark", accentColor: null };
  }
}

function sameRect(a: Rectangle, b: Rectangle): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

function loadPopupPage(win: BrowserWindow, query: Record<string, string>): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, "");
    const params = new URLSearchParams(query);
    void win.loadURL(`${base}/usage-popup.html?${params.toString()}`);
    return;
  }
  void win.loadFile(join(__dirname, "../renderer/usage-popup.html"), {
    query,
  });
}

export function setupUsagePopup(deps: UsagePopupDeps): UsagePopupController {
  let popupWin: BrowserWindow | null = null;
  let blurTimer: ReturnType<typeof setTimeout> | null = null;
  let creating: Promise<void> | null = null;
  let pageReady = false;
  let pendingShow = false;
  let quitting = false;
  let hoverTimer: ReturnType<typeof setInterval> | null = null;
  let hoverOutsideSince: number | null = null;
  let lastHeight = USAGE_POPUP_DEFAULT_HEIGHT;
  let lastLayout: {
    trayBounds: Rectangle;
    workArea: Rectangle;
    displayBounds: Rectangle;
  } | null = null;

  function cancelBlurTimer(): void {
    if (blurTimer) {
      clearTimeout(blurTimer);
      blurTimer = null;
    }
  }

  function stopHoverWatch(): void {
    if (hoverTimer) {
      clearInterval(hoverTimer);
      hoverTimer = null;
    }
    hoverOutsideSince = null;
  }

  function startHoverWatch(win: BrowserWindow): void {
    if (FOCUSABLE_POPUP) return;
    stopHoverWatch();
    hoverTimer = setInterval(() => {
      const w = popupWin;
      if (!w || w !== win || w.isDestroyed() || !w.isVisible()) {
        stopHoverWatch();
        return;
      }
      let cursor: { x: number; y: number } | null = null;
      try {
        cursor = screen.getCursorScreenPoint();
      } catch {
        cursor = null;
      }
      const near: HoverNearRect[] = [
        { bounds: w.getBounds(), margin: HOVER_PANEL_MARGIN_PX },
      ];
      const anchor = lastLayout?.trayBounds;
      if (anchor && anchor.width > 0 && anchor.height > 0) {
        near.push({ bounds: anchor, margin: HOVER_ANCHOR_MARGIN_PX });
      }
      const state = nextHoverLeaveState({
        cursor,
        near,
        dwellMs: HOVER_DWELL_MS,
        outsideSince: hoverOutsideSince,
        now: Date.now(),
      });
      hoverOutsideSince = state.outsideSince;
      if (state.dismiss) {
        close();
      }
    }, HOVER_POLL_MS);
  }

  function close(): void {
    cancelBlurTimer();
    const win = popupWin;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    win.hide();
    win.webContents.send(USAGE_POPUP_PRESENT_CHANNEL, { visible: false });
  }

  function forgetWindow(win: BrowserWindow): void {
    if (popupWin === win) {
      popupWin = null;
      pageReady = false;
      pendingShow = false;
    }
    cancelBlurTimer();
  }

  function layout(height: number): void {
    const win = popupWin;
    if (!win || win.isDestroyed() || !lastLayout) return;
    const rect = computeUsagePopupRect({
      platform: process.platform,
      trayBounds: lastLayout.trayBounds,
      workArea: lastLayout.workArea,
      displayBounds: lastLayout.displayBounds,
      size: { width: USAGE_POPUP_WIDTH, height },
    });
    const nextBounds: Rectangle = {
      ...rect,
      width: USAGE_POPUP_WIDTH,
      height: rect.height,
    };
    if (win.isVisible() && sameRect(win.getBounds(), nextBounds)) return;
    win.setBounds(nextBounds);
  }

  function resolveDisplay(trayBounds: Rectangle) {
    if (trayBounds.width > 0 && trayBounds.height > 0) {
      return screen.getDisplayMatching(trayBounds);
    }
    const main = deps.getMainWindow();
    return main && !main.isDestroyed()
      ? screen.getDisplayMatching(main.getBounds())
      : screen.getPrimaryDisplay();
  }

  function prewarmRect(): Rectangle {
    const workArea = screen.getPrimaryDisplay().workArea;
    return {
      x: workArea.x,
      y: workArea.y,
      width: USAGE_POPUP_WIDTH,
      height: lastHeight,
    };
  }

  function createWindow(rect: Rectangle, theme: string): void {
    const macPanel = process.platform === "darwin";
    const win = new BrowserWindow({
      ...rect,
      width: USAGE_POPUP_WIDTH,
      height: rect.height,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: !macPanel,
      backgroundColor: macPanel ? macPanelBackground(theme) : "#00000000",
      hasShadow: macPanel,
      roundedCorners: macPanel,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: FOCUSABLE_POPUP,
      alwaysOnTop: true,
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    popupWin = win;
    pageReady = false;
    if (macPanel && theme === "light") win.setOpacity(MAC_LIGHT_PANEL_OPACITY);
    win.setAlwaysOnTop(true, "floating");

    win.on("show", () => {
      pendingShow = false;
      startHoverWatch(win);
    });
    win.on("closed", () => forgetWindow(win));
    win.on("hide", () => {
      cancelBlurTimer();
      stopHoverWatch();
    });
    if (FOCUSABLE_POPUP) {
      win.on("blur", () => {
        cancelBlurTimer();
        blurTimer = setTimeout(() => {
          if (popupWin === win) close();
        }, BLUR_CLOSE_DEBOUNCE_MS);
      });
      win.on("focus", cancelBlurTimer);
    }
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error("[usage-popup] renderer gone — recreating on next open", {
        reason: details?.reason,
      });
      forgetWindow(win);
      if (!win.isDestroyed()) win.destroy();
    });

    loadPopupPage(win, { theme });
  }

  function ensureWindow(): Promise<BrowserWindow | null> {
    const existing = popupWin;
    if (existing && !existing.isDestroyed()) return Promise.resolve(existing);
    if (quitting) return Promise.resolve(null);
    if (!creating) {
      creating = (async () => {
        const { theme } = await resolvePopupAppearance();
        if (quitting) return;
        const raced = popupWin;
        if (raced && !raced.isDestroyed()) return;
        createWindow(prewarmRect(), theme);
      })();
      creating.catch(() => {}).finally(() => {
        creating = null;
      });
    }
    return creating.then(() => {
      const win = popupWin;
      return win && !win.isDestroyed() ? win : null;
    });
  }

  function revealWindow(win: BrowserWindow): void {
    if (win.isVisible()) return;
    if (FOCUSABLE_POPUP) {
      win.show();
    } else {
      win.showInactive();
    }
  }

  async function present(trayBounds: Rectangle): Promise<void> {
    const display = resolveDisplay(trayBounds);
    lastLayout = {
      trayBounds,
      workArea: display.workArea,
      displayBounds: display.bounds,
    };
    const rect = computeUsagePopupRect({
      platform: process.platform,
      trayBounds,
      workArea: display.workArea,
      displayBounds: display.bounds,
      size: { width: USAGE_POPUP_WIDTH, height: lastHeight },
    });

    const win = await ensureWindow();
    if (!win || win !== popupWin) return;
    const nextBounds: Rectangle = {
      ...rect,
      width: USAGE_POPUP_WIDTH,
      height: rect.height,
    };
    if (!sameRect(win.getBounds(), nextBounds)) {
      win.setBounds(nextBounds);
    }
    if (pageReady) {
      revealWindow(win);
    } else {
      pendingShow = true;
    }

    void resolvePopupAppearance().then(({ theme, accentColor }) => {
      const w = popupWin;
      if (!w || w !== win || w.isDestroyed() || !w.isVisible()) return;
      if (process.platform === "darwin") {
        w.setBackgroundColor(macPanelBackground(theme));
        w.setOpacity(
          theme === "light" ? MAC_LIGHT_PANEL_OPACITY : 1,
        );
      }
      w.webContents.send(USAGE_POPUP_PRESENT_CHANNEL, {
        theme,
        accentColor,
        visible: true,
      });
    });
  }

  ipcMain.on(USAGE_POPUP_ACTION_CHANNEL, (_event, action: UsagePopupAction) => {
    if (!action || typeof action !== "object") return;
    switch (action.type) {
      case "close":
        close();
        break;
      case "resize": {
        const height = clampUsagePopupHeight(action.height);
        lastHeight = height;
        pageReady = true;
        layout(height);
        const win = popupWin;
        if (win && !win.isDestroyed() && pendingShow && !win.isVisible()) {
          revealWindow(win);
        }
        break;
      }
      case "settings":
        close();
        deps.onSettings();
        break;
      case "new-task":
        close();
        deps.onNewTask();
        break;
      case "quit":
        deps.onQuit();
        break;
    }
  });

  app.once("before-quit", () => {
    quitting = true;
    cancelBlurTimer();
    stopHoverWatch();
    const win = popupWin;
    popupWin = null;
    if (win && !win.isDestroyed()) win.destroy();
  });

  return {
    toggle(trayBounds: Rectangle): void {
      const win = popupWin;
      if (win && !win.isDestroyed() && win.isVisible()) {
        close();
        return;
      }
      void present(trayBounds);
    },
    close,
    isOpen: () => {
      const win = popupWin;
      return !!win && !win.isDestroyed() && win.isVisible();
    },
    prewarm: () => {
      void ensureWindow();
    },
  };
}
