/** Cleanup belongs to the node that owns the resource, even when cards move. */
const cleanups = new WeakMap<HTMLElement, Set<() => void>>();
const CLEANUP_ATTRIBUTE = "data-card-cleanup";

export function onCardDispose(node: HTMLElement, cleanup: () => void): () => void {
  let pending = cleanups.get(node);
  if (!pending) {
    pending = new Set();
    cleanups.set(node, pending);
    node.setAttribute(CLEANUP_ATTRIBUTE, "");
  }
  pending.add(cleanup);
  return () => {
    pending.delete(cleanup);
    if (pending.size === 0) {
      cleanups.delete(node);
      node.removeAttribute(CLEANUP_ATTRIBUTE);
    }
  };
}

/**
 * Stop scheduled work before discarding a card, not just its visual surface.
 * Never call `getAnimations()` here: it forces a full-document style recalc
 * per call, and offscreen suspension disposes cards in a loop.
 */
export function disposeCardResources(root: HTMLElement): void {
  const nodes = [root, ...root.querySelectorAll<HTMLElement>(`[${CLEANUP_ATTRIBUTE}]`)];
  for (const node of nodes) {
    const pending = cleanups.get(node);
    if (!pending) continue;
    cleanups.delete(node);
    node.removeAttribute(CLEANUP_ATTRIBUTE);
    for (const cleanup of pending) cleanup();
    pending.clear();
  }
}
