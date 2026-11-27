
export const AGENT_OPEN_MAX_TABS = 5;

export type EvictableTab = {
  path: string;
  dirty: boolean;
};

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
