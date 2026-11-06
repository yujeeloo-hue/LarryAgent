/**
 * Process-wide full-permissions flag for the current app run.
 * Initialized from settings; toggles are not written back.
 */

let enabled = false;
const listeners = new Set<(enabled: boolean) => void>();

export function isFullPermissionsEnabled(): boolean {
  return enabled;
}

export function setFullPermissionsEnabled(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  for (const listener of listeners) {
    listener(enabled);
  }
}

/** Apply startup default from settings (or false if missing). */
export function initFullPermissionsEnabled(defaultEnabled: boolean): void {
  enabled = defaultEnabled;
}

export function subscribeFullPermissions(
  listener: (enabled: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
