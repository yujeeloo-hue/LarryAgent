import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
} from "electron";
import { basename, join } from "node:path";
import { resolveWindowBackground } from "./windowTheme.js";
import { attachWindowControlsEvents } from "./windowControls.js";

let readerWindow: BrowserWindow | null = null;

function isAlive(win: BrowserWindow | null): win is BrowserWindow {
  return win != null && !win.isDestroyed();
}

function loadReaderPage(win: BrowserWindow, documentPath: string): void {
  const query = { path: documentPath };
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, "");
    const params = new URLSearchParams(query);
    void win.loadURL(`${base}/reader.html?${params.toString()}`);
    return;
  }
  void win.loadFile(join(__dirname, "../renderer/reader.html"), { query });
}

function notifyDocumentPath(win: BrowserWindow, documentPath: string): void {
  if (win.webContents.isLoading()) {
    win.webContents.once("did-finish-load", () => {
      if (!win.isDestroyed()) {
        win.webContents.send("file-reader:setDocument", {
          path: documentPath,
        });
      }
    });
    return;
  }
  win.webContents.send("file-reader:setDocument", { path: documentPath });
}

/**
 * Open or focus the singleton File Reader BrowserWindow (Markdown rendered /
 * source, syntax-highlighted code, PDF, images). Re-opening with a different
 * path swaps the document in place (same window, no re-launch). Child of the
 * opener when available (not modal — can move freely).
 */
export async function openFileReaderWindow(opts: {
  path: string;
  owner?: BrowserWindow | null;
  iconPath?: string | undefined;
}): Promise<void> {
  const documentPath = opts.path.trim();
  if (!documentPath) return;

  if (isAlive(readerWindow)) {
    notifyDocumentPath(readerWindow, documentPath);
    if (readerWindow.isMinimized()) readerWindow.restore();
    readerWindow.show();
    readerWindow.focus();
    return;
  }

  const isMac = process.platform === "darwin";
  const owner =
    opts.owner && !opts.owner.isDestroyed() ? opts.owner : undefined;

  const windowOpts: BrowserWindowConstructorOptions = {
    width: 880,
    height: 680,
    minWidth: 560,
    minHeight: 400,
    title: basename(documentPath) || "File Reader",
    show: false,
    backgroundColor: await resolveWindowBackground(),
    // macOS keeps hiddenInset traffic lights; Windows hides the native
    // title bar entirely — it follows the OS theme, not the app theme, and
    // shows no dog-head brand. The renderer draws the themed chrome +
    // caption buttons instead (readerMain.ts / windowsCaptionGroup.ts).
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
  // y centers the 12px-tall traffic lights in the 46px reader titlebar
  // (height / 2 - 6, same formula as the main window's 38px → y 13).
  if (isMac) windowOpts.trafficLightPosition = { x: 14, y: 17 };

  const win = new BrowserWindow(windowOpts);
  // Push maximize state to the renderer's caption buttons (Windows only).
  attachWindowControlsEvents(win);

  readerWindow = win;
  win.on("closed", () => {
    if (readerWindow === win) readerWindow = null;
  });

  const reveal = (): void => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once("ready-to-show", reveal);
  setTimeout(reveal, 2500);

  loadReaderPage(win, documentPath);
}
