import type { BrowserWindow } from "electron";

const overlayWindows = new WeakSet<BrowserWindow>();

export function markComputerUseOverlayWindow(win: BrowserWindow): void {
  overlayWindows.add(win);
}

export function isComputerUseOverlayWindow(win: BrowserWindow): boolean {
  return overlayWindows.has(win);
}
