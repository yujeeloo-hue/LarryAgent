import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  insertLoop,
  insertLoopRun,
  listLoopRuns,
  getLoop,
  openLoopsDb,
  hasRunningRun,
} from "./db.js";
import {
  advanceNextRun,
  reclaimStaleRuns,
  runSchedulerPass,
  type LoopExecutionResult,
} from "./daemonCore.js";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "jellybot-loops-core-"));
}

function makeDueLoop(overrides: Partial<Parameters<typeof insertLoop>[1]> = {}) {
  return insertLoop(opened, {
    name: "T",
    prompt: "p",
    workspaceId: "ws",
    runMode: "agent" as const,
    providerId: "",
    reasoningEffort: "low",
    fullPermissions: false,
    cadenceJson: JSON.stringify({ kind: "minute", n: 5 }),
    enabled: true,
    nextRunAt: Date.now() - 1000,
    ...overrides,
  });
}

let opened: ReturnType<typeof openLoopsDb>;

describe("loops daemonCore", () => {
  it("advanceNextRun returns a strictly-future timestamp", () => {
    const root = freshRoot();
    opened = openLoopsDb(root);
    const now = new Date("2026-08-24T10:00:00");
    const next = advanceNextRun(JSON.stringify({ kind: "minute", n: 5 }), now);
    assert.equal(next, now.getTime() + 5 * 60_000);
    opened.close();
  });

  it("executes a due loop and records success", async () => {
    opened = openLoopsDb(freshRoot());
    const loop = makeDueLoop();
    const seen: string[] = [];
    const result = await runSchedulerPass(
      opened,
      async (l): Promise<LoopExecutionResult> => {
        seen.push(l.id);
        return { status: "succeeded", sessionId: "sess-1" };
      },
    );
    assert.deepEqual(seen, [loop.id]);
    assert.deepEqual(result, { ran: 1, skipped: 0, failed: 0 });
    const after = getLoop(opened, loop.id);
    assert.equal(after?.runCount, 1);
    assert.ok(after?.lastRunAt);
    assert.ok((after?.nextRunAt ?? 0) > Date.now(), "next run advanced to future");
    const runs = listLoopRuns(opened, loop.id, 5);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "succeeded");
    assert.equal(runs[0]?.sessionId, "sess-1");
    opened.close();
  });

  it("advances next_run_at before executing (crash-safe) and collapses catch-up", async () => {
    opened = openLoopsDb(freshRoot());
    // Loop overdue by many periods (missed multiple 5-min slots).
    const loop = makeDueLoop({
      nextRunAt: Date.now() - 60 * 60_000,
    });
    let advancedMidExecution = false;
    await runSchedulerPass(opened, async (): Promise<LoopExecutionResult> => {
      advancedMidExecution =
        (getLoop(opened, loop.id)?.nextRunAt ?? 0) > Date.now();
      return { status: "succeeded" };
    });
    assert.ok(advancedMidExecution, "next_run_at moved before execute ran");
    // Only one run recorded despite many missed slots.
    assert.equal(listLoopRuns(opened, loop.id, 50).length, 1);
    opened.close();
  });

  it("skips when the previous run is still running (re-entry guard)", async () => {
    opened = openLoopsDb(freshRoot());
    const loop = makeDueLoop();
    // Simulate an in-flight run from a previous scheduler pass.
    insertLoopRun(opened, loop.id, "running");
    let executed = false;
    const result = await runSchedulerPass(opened, async (): Promise<LoopExecutionResult> => {
      executed = true;
      return { status: "succeeded" };
    });
    assert.equal(executed, false);
    assert.deepEqual(result, { ran: 0, skipped: 1, failed: 0 });
    const runs = listLoopRuns(opened, loop.id, 5);
    assert.equal(runs.length, 2);
    assert.equal(runs.find((r) => r.status === "skipped") != null, true);
    opened.close();
  });

  it("records failure when the executor throws", async () => {
    opened = openLoopsDb(freshRoot());
    const loop = makeDueLoop();
    const result = await runSchedulerPass(opened, async (): Promise<LoopExecutionResult> => {
      throw new Error("LLM unreachable");
    });
    assert.deepEqual(result, { ran: 0, skipped: 0, failed: 1 });
    const runs = listLoopRuns(opened, loop.id, 5);
    assert.equal(runs[0]?.status, "failed");
    assert.equal(runs[0]?.error, "LLM unreachable");
    assert.equal(getLoop(opened, loop.id)?.runCount, 1);
    opened.close();
  });

  it("reclaims runs left running by a crashed daemon", () => {
    opened = openLoopsDb(freshRoot());
    const loop = makeDueLoop();
    insertLoopRun(opened, loop.id, "running");
    assert.equal(hasRunningRun(opened, loop.id), true);
    const reclaimed = reclaimStaleRuns(opened);
    assert.equal(reclaimed, 1);
    assert.equal(hasRunningRun(opened, loop.id), false);
    const runs = listLoopRuns(opened, loop.id, 5);
    assert.equal(runs[0]?.status, "failed");
    assert.ok(runs[0]?.error);
    opened.close();
  });

  it("processes multiple due loops serially in one pass", async () => {
    opened = openLoopsDb(freshRoot());
    const first = makeDueLoop({ nextRunAt: Date.now() - 5000 });
    const second = makeDueLoop({ nextRunAt: Date.now() - 1000 });
    const order: string[] = [];
    const result = await runSchedulerPass(opened, async (l): Promise<LoopExecutionResult> => {
      order.push(l.id);
      return { status: "succeeded" };
    });
    assert.deepEqual(order, [first.id, second.id], "oldest due first");
    assert.deepEqual(result, { ran: 2, skipped: 0, failed: 0 });
    opened.close();
  });
});
