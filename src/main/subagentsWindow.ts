import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,

} from "electron";
import { join } from "node:path";
import { attachWindowControlsEvents } from "./windowControls.js";
import { resolveWindowBackground } from "./windowTheme.js";

let subagentsWindow: BrowserWindow | null = null;
let lastSessionId = "";

function isAlive(win: BrowserWindow | null): win is BrowserWindow {
  return win != null && !win.isDestroyed();
}

function loadSubagentsPage(win: BrowserWindow, sessionId: string): void {
  const query = { sessionId };
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, "");
    const params = new URLSearchParams(query);
    void win.loadURL(`${base}/subagents.html?${params.toString()}`);
    return;
  }
  void win.loadFile(join(__dirname, "../renderer/subagents.html"), { query });
}

function notifySessionId(win: BrowserWindow, sessionId: string): void {
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => {
      if (!win.isDestroyed()) {
        win.webContents.send("subagents-window:setSession", { sessionId });
      }
    });
    return;
  }
  win.webContents.send("subagents-window:setSession", { sessionId });
}

/**
 * Open or focus the singleton Subagents BrowserWindow for a session. Child of
 * the opener when available (not modal — can move freely). Re-opens follow the
 * session (same protocol as the Changes window's workspacePath follow).
 */
export async function openSubagentsWindow(opts: {
  sessionId: string;
  owner?: BrowserWindow | null;
  iconPath?: string | undefined;
}): Promise<void> {
  const sessionId = opts.sessionId.trim();
  if (!sessionId) return;
  lastSessionId = sessionId;

  if (isAlive(subagentsWindow)) {
    notifySessionId(subagentsWindow, sessionId);
    if (subagentsWindow.isMinimized()) subagentsWindow.restore();
    subagentsWindow.show();
    subagentsWindow.focus();
    return;
  }

  const isMac = process.platform === "darwin";

  const windowOpts: BrowserWindowConstructorOptions = {
    width: 880,
    height: 640,
    minWidth: 520,
    minHeight: 360,
    title: "Subagents",
    show: false,
    backgroundColor: await resolveWindowBackground(),
    // macOS keeps hiddenInset traffic lights; Windows hides the native title
    // bar entirely — the renderer draws the themed chrome + caption buttons
    // instead (subagentsMain.ts / windowsCaptionGroup.ts), same as Changes.
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (opts.iconPath) windowOpts.icon = opts.iconPath;
  // Deliberately NOT parented: this is a persistent monitor window, not a
  // transient utility — a parented (child) window on macOS stays layered
  // above the main window and moves with it, which reads as "stuck", not
  // "independent". The Changes/Reader windows keep their parented behavior.
  if (isMac) windowOpts.trafficLightPosition = { x: 14, y: 13 };

  const win = new BrowserWindow(windowOpts);
  // Push maximize state to the renderer's caption buttons (Windows only).
  attachWindowControlsEvents(win);

  subagentsWindow = win;
  win.on("closed", () => {
    if (subagentsWindow === win) subagentsWindow = null;
  });

  const reveal = (): void => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once("ready-to-show", reveal);
  setTimeout(reveal, 2500);

  loadSubagentsPage(win, sessionId);
}

