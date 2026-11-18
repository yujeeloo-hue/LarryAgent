import { BrowserWindow, ipcMain } from "electron";
import { windowControlsEnabled } from "../platformCaps.js";

export const WINDOW_MAXIMIZE_CHANGED_CHANNEL = "window:maximizeChanged";
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

export function attachWindowControlsEvents(win: BrowserWindow): void {
  if (!windowControlsEnabled) return;
  const send = (maximized: boolean): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(WINDOW_MAXIMIZE_CHANGED_CHANNEL, { maximized });
  };
  win.on("maximize", () => send(true));
  win.on("unmaximize", () => send(false));
}
