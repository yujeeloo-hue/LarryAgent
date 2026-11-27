import type { Point } from "../../tools/computerUse/types.js";

export const CURSOR_PANEL_SIZE = 132;
export const CURSOR_HOTSPOT = { x: 0.3, y: 0.26 } as const;
export const CURSOR_SMOOTHING_S = 0.055;
export const CURSOR_MAX_STEP_S = 0.1;
const SNAP = 0.15;

export function stepCursor(current: Point, target: Point, dtS: number): Point {
  const dt = Math.min(CURSOR_MAX_STEP_S, Math.max(0, dtS));
  const k = 1 - Math.exp(-dt / CURSOR_SMOOTHING_S);
  let x = current.x + (target.x - current.x) * k;
  let y = current.y + (target.y - current.y) * k;
  if (Math.abs(target.x - x) < SNAP) x = target.x;
  if (Math.abs(target.y - y) < SNAP) y = target.y;
  return { x, y };
}

export function cursorWindowOrigin(point: Point): Point {
  return {
    x: Math.round(point.x - CURSOR_PANEL_SIZE * CURSOR_HOTSPOT.x),
    y: Math.round(point.y - CURSOR_PANEL_SIZE * CURSOR_HOTSPOT.y),
  };
}
