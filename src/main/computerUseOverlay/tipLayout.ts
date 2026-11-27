import type { Point, Rect } from "../../tools/computerUse/types.js";

export type Size = { width: number; height: number };

export const TIP_MARGIN = 12;
export const TIP_GAP = 18;
export const SPOT_MARGIN = 26;
export const SPOT_PADDING = 6;

export function tipClamp(point: Point, card: Size, visible: Rect): Point {
  const minX = visible.x + TIP_MARGIN;
  const minY = visible.y + 8;
  const maxX = Math.max(minX, visible.x + visible.width - card.width - TIP_MARGIN);
  const maxY = Math.max(minY, visible.y + visible.height - card.height - TIP_MARGIN);
  return {
    x: Math.min(Math.max(point.x, minX), maxX),
    y: Math.min(Math.max(point.y, minY), maxY),
  };
}

export function tipCorner(card: Size, visible: Rect): Point {
  return tipClamp({ x: visible.x + visible.width - card.width - 14, y: visible.y + 10 }, card, visible);
}

export function tipOrigin(card: Size, anchor: Rect | null, visible: Rect): Point {
  if (!anchor || anchor.width * anchor.height > visible.width * visible.height * 0.35) return tipCorner(card, visible);
  const right = anchor.x + anchor.width;
  const bottom = anchor.y + anchor.height;
  const midX = anchor.x + anchor.width / 2;
  const midY = anchor.y + anchor.height / 2;
  const visibleRight = visible.x + visible.width;
  const visibleBottom = visible.y + visible.height;
  let point: Point;
  if (right + TIP_GAP + card.width <= visibleRight - TIP_MARGIN) {
    point = { x: right + TIP_GAP, y: midY - card.height * 0.38 };
  } else if (anchor.x - TIP_GAP - card.width >= visible.x + TIP_MARGIN) {
    point = { x: anchor.x - TIP_GAP - card.width, y: midY - card.height * 0.38 };
  } else if (bottom + TIP_GAP + card.height <= visibleBottom - TIP_MARGIN) {
    point = { x: midX - card.width / 2, y: bottom + TIP_GAP };
  } else if (anchor.y - TIP_GAP - card.height >= visible.y + TIP_MARGIN) {
    point = { x: midX - card.width / 2, y: anchor.y - TIP_GAP - card.height };
  } else {
    return tipCorner(card, visible);
  }
  return tipClamp(point, card, visible);
}

export function spotFrame(anchor: Rect): Rect {
  const inset = SPOT_PADDING + SPOT_MARGIN;
  return { x: anchor.x - inset, y: anchor.y - inset, width: anchor.width + inset * 2, height: anchor.height + inset * 2 };
}
