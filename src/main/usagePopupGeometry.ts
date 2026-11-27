
export type UsagePopupRectLike = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TaskbarEdge = "top" | "bottom" | "left" | "right";

export const USAGE_POPUP_WIDTH = 280;
export const USAGE_POPUP_DEFAULT_HEIGHT = 360;
export const USAGE_POPUP_MAX_HEIGHT = 600;
export const USAGE_POPUP_MIN_HEIGHT = 60;
export const USAGE_POPUP_GAP = 6;
export const USAGE_POPUP_EDGE = 8;

export function clampUsagePopupHeight(height: unknown): number {
  if (typeof height !== "number" || !Number.isFinite(height)) {
    return USAGE_POPUP_DEFAULT_HEIGHT;
  }
  return Math.min(
    Math.max(Math.round(height), USAGE_POPUP_MIN_HEIGHT),
    USAGE_POPUP_MAX_HEIGHT,
  );
}

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
  trayBounds: UsagePopupRectLike;
  workArea: UsagePopupRectLike;
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
