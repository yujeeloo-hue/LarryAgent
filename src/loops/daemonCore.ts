import type { DatabaseSync } from "node:sqlite";
import {
  dueLoops,
  hasRunningRun,
  insertLoopRun,
  finishLoopRun,
  setLoopNextRun,
  recordLoopRunCompletion,
  type LoopRecord,
} from "./db.js";
import { isValidCadence, nextRunAt, type Cadence } from "./schedule.js";

export type LoopExecutionResult = {
  status: "succeeded" | "failed" | "timeout";
  sessionId?: string | null;
  error?: string | null;
};

/**
 * Serializable executor contract: runs one loop turn to completion (or
 * throws). Implemented by daemonMain with the real session store; tests
 * inject fakes.
 */
export type LoopExecutor = (loop: LoopRecord) => Promise<LoopExecutionResult>;

function parseCadenceOrThrow(json: string): Cadence {
  const parsed = JSON.parse(json) as unknown;
  if (!isValidCadence(parsed)) {
    throw new Error(`stored cadence is invalid: ${json}`);
  }
  return parsed;
}

/** Next occurrence strictly after `now` (catch-up collapses into one run). */
export function advanceNextRun(cadenceJson: string, now: Date): number {
  return nextRunAt(parseCadenceOrThrow(cadenceJson), now).getTime();
}

/**
 * On daemon start: reclaim runs left 'running' by a previous daemon crash
 * (they can never finish) so the re-entry guard does not skip forever.
 */
export function reclaimStaleRuns(
  db: DatabaseSync,
  reason = "daemon restarted during run",
): number {
  const result = db
    .prepare(
      `UPDATE loop_runs SET status = 'failed', ended_at = ?, error = ?
       WHERE status = 'running'`,
    )
    .run(Date.now(), reason);
  return Number(result.changes ?? 0);
}

/**
 * One scheduler pass: process all due loops serially.
 * - Advance next_run_at first (crash-safe; missed occurrences collapse).
 * - Re-entry guard: previous run still 'running' → record 'skipped'.
 * - Each pass executes at most one run per loop; long runs delay others
 *   (global serial queue by design).
 */
export async function runSchedulerPass(
  db: DatabaseSync,
  execute: LoopExecutor,
  now: () => Date = () => new Date(),
): Promise<{ ran: number; skipped: number; failed: number }> {
  const due = dueLoops(db, now().getTime());
  let ran = 0;
  let skipped = 0;
  let failed = 0;

  for (const loop of due) {
    // Advance immediately: a crash mid-run must not re-fire the same slot.
    setLoopNextRun(db, loop.id, advanceNextRun(loop.cadenceJson, now()));

    if (hasRunningRun(db, loop.id)) {
      const skip = insertLoopRun(db, loop.id, "running");
      finishLoopRun(db, skip.id, {
        status: "skipped",
        error: "previous run still in progress",
      });
      skipped += 1;
      continue;
    }

    const run = insertLoopRun(db, loop.id, "running");
    try {
      const result = await execute(loop);
      finishLoopRun(db, run.id, {
        status: result.status,
        sessionId: result.sessionId ?? null,
        error: result.error ?? null,
      });
      if (result.status === "succeeded") ran += 1;
      else failed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      finishLoopRun(db, run.id, { status: "failed", error: message });
      failed += 1;
    }
    recordLoopRunCompletion(db, loop.id, Date.now());
  }

  return { ran, skipped, failed };
}
