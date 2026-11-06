import type { Rectangle } from "electron";

/**
 * Hover-leave dismissal for the focusless Windows usage popup.
 *
 * The popup never takes focus (focusable:false), so blur can never close
 * it — and can never *wrongly* close it either: the Windows taskbar steals
 * focus from focus-taking tray popups while the tray button is physically
 * held, which made every blur-based dismissal a guessing game about user
 * intent. Dismissal is instead cursor-based and deterministic: the panel
 * auto-closes once the pointer has been away from the panel (plus a
 * margin) AND away from the tray icon that anchored it for a sustained
 * dwell.
 *
 * The anchor rect is load-bearing: the panel is anchored ~8px above the
 * taskbar while the icon center sits roughly a taskbar-height below the
 * panel's bottom edge — a parked-on-icon cursor (a held right-click, or
 * simply resting after the click) is FARTHER from the panel than any
 * reasonable panel-only margin; without the anchor in the near-set that
 * cursor read as "left" and the panel vanished mid-hold.
 *
 * Pure stateless math so node:test can cover it without electron.
 */

/** Poll cadence while the panel is visible (ms). */
export const HOVER_POLL_MS = 250;
/** Distance beyond the panel rect that still counts as "near" (px). */
export const HOVER_PANEL_MARGIN_PX = 24;
/** Distance beyond the anchor (tray icon) rect that still counts as "near" (px). */
export const HOVER_ANCHOR_MARGIN_PX = 16;
/** Sustained absence from every near-rect before auto-closing (ms). */
export const HOVER_DWELL_MS = 1_200;

export type HoverPoint = { x: number; y: number };

/** One region whose vicinity keeps the panel open. */
export type HoverNearRect = { bounds: Rectangle; margin: number };

/** True when the point lies within the rect inflated by `margin` px. */
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

/**
 * Advance the hover-leave state machine by one poll tick.
 *
 * @returns the next `outsideSince` (null while the cursor is near any
 * rect, or on any cursor-read failure — an unreadable position must never
 * dismiss) and whether the sustained-absence threshold has been reached.
 */
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
