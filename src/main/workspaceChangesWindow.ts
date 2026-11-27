import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,

} from "electron";
import { join } from "node:path";
import { attachWindowControlsEvents, showWhenReady } from "./windowControls.js";

let changesWindow: BrowserWindow | null = null;
let lastWorkspacePath = "";

function isAlive(win: BrowserWindow | null): win is BrowserWindow {
  return win != null && !win.isDestroyed();
}

function loadChangesPage(
  win: BrowserWindow,
  workspacePath: string,
  relativePath: string,
): void {
  const query: Record<string, string> = { workspacePath };
  if (relativePath) query.relativePath = relativePath;
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, "");
    const params = new URLSearchParams(query);
    void win.loadURL(`${base}/changes.html?${params.toString()}`);
    return;
  }
  void win.loadFile(join(__dirname, "../renderer/changes.html"), { query });
}

function sendTarget(
  win: BrowserWindow,
  workspacePath: string,
  relativePath: string,
): void {
  win.webContents.send("workspace-changes:setWorkspacePath", {
    workspacePath,
    ...(relativePath ? { relativePath } : {}),
  });
}

/** Re-point an open window; the selected file rides along when given. */
function notifyWorkspaceTarget(
  win: BrowserWindow,
  workspacePath: string,
  relativePath: string,
): void {
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => {
      if (!win.isDestroyed()) sendTarget(win, workspacePath, relativePath);
    });
    return;
  }
  sendTarget(win, workspacePath, relativePath);
}

import { resolveWindowBackground } from "./windowTheme.js";

export async function openWorkspaceChangesWindow(opts: {
  workspacePath: string;
  relativePath?: string | undefined;
  owner?: BrowserWindow | null;
  iconPath?: string | undefined;
}): Promise<void> {
  const workspacePath = opts.workspacePath.trim();
  if (!workspacePath) return;
  const relativePath = (opts.relativePath ?? "").trim();
  lastWorkspacePath = workspacePath;

  if (isAlive(changesWindow)) {
    notifyWorkspaceTarget(changesWindow, workspacePath, relativePath);
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
  if (isMac) windowOpts.trafficLightPosition = { x: 14, y: 13 };

  const win = new BrowserWindow(windowOpts);
  attachWindowControlsEvents(win);

  changesWindow = win;
  win.on("closed", () => {
    if (changesWindow === win) changesWindow = null;
  });

  showWhenReady(win);

  loadChangesPage(win, workspacePath, relativePath);
}

export function closeWorkspaceChangesWindow(): void {
  if (!isAlive(changesWindow)) return;
  changesWindow.close();
  changesWindow = null;
}

