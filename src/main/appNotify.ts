import { app, BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import { readWorkspaceSettings } from "../settings/index.js";
import { resolveThemeId } from "../settings/types.js";
import {
  computeNotifyRect,
  notifySideForPlatform,
  POPUP_WIDTH,
  POPUP_HEIGHT,
} from "./appNotifyGeometry.js";
import { isAppForeground } from "./desktopNotify.js";

export type { NotifySide, NotifyRectLike } from "./appNotifyGeometry.js";


export const APP_NOTIFY_CHANNEL = "app:notify";
export const APP_NOTIFY_ACTIVATE_CHANNEL = "appnotify:activate";

export interface AppNotificationEntry {
  id: number;
  title: string;
  body: string;
  sessionId?: string;
  createdAt: number;
  read: boolean;
}

export interface AppNotifySnapshot {
  entries: AppNotificationEntry[];
  unreadCount: number;
  latestId?: number;
  latest?: AppNotificationEntry;
  present?: "toast" | "popup";
}

const POPUP_MAX = 3;
const POPUP_TIMEOUT_MS = 10_000;
const LEDGER_CAP = 50;

interface ActivePopup {
  win: BrowserWindow;
  id: number;
  entry: AppNotificationEntry;
  timer: ReturnType<typeof setTimeout>;
}

const ledger: AppNotificationEntry[] = [];
let nextEntryId = 1;
const popups: ActivePopup[] = [];
let getMainWindow: () => BrowserWindow | undefined = () => undefined;
let themeResolver: (() => Promise<string>) | undefined;

async function resolvePopupTheme(): Promise<string> {
  try {
    const settings = await readWorkspaceSettings(app.getPath("userData"));
    return resolveThemeId(settings);
  } catch {
    return "dark";
  }
}

function snapshot(
  latest?: AppNotificationEntry,
  present?: AppNotifySnapshot["present"],
): AppNotifySnapshot {
  return {
    entries: [...ledger],
    unreadCount: ledger.reduce((n, e) => n + (e.read ? 0 : 1), 0),
    ...(latest ? { latestId: latest.id, latest } : {}),
    ...(present !== undefined ? { present } : {}),
  };
}

function broadcast(payload: AppNotifySnapshot): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(APP_NOTIFY_CHANNEL, payload);
  }
}

function markRead(id: number): void {
  const entry = ledger.find((e) => e.id === id);
  if (entry && !entry.read) entry.read = true;
}

function activateEntry(
  id: number,
  known?: AppNotificationEntry,
): void {
  const entry =
    known ??
    ledger.find((e) => e.id === id) ??
    popups.find((p) => p.id === id)?.entry;
  markRead(id);
  broadcast(snapshot());
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send(APP_NOTIFY_ACTIVATE_CHANNEL, {
      sessionId: entry?.sessionId,
    });
  }
}

function closePopup(popup: ActivePopup): void {
  clearTimeout(popup.timer);
  const idx = popups.indexOf(popup);
  if (idx !== -1) popups.splice(idx, 1);
  if (!popup.win.isDestroyed()) popup.win.destroy();
  relayoutPopups();
}

function relayoutPopups(): void {
  const win = getMainWindow();
  const display =
    win && !win.isDestroyed()
      ? screen.getDisplayMatching(win.getBounds())
      : screen.getPrimaryDisplay();
  const side = notifySideForPlatform(process.platform);
  popups.forEach((popup, i) => {
    if (popup.win.isDestroyed()) return;
    const rect = computeNotifyRect(
      display.workArea,
      side,
      { width: POPUP_WIDTH, height: POPUP_HEIGHT },
      i,
    );
    popup.win.setBounds({ ...rect, width: POPUP_WIDTH, height: POPUP_HEIGHT });
  });
}

function loadPopupPage(win: BrowserWindow, query: Record<string, string>): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL.replace(/\/$/, "");
    const params = new URLSearchParams(query);
    void win.loadURL(`${base}/notify-popup.html?${params.toString()}`);
    return;
  }
  void win.loadFile(join(__dirname, "../renderer/notify-popup.html"), {
    query,
  });
}

async function showPopup(entry: AppNotificationEntry): Promise<void> {
  while (popups.length >= POPUP_MAX) {
    closePopup(popups[popups.length - 1]!);
  }
  const theme = await (themeResolver?.() ?? resolvePopupTheme());
  const display = (() => {
    const win = getMainWindow();
    return win && !win.isDestroyed()
      ? screen.getDisplayMatching(win.getBounds())
      : screen.getPrimaryDisplay();
  })();
  const rect = computeNotifyRect(
    display.workArea,
    notifySideForPlatform(process.platform),
    { width: POPUP_WIDTH, height: POPUP_HEIGHT },
    popups.length,
  );

  const win = new BrowserWindow({
    ...rect,
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setAlwaysOnTop(true, "floating");

  const popup: ActivePopup = {
    win,
    id: entry.id,
    entry,
    timer: setTimeout(() => closePopup(popup), POPUP_TIMEOUT_MS),
  };
  popups.unshift(popup);
  win.on("closed", () => {
    const idx = popups.indexOf(popup);
    if (idx !== -1) {
      clearTimeout(popup.timer);
      popups.splice(idx, 1);
    }
    relayoutPopups();
  });
  loadPopupPage(win, {
    id: String(entry.id),
    title: entry.title,
    body: entry.body,
    theme,
    ms: String(POPUP_TIMEOUT_MS),
  });
  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.showInactive();
  });
}

export function appNotify(input: {
  title: string;
  body: string;
  sessionId?: string;
  inbox?: boolean;
}): void {
  try {
    const toInbox = input.inbox === true;
    const entry: AppNotificationEntry = {
      id: nextEntryId++,
      title: input.title,
      body: input.body,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      createdAt: Date.now(),
      read: !toInbox,
    };
    if (toInbox) {
      ledger.unshift(entry);
      if (ledger.length > LEDGER_CAP) ledger.length = LEDGER_CAP;
    }
    const foreground = isAppForeground();
    broadcast(snapshot(entry, foreground ? "toast" : "popup"));
    if (!foreground) void showPopup(entry);
  } catch {
  }
}

export function setupAppNotify(
  mainWin: () => BrowserWindow | undefined,
): void {
  getMainWindow = mainWin;
  themeResolver = resolvePopupTheme;

  ipcMain.handle("appnotify:getLedger", () => snapshot());
  ipcMain.handle(
    "appnotify:markRead",
    (_event, req: { id?: number; all?: boolean }) => {
      if (req?.all) {
        for (const entry of ledger) entry.read = true;
      } else if (typeof req?.id === "number") {
        markRead(req.id);
      }
      const snap = snapshot();
      broadcast(snap);
      return snap;
    },
  );
  ipcMain.handle("appnotify:clear", () => {
    ledger.length = 0;
    const snap = snapshot();
    broadcast(snap);
    return snap;
  });
  ipcMain.handle(
    "appnotify:popupAction",
    (_event, req: { id?: number; action?: "activate" | "dismiss" }) => {
      const id = typeof req?.id === "number" ? req.id : -1;
      const popup = popups.find((p) => p.id === id);
      const entry = popup?.entry;
      if (popup) closePopup(popup);
      if (req?.action === "activate") activateEntry(id, entry);
    },
  );

  app.on("browser-window-focus", (_event, win) => {
    if (win === getMainWindow()) {
      for (const popup of [...popups]) closePopup(popup);
    }
  });
}
