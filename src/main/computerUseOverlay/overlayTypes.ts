import type { Point, Rect } from "../../tools/computerUse/types.js";

export type CursorPageCall = "theme" | "show" | "hide" | "ripple" | "pause";
export type TipsPageCall = "show" | "settle" | "hide" | "theme";

export interface CursorWindowView {
  place(origin: Point): void;
  show(): void;
  hide(): void;
  call(fn: CursorPageCall, arg?: unknown): void;
  destroy(): void;
}

export type TipsPageMessage =
  | { type: "size"; w: number; h: number; pad: number; mode: string; id: string | null }
  | { type: "answer"; id: string; action: "primary" | "secondary"; choice: number | null }
  | { type: "hidden"; id: string | null }
  | { type: "loaded" };

export interface TipsWindowView {
  call(fn: TipsPageCall, arg: Record<string, unknown>): void;
  setFrame(frame: Rect): void;
  show(): void;
  hide(): void;
  raise(): void;
  destroy(): void;
}

export type SpotStyle = { color: string; dim: boolean };

export interface SpotWindowView {
  setFrame(frame: Rect): void;
  configure(style: SpotStyle): void;
  show(): void;
  hide(): void;
  destroy(): void;
}

export type TipsViewHandlers = {
  onMessage: (message: TipsPageMessage) => void;
  onCrash: () => void;
};

export type OverlayViews = {
  cursor(): CursorWindowView;
  tips(handlers: TipsViewHandlers): TipsWindowView;
  spot(): SpotWindowView;
};

export interface OverlayScreen {
  toDipPoint(point: Point): Point;
  toDipRect(rect: Rect): Rect;
  workArea(at: Point | null): Rect;
}

export type OverlayClock = {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export const systemClock: OverlayClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export function parseTipsPageMessage(raw: unknown): TipsPageMessage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
  switch (body.type) {
    case "size": {
      const w = num(body.w);
      const h = num(body.h);
      const pad = num(body.pad);
      if (w === null || h === null || pad === null) return null;
      return {
        type: "size",
        w,
        h,
        pad,
        mode: typeof body.mode === "string" ? body.mode : "card",
        id: typeof body.id === "string" ? body.id : null,
      };
    }
    case "answer": {
      if (typeof body.id !== "string") return null;
      const choice = num(body.choice);
      return {
        type: "answer",
        id: body.id,
        action: body.action === "secondary" ? "secondary" : "primary",
        choice: choice !== null && Number.isInteger(choice) ? choice : null,
      };
    }
    case "hidden":
      return { type: "hidden", id: typeof body.id === "string" ? body.id : null };
    case "loaded":
      return { type: "loaded" };
    default:
      return null;
  }
}
