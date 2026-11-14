/**
 * Composer / NewTask graph pickers list only enabled library graphs.
 * Disabled (LLM-authored, awaiting user enable) graphs are managed
 * exclusively in the Graphs screen.
 */
export function enabledGraphEntries<T extends { enabled: boolean }>(
  entries: readonly T[],
): T[] {
  return entries.filter((entry) => entry.enabled);
}
