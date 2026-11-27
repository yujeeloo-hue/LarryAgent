import type { OverlayChannel, OverlayChannelHandlers } from "../../tools/computerUse/cursorOverlay.js";
import type { Point, Rect } from "../../tools/computerUse/types.js";
import { cursorWindowOrigin, stepCursor } from "./cursorMotion.js";
import {
  systemClock,
  type CursorWindowView,
  type OverlayClock,
  type OverlayScreen,
  type OverlayViews,
  type SpotWindowView,
  type TipsPageMessage,
  type TipsWindowView,
} from "./overlayTypes.js";
import { spotFrame, tipClamp, tipCorner, tipOrigin } from "./tipLayout.js";

export const CURSOR_TICK_MS = 16;
export const CURSOR_FADE_OUT_MS = 180;
export const CURSOR_IDLE_HIDE_MS = 15 * 60_000;

const DARK_ACCENT = "#00e5ff";
const LIGHT_ACCENT = "#006bd6";
const DANGER_DARK = "#e5534b";
const DANGER_LIGHT = "#c93636";

function num(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function pointArg(args: Record<string, unknown>): Point | null {
  const x = num(args, "x");
  const y = num(args, "y");
  return x === null || y === null ? null : { x, y };
}

function rectArg(value: unknown): Rect | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const x = num(record, "x");
  const y = num(record, "y");
  const width = num(record, "width");
  const height = num(record, "height");
  if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

function hexColor(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
}

class TipsController {
  private view: TipsWindowView | null = null;
  private spot: SpotWindowView | null = null;
  private tipId: string | null = null;
  private anchor: Rect | null = null;
  private corner = false;
  private danger = false;
  private spotlight = true;
  private mode = "";
  private cardOrigin: Point | null = null;
  private shown = false;
  private dark = true;
  private accent = DARK_ACCENT;
  private themeArgs: Record<string, unknown> | null = null;

  constructor(
    private readonly views: OverlayViews,
    private readonly screen: OverlayScreen,
    private readonly emit: OverlayChannelHandlers["onEvent"],
  ) {}

  handle(cmd: string, args: Record<string, unknown>): void {
    switch (cmd) {
      case "tip.show": {
        if (typeof args.id !== "string") return;
        const view = this.ensureView();
        this.tipId = args.id;
        const anchor = rectArg(args.anchor);
        this.anchor = anchor ? this.screen.toDipRect(anchor) : null;
        this.corner = args.place === "corner";
        this.danger = args.danger === true;
        this.spotlight = args.spotlight !== false;
        this.mode = "";
        this.cardOrigin = null;
        view.call("show", args);
        this.updateSpot(false);
        return;
      }
      case "tip.settle":
        if (args.id !== this.tipId || !this.view) return;
        this.view.call("settle", args);
        this.hideSpot();
        return;
      case "tip.hide":
        if (this.tipId === null || !this.view) return;
        if (typeof args.id === "string" && args.id !== this.tipId) return;
        this.view.call("hide", args);
        this.hideSpot();
        return;
      default:
        return;
    }
  }

  theme(args: Record<string, unknown>): void {
    this.themeArgs = args;
    this.dark = args.dark !== false;
    this.accent = hexColor(args.accent) ?? (this.dark ? DARK_ACCENT : LIGHT_ACCENT);
    this.view?.call("theme", args);
    if (this.tipId !== null) this.updateSpot(this.mode === "pill");
  }

  close(): void {
    this.view?.destroy();
    this.spot?.destroy();
    this.view = null;
    this.spot = null;
    this.tipId = null;
    this.shown = false;
  }

  private ensureView(): TipsWindowView {
    if (this.view) return this.view;
    const view = this.views.tips({
      onMessage: (message) => this.receive(message),
      onCrash: () => this.crashed(),
    });
    this.view = view;
    if (this.themeArgs) view.call("theme", this.themeArgs);
    return view;
  }

  private receive(message: TipsPageMessage): void {
    switch (message.type) {
      case "size":
        if (this.tipId === null) return;
        this.layout(message.w, message.h, message.pad, message.mode);
        return;
      case "answer":
        if (message.id !== this.tipId) return;
        this.emit({
          event: "tip.answer",
          id: message.id,
          action: message.action,
          ...(message.choice !== null ? { choice: message.choice } : {}),
        });
        return;
      case "hidden":
        if (message.id !== null && message.id !== this.tipId) return;
        this.view?.hide();
        this.hideSpot();
        this.shown = false;
        this.tipId = null;
        return;
      default:
        return;
    }
  }

  private crashed(): void {
    const id = this.tipId;
    this.tipId = null;
    this.shown = false;
    this.view?.hide();
    this.hideSpot();
    if (id) this.emit({ event: "tip.lost", id });
    if (this.themeArgs) this.view?.call("theme", this.themeArgs);
  }

  private visibleRect(): Rect {
    const anchor = this.anchor;
    return this.screen.workArea(anchor ? { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 } : null);
  }

  private layout(width: number, height: number, pad: number, next: string): void {
    const view = this.view;
    if (!view) return;
    const card = { width: Math.max(1, width - pad * 2), height: Math.max(1, height - pad * 2) };
    const visible = this.visibleRect();
    let origin: Point;
    if (this.cardOrigin && (next === this.mode || next === "done")) {
      origin = tipClamp(this.cardOrigin, card, visible);
    } else if (next === "pill") {
      origin = tipCorner(card, visible);
    } else {
      origin = this.corner ? tipCorner(card, visible) : tipOrigin(card, this.anchor, visible);
    }
    if (next !== this.mode && next !== "done" && this.tipId !== null && this.anchor) this.updateSpot(next === "pill");
    this.mode = next;
    this.cardOrigin = origin;
    view.setFrame({ x: origin.x - pad, y: origin.y - pad, width, height });
    if (!this.shown) {
      view.show();
      this.shown = true;
    }
  }

  private updateSpot(dim: boolean): void {
    if (!this.spotlight || !this.anchor) {
      this.hideSpot();
      return;
    }
    const spot = (this.spot ??= this.views.spot());
    spot.setFrame(spotFrame(this.anchor));
    const color = this.danger ? (this.dark ? DANGER_DARK : DANGER_LIGHT) : this.accent;
    spot.configure({ color, dim });
    spot.show();
    this.view?.raise();
  }

  private hideSpot(): void {
    this.spot?.hide();
  }
}

export class OverlayController implements OverlayChannel {
  private cursor: CursorWindowView | null = null;
  private active = false;
  private fadingOut = false;
  private paused = false;
  private target: Point | null = null;
  private current: Point | null = null;
  private placed: Point | null = null;
  private lastCommandAt: number;
  private lastTickAt: number;
  private ticker: unknown = null;
  private fadeTimer: unknown = null;
  private themeArgs: Record<string, unknown> | null = null;
  private closed = false;
  private readonly tips: TipsController;

  constructor(
    handlers: OverlayChannelHandlers,
    private readonly views: OverlayViews,
    private readonly screen: OverlayScreen,
    private readonly clock: OverlayClock = systemClock,
  ) {
    this.lastCommandAt = clock.now();
    this.lastTickAt = this.lastCommandAt;
    this.tips = new TipsController(views, screen, handlers.onEvent);
  }

  send(cmd: string, args: Record<string, unknown> = {}): void {
    if (this.closed) return;
    this.lastCommandAt = this.clock.now();
    switch (cmd) {
      case "begin":
        this.begin();
        return;
      case "move": {
        const point = pointArg(args);
        if (point) this.moveTo(point);
        return;
      }
      case "click": {
        const point = pointArg(args);
        if (point) {
          this.moveTo(point);
          this.current = this.target;
          this.placeCursor();
        }
        this.cursor?.call("ripple");
        return;
      }
      case "theme":
        this.themeArgs = args;
        this.cursor?.call("theme", args);
        this.tips.theme(args);
        return;
      case "pause":
        this.paused = true;
        this.cursor?.call("pause", true);
        if (this.current && (!this.active || this.fadingOut)) this.begin();
        return;
      case "resume":
        this.paused = false;
        this.cursor?.call("pause", false);
        return;
      case "tip.show":
      case "tip.settle":
      case "tip.hide":
        this.tips.handle(cmd, args);
        return;
      case "end":
        if (this.paused) {
          this.paused = false;
          this.cursor?.call("pause", false);
        }
        this.end();
        return;
      case "quit":
        this.close();
        return;
      default:
        return;
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTicker();
    this.clearFadeTimer();
    this.cursor?.destroy();
    this.cursor = null;
    this.tips.close();
  }

  private ensureCursor(): CursorWindowView {
    if (this.cursor) return this.cursor;
    const cursor = this.views.cursor();
    this.cursor = cursor;
    if (this.themeArgs) cursor.call("theme", this.themeArgs);
    if (this.paused) cursor.call("pause", true);
    return cursor;
  }

  private begin(): void {
    const cursor = this.ensureCursor();
    this.clearFadeTimer();
    if (this.active) {
      if (this.fadingOut) {
        this.fadingOut = false;
        cursor.call("show");
      }
      return;
    }
    this.active = true;
    this.fadingOut = false;
    this.lastTickAt = this.clock.now();
    cursor.call("show");
    if (this.current) {
      this.placeCursor();
      cursor.show();
    }
    this.startTicker();
  }

  private moveTo(point: Point): void {
    const dip = this.screen.toDipPoint(point);
    const first = this.current === null;
    if (first) this.current = dip;
    this.target = dip;
    if (!this.active) {
      this.begin();
    } else if (first) {
      this.placeCursor();
      this.cursor?.show();
    }
  }

  private end(): void {
    if (!this.active || this.fadingOut) return;
    this.fadingOut = true;
    this.cursor?.call("hide");
    this.fadeTimer = this.clock.setTimeout(() => {
      this.fadeTimer = null;
      this.finish();
    }, CURSOR_FADE_OUT_MS + 40);
  }

  private finish(): void {
    if (!this.fadingOut) return;
    this.active = false;
    this.fadingOut = false;
    this.stopTicker();
    this.cursor?.hide();
  }

  private tick(): void {
    const now = this.clock.now();
    const dt = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;
    if (!this.active) {
      this.stopTicker();
      return;
    }
    if (this.current && this.target) {
      this.current = stepCursor(this.current, this.target, dt);
      this.placeCursor();
    }
    if (!this.paused && now - this.lastCommandAt > CURSOR_IDLE_HIDE_MS) this.end();
  }

  private placeCursor(): void {
    if (!this.current || !this.cursor) return;
    const origin = cursorWindowOrigin(this.current);
    if (this.placed && this.placed.x === origin.x && this.placed.y === origin.y) return;
    this.placed = origin;
    this.cursor.place(origin);
  }

  private startTicker(): void {
    if (this.ticker !== null) return;
    this.ticker = this.clock.setInterval(() => this.tick(), CURSOR_TICK_MS);
  }

  private stopTicker(): void {
    if (this.ticker === null) return;
    this.clock.clearInterval(this.ticker);
    this.ticker = null;
  }

  private clearFadeTimer(): void {
    if (this.fadeTimer === null) return;
    this.clock.clearTimeout(this.fadeTimer);
    this.fadeTimer = null;
  }
}
