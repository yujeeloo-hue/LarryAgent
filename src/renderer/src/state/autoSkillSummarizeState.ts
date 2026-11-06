/**
 * Process-wide auto skill-summarize flag for the current app run.
 * Composer toggle; not written to settings.
 */

let enabled = false;
const listeners = new Set<(enabled: boolean) => void>();

export function isAutoSkillSummarizeEnabled(): boolean {
  return enabled;
}

export function setAutoSkillSummarizeEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  for (const listener of listeners) {
    listener(enabled);
  }
}

export function subscribeAutoSkillSummarize(
  listener: (enabled: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
