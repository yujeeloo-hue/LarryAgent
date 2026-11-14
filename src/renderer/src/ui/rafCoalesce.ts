/**
 * Coalesce work onto the next animation frame (latest-wins).
 * If {@link schedule} is called while a run is in flight, one more run
 * executes after the current one finishes.
 */
export function createRafCoalescer(
  run: () => void | Promise<void>,
  _label = "rafCoalesce",
): {
  schedule: () => void;
  /** Drop a queued frame only — future {@link schedule} calls still work. */
  clearPending: () => void;
  /** Permanently disable (e.g. on destroy). */
  cancel: () => void;
} {
  let rafId: number | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;
  let cancelled = false;

  /** Hidden documents never fire rAF — fall back to a short timer. */
  const RAF_FALLBACK_MS = 100;

  const kick = (): void => {
    if (cancelled) return;
    if (rafId != null || timerId != null) return;
    // Hidden documents (minimised/fully occluded windows — common on Windows)
    // never fire rAF, which would freeze coalesced work and let authoritative
    // rebuilds interleave out of order with live stream appends. Race rAF
    // against a short timer: visible pages still run paint-aligned, hidden
    // pages keep flowing on the timer path.
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
