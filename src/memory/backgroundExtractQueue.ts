import { agentLogError } from "../logging/agentLog.js";

/**
 * Quiet window after the last schedule before draining. Avoids racing the
 * turn-end title call and immediate user follow-up sends.
 */
export const BACKGROUND_EXTRACT_QUIET_MS = 5_000;

type ExtractJob = {
  key: string;
  run: () => Promise<void>;
};

const pending = new Map<string, ExtractJob>();
let quietTimer: ReturnType<typeof setTimeout> | null = null;
let draining: Promise<void> | null = null;
let quietMs = BACKGROUND_EXTRACT_QUIET_MS;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function scheduleQuietFlush(): void {
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    quietTimer = null;
    void startDrain();
  }, quietMs);
}

async function startDrain(): Promise<void> {
  if (draining) return;
  draining = (async () => {
    while (pending.size > 0) {
      const jobs = [...pending.values()];
      pending.clear();
      for (const job of jobs) {
        try {
          await job.run();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          agentLogError("memory.extract.queue_error", {
            key: job.key,
            message,
          });
        }
      }
      // New schedules during the drain get another quiet window before the
      // next serial pass (covers rapid follow-up turns).
      if (pending.size > 0) {
        await sleep(quietMs);
      }
    }
  })().finally(() => {
    draining = null;
    if (pending.size > 0) scheduleQuietFlush();
  });
  await draining;
}

/**
 * Coalesce by `key` (latest `run` wins) and run jobs serially after a quiet
 * delay. Never throws to the caller.
 */
export function enqueueBackgroundExtract(
  key: string,
  run: () => Promise<void>,
): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  pending.set(trimmed, { key: trimmed, run });
  scheduleQuietFlush();
}

/** Test-only: shorten or restore the quiet window. */
export function setBackgroundExtractQuietMsForTests(ms: number): void {
  quietMs = Math.max(0, ms);
}

/** Test-only: drop pending work and cancel the quiet timer. */
export function resetBackgroundExtractQueueForTests(): void {
  if (quietTimer) {
    clearTimeout(quietTimer);
    quietTimer = null;
  }
  pending.clear();
  quietMs = BACKGROUND_EXTRACT_QUIET_MS;
}
