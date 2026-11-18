import type { Rectangle } from "electron";


export const HOVER_POLL_MS = 250;
export const HOVER_PANEL_MARGIN_PX = 24;
export const HOVER_ANCHOR_MARGIN_PX = 16;
export const HOVER_DWELL_MS = 1_200;

export type HoverPoint = { x: number; y: number };

export type HoverNearRect = { bounds: Rectangle; margin: number };

export function isInsideInflated(
  point: HoverPoint,
  rect: Rectangle,
  margin: number,
): boolean {
  return (
    point.x >= rect.x - margin &&
    point.x <= rect.x + rect.width + margin &&
    point.y >= rect.y - margin &&
    point.y <= rect.y + rect.height + margin
  );
}

export function isNearAny(point: HoverPoint, near: readonly HoverNearRect[]): boolean {
  return near.some(({ bounds, margin }) => isInsideInflated(point, bounds, margin));
}

export function nextHoverLeaveState(opts: {
  cursor: HoverPoint | null;
  near: readonly HoverNearRect[];
  dwellMs: number;
  outsideSince: number | null;
  now: number;
}): { outsideSince: number | null; dismiss: boolean } {
  const { cursor, near, dwellMs, now } = opts;
  if (!cursor || isNearAny(cursor, near)) {
    return { outsideSince: null, dismiss: false };
  }
  const since = opts.outsideSince ?? now;
  return { outsideSince: since, dismiss: now - since >= dwellMs };
}
