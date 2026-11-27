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

function fakeStore(sessions = new Map<string, FakeSession>()): {
  store: SessionExecutorStore;
  started: string[];
  settle(sessionId: string, status: string): void;
} {
  let seq = 0;
  const started: string[] = [];
  const listeners = new Set<(sessionId: string) => void>();
  const notify = (sessionId: string): void => {
    for (const listener of listeners) listener(sessionId);
  };
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
      isTurnActive: (sessionId) => sessions.get(sessionId)?.status === "running",
      onTurnActivity: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      cancelTurn: (sessionId) => {
        const removed = sessions.delete(sessionId);
        notify(sessionId);
        return removed;
      },
    },
    settle(sessionId, status) {
      const session = sessions.get(sessionId);
      if (session) session.status = status;
      notify(sessionId);
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
      heartbeatIntervalMs: 50,
    });
    scheduler.start();
    assert.equal(scheduler.isRunning(), true);

    await new Promise((r) => setTimeout(r, 250));
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
      heartbeatIntervalMs: 10,
    });
    scheduler.stop(true);
    assert.equal(scheduler.status().stoppedByUser, true);

    scheduler.start();
    assert.equal(scheduler.isRunning(), false);

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
      heartbeatIntervalMs: 1000,
      executorOptions: { runTimeoutMs: 400 },
    });
    scheduler.start();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(fake.started.length, 1, "due loop executed exactly once");

    scheduler.stop(false);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});
