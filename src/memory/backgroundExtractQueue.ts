import { agentLogError } from "../logging/agentLog.js";

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

export function enqueueBackgroundExtract(
  key: string,
  run: () => Promise<void>,
): void {
  const trimmed = key.trim();
  if (!trimmed) return;
  pending.set(trimmed, { key: trimmed, run });
  scheduleQuietFlush();
}

export function setBackgroundExtractQuietMsForTests(ms: number): void {
  quietMs = Math.max(0, ms);
}

export function resetBackgroundExtractQueueForTests(): void {
  if (quietTimer) {
    clearTimeout(quietTimer);
    quietTimer = null;
  }
  pending.clear();
  quietMs = BACKGROUND_EXTRACT_QUIET_MS;
}
