
let voiceMode = false;

const listeners = new Set<(on: boolean) => void>();

export function getComposerVoiceMode(): boolean {
  return voiceMode;
}

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
