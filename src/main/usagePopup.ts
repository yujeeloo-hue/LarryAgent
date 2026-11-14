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

/**
 * Tray usage popup (docs/plans/20261013-usage-popup-tray-icon.md): a small
 * frameless panel shown on tray-icon click with CursorUsage-style
 * subscription usage. Modeled on appNotify.ts with the differences an
 * interactive panel needs; height is content-driven via a resize message
 * from the renderer.
 *
 * Focus model is platform-split (2026-10 focus-war rework):
 * - macOS keeps the popover convention: focusable + show() so footer
 *   buttons and Esc work, blur-closed (debounced) — unchanged.
 * - Windows is FOCUSLESS (focusable:false, like the notification banners
 *   — clickable without activation): the taskbar steals focus from any
 *   focus-taking tray popup while the tray button is physically held, so
 *   blur-based dismissal was structurally a guess about user intent
 *   (vanishing panel mid-hold; stuck-open unfocused panel with no blur
 *   ever firing). A panel that never takes focus cannot lose it, cannot
 *   be closed wrongly by the taskbar, and cannot yank focus from the
 *   window the user is working in. Dismissal is deterministic: cursor
 *   hover-leave (usagePopupHover.ts) or a second tray click. Footer
 *   buttons still receive clicks; Esc is unavailable on Windows.
 *
 * Resident lifecycle (Windows tray latency fix): the BrowserWindow is
 * created once — prewarmed hidden shortly after startup — and *hidden*, not
 * destroyed, on every close path. Destroying per click put the whole
 * renderer boot chain (process spawn + 773KB shared CSS parse + first
 * frame) on every tray click, which read as seconds on Windows while macOS
 * stayed ~80ms. Toggle now repositions and shows the warm window; the
 * renderer refreshes theme + cached usage on the present event. Cold
 * create survives as the fallback (crash, prewarm failed) and still
 * reveals on the first measured resize like the original flow.
 */

/** Renderer → main action channel (close / resize / settings / quit). */
export const USAGE_POPUP_ACTION_CHANNEL = "usagePopup:action";
/** Main → renderer: the resident panel was shown / hidden. */
export const USAGE_POPUP_PRESENT_CHANNEL = "usagePopup:present";

export type UsagePopupAction =
  | { type: "close" }
  | { type: "resize"; height: number }
  | { type: "new-task" }
  | { type: "settings" }
  | { type: "quit" };

export type UsagePopupPresentPayload = {
  /** Resolved theme id; sent on reveal so a warm panel follows settings. */
  theme?: string;
  /** Optional accent color override; sent with theme so no second style pass fires. */
  accentColor?: string | null;
  visible: boolean;
};

export type UsagePopupDeps = {
  getMainWindow: () => BrowserWindow | undefined;
  /** Focus the main window and start a new task (menubar:action reuse). */
  onNewTask: () => void;
  /** Focus the main window on its settings screen (menubar:action reuse). */
  onSettings: () => void;
  /** app.quit() — runs through the existing before-quit isQuitting chain. */
  onQuit: () => void;
};

export type UsagePopupController = {
  /** Tray click hook: opens when closed, closes when open. */
  toggle: (trayBounds: Rectangle) => void;
  /** Hide the panel (stays resident). */
  close: () => void;
  isOpen: () => boolean;
  /** Create + load the hidden panel ahead of the first click. */
  prewarm: () => void;
};

/**
 * Host wiring shared by the two tray surfaces (appTray.ts on Windows,
 * menuBarIcon.ts on macOS). index.ts owns both callbacks — the tray
 * modules stay decision-free.
 */
export type TrayHostDeps = {
  /** True when the main window exists and is visible (minimized counts). */
  isMainWindowOpen: () => boolean;
  /** Show the existing main window, recreating it when it was closed. */
  openMainWindow: () => void;
  /**
   * True when the main window exists and currently holds the foreground
   * focus (visible *and* on top of the z-order). An obscured or minimized
   * window is open but not foreground.
   */
  isMainWindowForeground: () => boolean;
  /**
   * Bring the existing main window to the front and focus it (restore if
   * minimized, lift above other windows, then settle the z-order). Only
   * called when the window exists and is visible but not foreground.
   */
  focusMainWindow: () => void;
};

/** Blur close is debounced — macOS fires transient blur on click. */
const BLUR_CLOSE_DEBOUNCE_MS = 100;

/** macOS-only: focus popover convention. Windows is focusless (header). */
const FOCUSABLE_POPUP = process.platform === "darwin";

/**
 * macOS panel fill. Light stays white; its see-through is window opacity
 * (below), not a CSS radius hole and not `vibrancy: popover` (system gray).
 */
function macPanelBackground(theme: string): string {
  if (theme === "light") return "#ffffff";
  return "#1b1b1b";
}

/** Light macOS panel window opacity — 0.85 read as too translucent over the
 * user's desktop; 0.95 keeps a hint of see-through with solid text. */
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
  /** In-flight cold create (prewarm racing a click must stay singleton. */
  let creating: Promise<void> | null = null;
  /**
   * True once the renderer reported its first measured height — the warm
   * reveal can show instantly at the remembered height; a cold window must
   * keep waiting for that first resize (no tall-panel flash, 401abd5).
   */
  let pageReady = false;
  /** A toggle is waiting on the cold path's first resize to reveal. */
  let pendingShow = false;
  /** Quitting: never (re)create the resident window after before-quit. */
  let quitting = false;
  /**
   * Hover-leave dismissal (Windows, focusless panel): poll the cursor
   * while visible; sustained absence beyond the near-rect closes.
   */
  let hoverTimer: ReturnType<typeof setInterval> | null = null;
  let hoverOutsideSince: number | null = null;
  /** Remembered content height so the warm reveal lands at the right size. */
  let lastHeight = USAGE_POPUP_DEFAULT_HEIGHT;
  /** Last layout context, kept so resize can re-anchor the panel. */
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

  /** Stop the hover-leave poller (panel hidden / destroyed / quitting). */
  function stopHoverWatch(): void {
    if (hoverTimer) {
      clearInterval(hoverTimer);
      hoverTimer = null;
    }
    hoverOutsideSince = null;
  }

  /** Hover-leave poller — the focusless panel's only auto-dismiss (Win). */
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
        // Unreadable position (remote session, display mode change):
        // never dismiss on a failed read.
        cursor = null;
      }
      // Near-set: the panel itself plus the tray icon that anchored it —
      // a cursor parked on the icon (menu click, held button, resting) is
      // a taskbar-height below the panel edge and must not read as "left".
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

  /** Hide the resident panel (destroy is reserved for quit / crash). */
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
    // Skip redundant setBounds while visible — on Windows, calling setBounds
    // on a transparent frameless window with identical coordinates forces a
    // DWM surface recomposition and flashes the panel a second time.
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

  /** Neutral hidden rect — present() repositions before any reveal. */
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
    // macOS: opaque theme fill, native corner clip and shadow. A transparent
    // CSS radius leaves corner pixels the desktop composites as gray tips.
    // Windows keeps a square transparent window and draws the rounded card.
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
      // macOS popover convention: focusable for footer buttons + Esc, and
      // blur-closed below. Windows is FOCUSLESS on purpose (header): a
      // focus-taking tray popup loses focus to the taskbar mid-hold, and
      // blur-based dismissal then guesses user intent — wrongly. Clicks
      // still land on the focusless panel (like the notification banners).
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
    // Crash hygiene: drop the resident window so the next toggle cold-creates
    // a fresh one instead of revealing a dead surface.
    win.webContents.on("render-process-gone", (_event, details) => {
      console.error("[usage-popup] renderer gone — recreating on next open", {
        reason: details?.reason,
      });
      forgetWindow(win);
      if (!win.isDestroyed()) win.destroy();
    });

    loadPopupPage(win, { theme });
  }

  /** Singleton cold create; resolves to the live window or null on failure. */
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
      // Cold-create failures degrade to the next click retrying.
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
      // Warm reveal: instant, at the remembered content height.
      revealWindow(win);
    } else {
      // Cold: stay hidden until the renderer reports its measured height.
      pendingShow = true;
    }

    // Post-reveal refresh (never blocks the show): keep the warm panel's
    // theme + macOS panel fill in sync with settings and re-read the
    // cached usage snapshot so the panel opens current.
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
        // The renderer's measurement *is* the panel height — see
        // clampUsagePopupHeight for why nothing may inflate it.
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
