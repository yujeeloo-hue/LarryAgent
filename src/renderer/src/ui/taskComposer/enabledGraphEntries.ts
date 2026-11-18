export function enabledGraphEntries<T extends { enabled: boolean; validation?: { valid: boolean }; draftContextId?: string }>(
  entries: readonly T[],
): T[] {
  return entries.filter(entry => entry.enabled && entry.validation?.valid === true && !entry.draftContextId);
}
