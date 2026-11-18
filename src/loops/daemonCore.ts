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

export type LoopExecutor = (loop: LoopRecord) => Promise<LoopExecutionResult>;

function parseCadenceOrThrow(json: string): Cadence {
  const parsed = JSON.parse(json) as unknown;
  if (!isValidCadence(parsed)) {
    throw new Error(`stored cadence is invalid: ${json}`);
  }
  return parsed;
}

export function advanceNextRun(cadenceJson: string, now: Date): number {
  return nextRunAt(parseCadenceOrThrow(cadenceJson), now).getTime();
}

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
