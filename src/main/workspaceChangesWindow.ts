import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,

} from "electron";
import { join } from "node:path";
import { attachWindowControlsEvents } from "./windowControls.js";

let changesWindow: BrowserWindow | null = null;
let lastWorkspacePath = "";

function isAlive(win: BrowserWindow | null): win is BrowserWindow {
  return win != null && !win.isDestroyed();
}

function loadChangesPage(win: BrowserWindow, workspacePath: string): void {
  const query = { workspacePath };
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, "");
    const params = new URLSearchParams(query);
    void win.loadURL(`${base}/changes.html?${params.toString()}`);
    return;
  }
  void win.loadFile(join(__dirname, "../renderer/changes.html"), { query });
}

function notifyWorkspacePath(win: BrowserWindow, workspacePath: string): void {
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => {
      if (!win.isDestroyed()) {
        win.webContents.send("workspace-changes:setWorkspacePath", {
          workspacePath,
        });
      }
    });
    return;
  }
  win.webContents.send("workspace-changes:setWorkspacePath", {
    workspacePath,
  });
}

/**
 * Open or focus the singleton Changes BrowserWindow for a workspace.
 * Child of the opener when available (not modal — can move freely).
 */
import { resolveWindowBackground } from "./windowTheme.js";

export async function openWorkspaceChangesWindow(opts: {
  workspacePath: string;
  owner?: BrowserWindow | null;
  iconPath?: string | undefined;
}): Promise<void> {
  const workspacePath = opts.workspacePath.trim();
  if (!workspacePath) return;
  lastWorkspacePath = workspacePath;

  if (isAlive(changesWindow)) {
    notifyWorkspacePath(changesWindow, workspacePath);
    if (changesWindow.isMinimized()) changesWindow.restore();
    changesWindow.show();
    changesWindow.focus();
    return;
  }

  const isMac = process.platform === "darwin";
  const owner =
    opts.owner && !opts.owner.isDestroyed() ? opts.owner : undefined;

  const windowOpts: BrowserWindowConstructorOptions = {
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 420,
    title: "Changes",
    show: false,
    backgroundColor: await resolveWindowBackground(),
    // macOS keeps hiddenInset traffic lights; Windows hides the native
    // title bar entirely — it follows the OS theme, not the app theme, and
    // shows no dog-head brand. The renderer draws the themed chrome +
    // caption buttons instead (changesMain.ts / windowsCaptionGroup.ts).
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
  if (opts.iconPath) windowOpts.icon = opts.iconPath;
  if (owner) windowOpts.parent = owner;
  // y centers the traffic lights in the 38px chrome bar (height / 2 - 6),
  // matching the main window.
  if (isMac) windowOpts.trafficLightPosition = { x: 14, y: 13 };

  const win = new BrowserWindow(windowOpts);
  // Push maximize state to the renderer's caption buttons (Windows only).
  attachWindowControlsEvents(win);

  changesWindow = win;
  win.on("closed", () => {
    if (changesWindow === win) changesWindow = null;
  });

  const reveal = (): void => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once("ready-to-show", reveal);
  setTimeout(reveal, 2500);

  loadChangesPage(win, workspacePath);
}

export function closeWorkspaceChangesWindow(): void {
  if (!isAlive(changesWindow)) return;
  changesWindow.close();
  changesWindow = null;
}

