/**
 * Tests for the Windows in-app Loops scheduler (src/main/loops/inAppScheduler.ts).
 *
 * The scheduler is a thin lifecycle shell around runSchedulerPass (already
 * covered in daemonCore.test.ts); these tests verify the shell semantics:
 * start/stop lifecycle, the persisted stopped-by-user marker, heartbeat
 * writes, and that a due loop actually executes through the injected
 * session-store contract.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { insertLoop, openLoopsDb } from "../../loops/db.js";
import type { LoopRecord } from "../../loops/db.js";
import { createInAppScheduler, IN_APP_SCHEDULER_VERSION } from "./inAppScheduler.js";
import type { SessionExecutorStore } from "../../loops/sessionExecutor.js";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "jellybot-loops-inapp-"));
}

type FakeSession = { status: string };

/** Minimal SessionExecutorStore: startTurn queues, sessions map holds state. */
function fakeStore(sessions = new Map<string, FakeSession>()): {
  store: SessionExecutorStore;
  started: string[];
  settle(sessionId: string, status: string): void;
} {
  let seq = 0;
  const started: string[] = [];
  return {
    started,
    store: {
      startTurn: async (req) => {
        started.push(req.userText);
        const sessionId = `sess-${++seq}`;
        sessions.set(sessionId, { status: "running" });
        return { sessionId };
      },
      getSession: (sessionId) => sessions.get(sessionId) ?? null,
      cancelTurn: (sessionId) => sessions.delete(sessionId),
    },
    settle(sessionId, status) {
      const session = sessions.get(sessionId);
      if (session) session.status = status;
    },
  };
}

function makeDueLoop(db: ReturnType<typeof openLoopsDb>): LoopRecord {
  return insertLoop(db, {
    name: "T",
    prompt: "tick",
    workspaceId: "ws-1",
    runMode: "agent" as const,
    providerId: "",
    reasoningEffort: "low",
    fullPermissions: false,
    cadenceJson: JSON.stringify({ kind: "minute", n: 5 }),
    enabled: true,
    nextRunAt: Date.now() - 1000,
  });
}

describe("in-app Loops scheduler", () => {
  it("start() runs due loops through the session store and heartbeats", async () => {
    const root = freshRoot();
    const db = openLoopsDb(root);
    const loop = makeDueLoop(db);
    const fake = fakeStore();

    const scheduler = createInAppScheduler(db, fake.store, {
      scanIntervalMs: 50,
      heartbeatIntervalMs: 50,
      executorOptions: { pollIntervalMs: 20, startGracePolls: 1 },
    });
    scheduler.start();
    assert.equal(scheduler.isRunning(), true);

    // Wait for the boot pass + one settle poll window.
    await new Promise((r) => setTimeout(r, 250));
    // The executor polls the session; settle it so the run finishes.
    fake.settle(`sess-1`, "completed");
    await new Promise((r) => setTimeout(r, 250));

    assert.deepEqual(fake.started, ["tick"]);
    const runs = db
      .prepare("SELECT status, session_id FROM loop_runs WHERE loop_id = ?")
      .all(loop.id) as Array<{ status: string; session_id: string | null }>;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, "succeeded");

    const status = scheduler.status();
    assert.equal(status.running, true);
    assert.ok(status.heartbeatAt, "heartbeat recorded");
    const info = db
      .prepare("SELECT app_version FROM daemon_info WHERE id = 1")
      .get() as { app_version: string } | undefined;
    assert.equal(info?.app_version, IN_APP_SCHEDULER_VERSION);

    scheduler.stop(false);
    assert.equal(scheduler.isRunning(), false);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("stop(true) persists the stopped-by-user marker; start() respects it", async () => {
    const root = freshRoot();
    const db = openLoopsDb(root);
    const fake = fakeStore();

    const scheduler = createInAppScheduler(db, fake.store, {
      scanIntervalMs: 10,
      heartbeatIntervalMs: 10,
    });
    // Stopped before ever started — must still record user intent.
    scheduler.stop(true);
    assert.equal(scheduler.status().stoppedByUser, true);

    scheduler.start(); // must be a no-op while the marker is set
    assert.equal(scheduler.isRunning(), false);

    // Service-layer installDaemon clears the marker, then start works.
    db.prepare(
      "UPDATE daemon_state SET stopped_by_user = 0 WHERE id = 1",
    ).run();
    scheduler.start();
    assert.equal(scheduler.isRunning(), true);
    scheduler.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("boot catch-up collapses to one execution per due loop (no interval spam)", async () => {
    const root = freshRoot();
    const db = openLoopsDb(root);
    makeDueLoop(db);
    const fake = fakeStore();

    const scheduler = createInAppScheduler(db, fake.store, {
      scanIntervalMs: 30,
      heartbeatIntervalMs: 1000,
      // Short run timeout so the deliberately-never-settling session does not
      // pin the event loop for the default 30 min after the test ends.
      executorOptions: { pollIntervalMs: 20, startGracePolls: 1, runTimeoutMs: 400 },
    });
    scheduler.start();
    // Let the boot pass execute; the run is in flight (session "running"),
    // so subsequent interval ticks must skip the loop (hasRunningRun guard).
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fake.started.length, 1, "due loop executed exactly once");

    scheduler.stop(false);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
