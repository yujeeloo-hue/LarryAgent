/**
 * Context-pill scroll anchor — which user prompt the pill should echo.
 *
 * The pill folds while its prompt is on screen; once you scroll away it
 * expands showing the prompt of the turn you are READING (the nearest
 * prompt above the viewport), not always the conversation's latest one.
 * Pure rect math — ConversationView measures rows and feeds numbers in,
 * tests feed synthetic geometry.
 */

export type PromptRowMetrics = {
  /** Border-box top/bottom in viewport space (getBoundingClientRect). */
  top: number;
  bottom: number;
  height: number;
};

export type ViewportMetrics = { top: number; bottom: number };

export type PromptAnchor = {
  /** A prompt row is (half) on screen → the pill auto-folds. */
  visible: boolean;
  /** Index into the rows array the pill should display. */
  anchorIndex: number;
};

/** ≥50% of the smaller of row/viewport height on screen = "can see it". */
const VISIBLE_RATIO = 0.5;

/**
 * Pick the pill's prompt anchor from user-row rects:
 *  - any row sufficiently on screen → visible (fold), anchor = the
 *    bottom-most such row;
 *  - none on screen → anchor = the last row fully above the viewport
 *    (the prompt whose answer you are scrolled into); above the first
 *    row entirely → anchor = row 0.
 * Returns null when there are no rows at all.
 */
export function computePromptAnchor(
  rows: PromptRowMetrics[],
  viewport: ViewportMetrics,
): PromptAnchor | null {
  if (rows.length === 0) return null;
  const viewportHeight = viewport.bottom - viewport.top;
  let lastVisible = -1;
  let lastAbove = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const overlap =
      Math.min(row.bottom, viewport.bottom) -
      Math.max(row.top, viewport.top);
    if (
      overlap > 0 &&
      overlap >= Math.min(row.height, viewportHeight) * VISIBLE_RATIO
    ) {
      lastVisible = i;
    } else if (row.bottom <= viewport.top) {
      lastAbove = i;
    }
  }
  const anchorIndex =
    lastVisible >= 0 ? lastVisible : lastAbove >= 0 ? lastAbove : 0;
  return { visible: lastVisible >= 0, anchorIndex };
}
