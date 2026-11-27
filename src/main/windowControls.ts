import { app, BrowserWindow, ipcMain } from "electron";
import { windowControlsEnabled } from "../platformCaps.js";

export const WINDOW_MAXIMIZE_CHANGED_CHANNEL = "window:maximizeChanged";
export const WINDOW_CLOSE_REQUEST_CHANNEL = "window:closeRequest";

/**
 * Return focus to the page (webContents).
 *
 * Windows: after an external process dialog (Unreal/UBT error boxes, installers, system prompts, etc.)
 * closes, the window can be left out of sync: the OS considers it active while webContents still reports
 * unfocused. In that state clicks still dispatch (buttons react, the cursor becomes an I-beam), but Chromium
 * does not give focus to text fields, so Composer/terminal inputs cannot be typed into until a real
 * activation cycle (Alt+Tab away and back, or opening DevTools) restores it.
 *
 * Returns whether focus was actually reasserted.
 */
export function focusWebContents(win: BrowserWindow): boolean {
  if (win.isDestroyed() || win.webContents.isFocused()) return false;
  win.webContents.focus();
  return true;
}

export function bringWindowToFront(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (process.platform === "win32") win.setAlwaysOnTop(true);
  win.show();
  win.focus();
  win.moveTop();
  if (process.platform === "darwin") app.focus({ steal: true });
  if (process.platform === "win32") {
    setTimeout(() => {
      if (win.isDestroyed()) return;
      win.setAlwaysOnTop(false);
      focusWebContents(win);
    }, 0);
  }
}

const SHOW_FALLBACK_MS = 2_500;

export function showWhenReady(win: BrowserWindow): () => void {
  const reveal = (): void => {
    clearTimeout(fallback);
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  const fallback = setTimeout(reveal, SHOW_FALLBACK_MS);
  win.once("ready-to-show", reveal);
  win.once("closed", () => clearTimeout(fallback));
  return reveal;
}

export function registerWindowControlsIpc(): void {
  ipcMain.handle("window:close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
    return { ok: true };
  });

  ipcMain.handle("window:reassertFocus", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, refocused: false };
    if (!win.isFocused()) win.focus();
    return { ok: true, refocused: focusWebContents(win) };
  });
  if (!windowControlsEnabled) return;

  ipcMain.handle("window:minimize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.minimize();
    return { ok: true };
  });

  ipcMain.handle("window:toggleMaximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false, maximized: false };
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
    return { ok: true, maximized: win.isMaximized() };
  });
}

export function attachWindowControlsEvents(win: BrowserWindow): void {
  if (!windowControlsEnabled) return;
  const send = (maximized: boolean): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(WINDOW_MAXIMIZE_CHANGED_CHANNEL, { maximized });
  };
  win.on("maximize", () => send(true));
  win.on("unmaximize", () => send(false));
}
