export function createRafCoalescer(
  run: () => void | Promise<void>,
  _label = "rafCoalesce",
): {
  schedule: () => void;
  clearPending: () => void;
  cancel: () => void;
} {
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;
  let cancelled = false;

  const RAF_FALLBACK_MS = 100;

  const kick = (): void => {
    if (cancelled) return;
    if (rafId != null || timerId != null) return;
    let settled = false;
    const settle = (): void => {
      if (settled || cancelled) return;
      settled = true;
      if (rafId != null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      if (timerId != null) {
        clearTimeout(timerId);
        timerId = null;
      }
      void execute();
    };
    rafId = requestAnimationFrame(() => settle());
    timerId = setTimeout(() => settle(), RAF_FALLBACK_MS);
  };

  const clearPendingFrame = (): void => {
    pending = false;
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (timerId != null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const execute = async (): Promise<void> => {
    if (cancelled) return;
    running = true;
    try {
      do {
        pending = false;
        await run();
      } while (pending && !cancelled);
    } finally {
      running = false;
    }
  };

  return {
    schedule(): void {
      if (cancelled) return;
      if (running) {
        pending = true;
        return;
      }
      kick();
    },
    clearPending(): void {
      clearPendingFrame();
    },
    cancel(): void {
      cancelled = true;
      clearPendingFrame();
    },
  };
}
