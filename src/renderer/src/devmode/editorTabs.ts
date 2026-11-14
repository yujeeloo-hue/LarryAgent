/**
 * Agent-driven tab opens (write_file / patch finished) keep the strip
 * bounded: a new tab past the cap evicts the oldest opened clean tab.
 * Pure helpers — no DOM/Monaco imports (unit-testable in node).
 */

/** Max tabs for agent auto-opens (write/patch/read); user opens uncapped. */
export const AGENT_OPEN_MAX_TABS = 5;

/** Minimal tab shape the eviction scan needs. */
export type EvictableTab = {
  path: string;
  /** Unsaved user edits — never evicted (would silently discard them). */
  dirty: boolean;
};

/**
 * Pick the tab an agent open should evict: the OLDEST opened (array order =
 * open order) that is clean and not the active tab. Null when every
 * candidate is dirty or active — the caller then opens without evicting
 * rather than forcing a discard.
 */
export function pickAgentEvictionVictim(
  tabs: readonly EvictableTab[],
  activePath: string | null,
): string | null {
  for (const tab of tabs) {
    if (tab.dirty) continue;
    if (tab.path === activePath) continue;
    return tab.path;
  }
  return null;
}
