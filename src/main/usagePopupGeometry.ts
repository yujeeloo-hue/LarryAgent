/**
 * Pure tray-popup geometry for the usage panel — extracted from
 * usagePopup.ts so node:test can exercise it without electron.
 *
 * macOS: panel drops below the menu-bar icon, horizontally centered on it.
 * Windows: panel hugs the taskbar edge (inferred from workArea vs display
 * bounds), centered on the tray icon along the bar. Everything clamps into
 * the workArea and rounds to whole pixels so the panel never blurs.
 */

export type UsagePopupRectLike = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TaskbarEdge = "top" | "bottom" | "left" | "right";

/** Panel chrome metrics (px) shared by the window code and tests. */
export const USAGE_POPUP_WIDTH = 280;
export const USAGE_POPUP_DEFAULT_HEIGHT = 360;
export const USAGE_POPUP_MAX_HEIGHT = 600;
/**
 * Floor for a *measured* content height. A real panel is at least ~105px
 * (one short section + footer); far below that is a bogus measurement.
 *
 * Never raise this to the panel's "comfortable" size: the window height is
 * whatever the renderer measured, so a floor above the card inflates the
 * window. macOS paints an opaque theme-filled window with an edge-to-edge
 * card, so every surplus pixel shows up as an empty band in the card's own
 * colour under the footer — seen on a DeepSeek-only panel (no plan bars,
 * ~105px). Windows hides the same surplus because its window is transparent.
 */
export const USAGE_POPUP_MIN_HEIGHT = 60;
/** Gap between the menu bar / taskbar and the panel. */
export const USAGE_POPUP_GAP = 6;
/** Minimum distance from workArea edges when clamping. */
export const USAGE_POPUP_EDGE = 8;

/**
 * Normalise a renderer-reported height into a window height: rounded,
 * capped, and floored only against degenerate measurements.
 */
export function clampUsagePopupHeight(height: unknown): number {
  if (typeof height !== "number" || !Number.isFinite(height)) {
    return USAGE_POPUP_DEFAULT_HEIGHT;
  }
  return Math.min(
    Math.max(Math.round(height), USAGE_POPUP_MIN_HEIGHT),
    USAGE_POPUP_MAX_HEIGHT,
  );
}

/**
 * Infer the taskbar edge from the workArea inset: an origin shift means the
 * bar is top/left; a pure size shrink means bottom/right. Defaults bottom
 * (the common Windows case, also correct when nothing is reserved).
 */
export function inferTaskbarEdge(
  workArea: UsagePopupRectLike,
  displayBounds: UsagePopupRectLike,
): TaskbarEdge {
  if (workArea.y > displayBounds.y) return "top";
  if (workArea.x > displayBounds.x) return "left";
  if (workArea.height < displayBounds.height) return "bottom";
  if (workArea.width < displayBounds.width) return "right";
  return "bottom";
}

function isEmptyRect(rect: UsagePopupRectLike): boolean {
  return !(rect.width > 0 && rect.height > 0);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

export function computeUsagePopupRect(opts: {
  platform: NodeJS.Platform;
  /** Tray icon rect from tray.getBounds(); all-zero when unavailable. */
  trayBounds: UsagePopupRectLike;
  workArea: UsagePopupRectLike;
  /** Full display bounds (for taskbar inference); may equal workArea. */
  displayBounds: UsagePopupRectLike;
  size: { width: number; height: number };
  gap?: number;
  edge?: number;
}): UsagePopupRectLike {
  const { platform, trayBounds, workArea, displayBounds } = opts;
  const gap = opts.gap ?? USAGE_POPUP_GAP;
  const edge = opts.edge ?? USAGE_POPUP_EDGE;
  const width = opts.size.width;
  const height = Math.min(
    opts.size.height,
    USAGE_POPUP_MAX_HEIGHT,
    Math.max(120, workArea.height - edge * 2),
  );

  // tray.getBounds() can return an empty rect (Linux, exotic Windows) —
  // fall back to the notify-style corner default.
  if (isEmptyRect(trayBounds)) {
    const x = workArea.x + workArea.width - width - edge;
    const y =
      platform === "darwin"
        ? workArea.y + edge
        : workArea.y + workArea.height - height - edge;
    return { x: Math.round(x), y: Math.round(y), width, height };
  }

  const centerX = trayBounds.x + trayBounds.width / 2;
  const centerY = trayBounds.y + trayBounds.height / 2;
  let x: number;
  let y: number;
  if (platform === "darwin") {
    x = centerX - width / 2;
    y = trayBounds.y + trayBounds.height + gap;
  } else {
    switch (inferTaskbarEdge(workArea, displayBounds)) {
      case "top":
        x = centerX - width / 2;
        y = trayBounds.y + trayBounds.height + gap;
        break;
      case "bottom":
        x = centerX - width / 2;
        y = trayBounds.y - height - gap;
        break;
      case "left":
        x = trayBounds.x + trayBounds.width + gap;
        y = centerY - height / 2;
        break;
      case "right":
        x = trayBounds.x - width - gap;
        y = centerY - height / 2;
        break;
    }
  }

  x = clamp(x, workArea.x + edge, workArea.x + workArea.width - width - edge);
  y = clamp(y, workArea.y + edge, workArea.y + workArea.height - height - edge);
  return { x: Math.round(x), y: Math.round(y), width, height };
}
