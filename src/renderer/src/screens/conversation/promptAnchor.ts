
export type PromptRowMetrics = {
  top: number;
  bottom: number;
  height: number;
};

export type ViewportMetrics = { top: number; bottom: number };

export type PromptAnchor = {
  visible: boolean;
  anchorIndex: number;
};

const VISIBLE_RATIO = 0.5;

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
