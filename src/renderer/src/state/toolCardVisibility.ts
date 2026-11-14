/**
 * Process-wide hidden tool card set (renderer side of tools.json
 * `toolDisplayOverrides`).
 *
 * Source of truth lives in main (`displayConfig`). This cache lets render
 * paths do a synchronous `isToolCardHidden(name)` check without per-card
 * IPC. ConversationController refreshes it on session load; the Tools
 * screen keeps it in sync after each `tools:setDisplay` round-trip.
 */

let hidden = new Set<string>();

/** Sync check for render paths (streaming / finished / replay). */
export function isToolCardHidden(name: string): boolean {
  return hidden.has(name);
}

/** Hidden names snapshot (tests / debugging). */
export function listHiddenToolCardNames(): string[] {
  return [...hidden];
}

/** Pull the hidden set from main. Tiny payload — safe on every refresh. */
export async function refreshHiddenToolCards(bridge: {
  getHiddenToolCards: () => Promise<string[]>;
}): Promise<void> {
  const names = await bridge.getHiddenToolCards();
  hidden = new Set(names);
}

/**
 * Same-process sync after a successful `tools:setDisplay` round-trip, so
 * open conversation screens reflect the toggle without re-mount.
 */
export function applyToolDisplayLocally(
  name: string,
  visible: boolean,
): void {
  const key = name.trim();
  if (!key) return;
  const next = new Set(hidden);
  if (visible) next.delete(key);
  else next.add(key);
  hidden = next;
}

export function setHiddenToolCardsForTests(names: string[]): void {
  hidden = new Set(names);
}
