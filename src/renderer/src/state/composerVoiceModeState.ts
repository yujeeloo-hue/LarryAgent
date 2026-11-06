/**
 * Global composer voice-mode flag (⌥⌃ toggle).
 *
 * App-wide: every composer (New Task + conversations) reflects and follows
 * it — toggling on one screen switches the others on arrival. Changes
 * persist to settings.json (`composerVoiceMode`) so the mode survives app
 * restarts; bootstrap restores it once at startup with persist disabled.
 */

let voiceMode = false;

const listeners = new Set<(on: boolean) => void>();

export function getComposerVoiceMode(): boolean {
  return voiceMode;
}

/**
 * Set the global flag, notify subscribers, and persist (unless the caller
 * is restoring from settings at bootstrap). Same-value calls are no-ops and
 * do not broadcast — subscribers use that to ignore their own echoes.
 */
export function setComposerVoiceMode(
  on: boolean,
  options?: { persist?: boolean },
): void {
  const next = on === true;
  if (next === voiceMode) return;
  voiceMode = next;
  for (const listener of listeners) {
    listener(next);
  }
  if (options?.persist === false) return;
  if (typeof window === "undefined" || !window.jellybot) return;
  window.jellybot
    .setComposerVoiceMode(next)
    .catch((err: unknown) => {
      console.error("[composer] persist voice mode failed", err);
    });
}

export function subscribeComposerVoiceMode(
  listener: (on: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
