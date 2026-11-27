import { release } from "node:os";
import { join } from "node:path";
import { BrowserWindow, ipcMain, type IpcMainEvent } from "electron";
import { COMPUTER_USE_TIPS_CHANNEL } from "../../shared/computerUseOverlayChannel.js";
import type { Point, Rect } from "../../tools/computerUse/types.js";
import { CURSOR_PANEL_SIZE } from "./cursorMotion.js";
import { cursorPageUrl, spotPageUrl, tipsPageUrl } from "./overlayPages.js";
import { markComputerUseOverlayWindow } from "./overlayWindowRegistry.js";
import {
  parseTipsPageMessage,
  type CursorPageCall,
  type CursorWindowView,
  type OverlayViews,
  type SpotStyle,
  type SpotWindowView,
  type TipsPageCall,
  type TipsViewHandlers,
  type TipsWindowView,
} from "./overlayTypes.js";

const EXCLUDE_FROM_CAPTURE_BUILD = 19041;

function excludeFromCapture(): boolean {
  const build = Number(release().split(".")[2] ?? 0);
  return build >= EXCLUDE_FROM_CAPTURE_BUILD;
}

type OverlayWindowOptions = {
  width: number;
  height: number;
  clickThrough: boolean;
  capturable: boolean;
  relativeLevel: number;
  preload?: string;
};

function overlayWindow(options: OverlayWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: options.width,
    height: options.height,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    thickFrame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
      ...(options.preload ? { preload: options.preload } : {}),
    },
  });
  markComputerUseOverlayWindow(win);
  win.setAlwaysOnTop(true, "screen-saver", options.relativeLevel);
  if (options.clickThrough) win.setIgnoreMouseEvents(true);
  if (!options.capturable && excludeFromCapture()) win.setContentProtection(true);
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return win;
}

function wholeRect(frame: Rect): Electron.Rectangle {
  return {
    x: Math.round(frame.x),
    y: Math.round(frame.y),
    width: Math.max(1, Math.round(frame.width)),
    height: Math.max(1, Math.round(frame.height)),
  };
}

class OverlayPage {
  private loaded = false;
  private queued: string[] = [];

  constructor(
    readonly win: BrowserWindow,
    private readonly url: string,
    private readonly global: string,
  ) {
    win.webContents.on("did-finish-load", () => {
      this.loaded = true;
      const scripts = this.queued.splice(0);
      for (const script of scripts) this.run(script);
    });
    win.webContents.on("render-process-gone", () => {
      this.loaded = false;
    });
    void win.loadURL(url).catch(() => undefined);
  }

  call(fn: string, arg?: unknown): void {
    const payload = arg === undefined ? "" : JSON.stringify(arg);
    const script = `window.${this.global} && window.${this.global}.${fn}(${payload});`;
    if (this.loaded) this.run(script);
    else this.queued.push(script);
  }

  reload(): void {
    if (this.win.isDestroyed()) return;
    this.loaded = false;
    void this.win.loadURL(this.url).catch(() => undefined);
  }

  showInactive(level: number): void {
    if (this.win.isDestroyed()) return;
    if (!this.win.isVisible()) this.win.showInactive();
    this.win.setAlwaysOnTop(true, "screen-saver", level);
  }

  hide(): void {
    if (!this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  destroy(): void {
    this.queued = [];
    if (!this.win.isDestroyed()) this.win.destroy();
  }

  private run(script: string): void {
    if (this.win.isDestroyed()) return;
    void this.win.webContents.executeJavaScript(script, false).catch(() => undefined);
  }
}

const capturableTips = process.env.JELLYBOT_TIPS_CAPTURABLE === "1";

class ElectronCursorView implements CursorWindowView {
  private readonly page = new OverlayPage(
    overlayWindow({ width: CURSOR_PANEL_SIZE, height: CURSOR_PANEL_SIZE, clickThrough: true, capturable: false, relativeLevel: 0 }),
    cursorPageUrl(),
    "cursor",
  );

  place(origin: Point): void {
    if (this.page.win.isDestroyed()) return;
    this.page.win.setBounds({ x: Math.round(origin.x), y: Math.round(origin.y), width: CURSOR_PANEL_SIZE, height: CURSOR_PANEL_SIZE });
  }

  show(): void {
    this.page.showInactive(0);
  }

  hide(): void {
    this.page.hide();
  }

  call(fn: CursorPageCall, arg?: unknown): void {
    this.page.call(fn, arg);
  }

  destroy(): void {
    this.page.destroy();
  }
}

class ElectronTipsView implements TipsWindowView {
  private readonly page: OverlayPage;
  private readonly listener: (event: IpcMainEvent, raw: unknown) => void;

  constructor(handlers: TipsViewHandlers) {
    const win = overlayWindow({
      width: 400,
      height: 260,
      clickThrough: false,
      capturable: capturableTips,
      relativeLevel: 2,
      preload: join(__dirname, "../preload/computerUseOverlay.js"),
    });
    this.page = new OverlayPage(win, tipsPageUrl(), "tips");
    this.listener = (event, raw) => {
      if (win.isDestroyed() || event.sender !== win.webContents) return;
      const message = parseTipsPageMessage(raw);
      if (message) handlers.onMessage(message);
    };
    ipcMain.on(COMPUTER_USE_TIPS_CHANNEL, this.listener);
    win.webContents.on("render-process-gone", () => {
      handlers.onCrash();
      this.page.reload();
    });
  }

  call(fn: TipsPageCall, arg: Record<string, unknown>): void {
    this.page.call(fn, arg);
  }

  setFrame(frame: Rect): void {
    if (!this.page.win.isDestroyed()) this.page.win.setBounds(wholeRect(frame));
  }

  show(): void {
    this.page.showInactive(2);
    this.raise();
  }

  hide(): void {
    this.page.hide();
  }

  raise(): void {
    if (!this.page.win.isDestroyed() && this.page.win.isVisible()) this.page.win.moveTop();
  }

  destroy(): void {
    ipcMain.removeListener(COMPUTER_USE_TIPS_CHANNEL, this.listener);
    this.page.destroy();
  }
}

class ElectronSpotView implements SpotWindowView {
  private readonly page = new OverlayPage(
    overlayWindow({ width: 100, height: 100, clickThrough: true, capturable: capturableTips, relativeLevel: 1 }),
    spotPageUrl(),
    "spot",
  );

  setFrame(frame: Rect): void {
    if (!this.page.win.isDestroyed()) this.page.win.setBounds(wholeRect(frame));
  }

  configure(style: SpotStyle): void {
    this.page.call("configure", style);
  }

  show(): void {
    this.page.showInactive(1);
  }

  hide(): void {
    this.page.hide();
  }

  destroy(): void {
    this.page.destroy();
  }
}

export function createOverlayWindowsView(): OverlayViews {
  return {
    cursor: () => new ElectronCursorView(),
    tips: (handlers) => new ElectronTipsView(handlers),
    spot: () => new ElectronSpotView(),
  };
}
