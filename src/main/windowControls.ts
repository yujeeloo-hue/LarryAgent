import { BrowserWindow, ipcMain } from "electron";
import { windowControlsEnabled } from "../platformCaps.js";

/**
 * Windows self-drawn caption buttons (TitleBarView) — the main-process half.
 * Renderer buttons call these IPC channels; `window:maximizeChanged` pushes
 * maximize state so the Max button can swap its glyph (Max ⇄ Restore).
 * `window:close` is the exception: it also backs Dev Mode's close-tab
 * chord fallback (⌘W / Ctrl+F4 with no tabs left), so it is registered on
 * every platform — the caption buttons themselves stay Windows-only.
 */
export const WINDOW_MAXIMIZE_CHANGED_CHANNEL = "window:maximizeChanged";
/** main → renderer: a parked ⌘W / Ctrl+F4 waiting to be consumed as a tab close. */
export const WINDOW_CLOSE_REQUEST_CHANNEL = "window:closeRequest";

export function registerWindowControlsIpc(): void {
  ipcMain.handle("window:close", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
    return { ok: true };
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

/** Push maximize state to this window's renderer (Windows only, no-op elsewhere). */
export function attachWindowControlsEvents(win: BrowserWindow): void {
  if (!windowControlsEnabled) return;
  const send = (maximized: boolean): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(WINDOW_MAXIMIZE_CHANGED_CHANNEL, { maximized });
  };
  win.on("maximize", () => send(true));
  win.on("unmaximize", () => send(false));
}
