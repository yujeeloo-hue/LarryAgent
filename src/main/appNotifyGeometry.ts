/**
 * Pure popup geometry for the self-owned notification system — extracted
 * from appNotify.ts so node:test can exercise it without electron.
 */

export type NotifySide = "top-right" | "bottom-right";

export type NotifyRectLike = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/** Default chrome metrics (px) shared by popups and tests. */
export const POPUP_WIDTH = 344;
export const POPUP_HEIGHT = 86;
export const POPUP_MARGIN = 12;
export const POPUP_GAP = 8;

/** macOS pops below the menu bar; Windows rises above the taskbar. */
export function notifySideForPlatform(
  platform: NodeJS.Platform,
): NotifySide {
  return platform === "darwin" ? "top-right" : "bottom-right";
}

/**
 * Pure positioning: workArea corner + margin, stacking away from the bar
 * edge (index 0 hugs the menu bar / taskbar; each older popup one gap
 * further). Rounded to whole pixels so popups never blur.
 */
export function computeNotifyRect(
  workArea: NotifyRectLike,
  side: NotifySide,
  popupSize: { width: number; height: number },
  stackIndex: number,
  opts?: { margin?: number; gap?: number },
): NotifyRectLike {
  const margin = opts?.margin ?? POPUP_MARGIN;
  const gap = opts?.gap ?? POPUP_GAP;
  const x = workArea.x + workArea.width - popupSize.width - margin;
  const offset = stackIndex * (popupSize.height + gap);
  const y =
    side === "top-right"
      ? workArea.y + margin + offset
      : workArea.y + workArea.height - popupSize.height - margin - offset;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: popupSize.width,
    height: popupSize.height,
  };
}
