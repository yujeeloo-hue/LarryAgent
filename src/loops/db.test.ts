import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import {
  LOOPS_DB_FILENAME,
  LOOPS_DB_SCHEMA_VERSION,
  deleteLoop,
  dueLoops,
  finishLoopRun,
  getDaemonInfo,
  getDaemonStoppedByUser,
  getLoop,
  hasRunningRun,
  insertLoop,
  insertLoopRun,
  listLoopRuns,
  listLoops,
  loopsDbPath,
  openLoopsDb,
  recordLoopRunCompletion,
  setDaemonStoppedByUser,
  setLoopEnabled,
  setLoopNextRun,
  updateDaemonHeartbeat,
  updateLoop,
} from "./db.js";
import { openSessionDb } from "../session/db/openDb.js";

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "jellybot-loops-"));
}

function makeInput(overrides: Partial<Parameters<typeof insertLoop>[1]> = {}) {
  return {
    name: "Daily build",
    prompt: "run the build",
    workspaceId: "ws-1",
    runMode: "agent" as const,
    providerId: "deepseek",
    reasoningEffort: "max" as const,
    fullPermissions: false,
    cadenceJson: JSON.stringify({ kind: "day", time: "09:00" }),
    enabled: true,
    nextRunAt: Date.parse("2026-08-24T09:00:00"),
    ...overrides,
  };
}

describe("loops db schema", () => {
  it("creates tables and reports WAL mode", () => {
    const root = freshRoot();
    const db = openLoopsDb(root);
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    assert.ok(names.includes("loops"));
    assert.ok(names.includes("loop_runs"));
    assert.ok(names.includes("daemon_info"));
    const mode = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    assert.equal(mode.journal_mode, "wal");
    db.close();
  });

  it("is idempotent when reopened", () => {
    const root = freshRoot();
    const first = openLoopsDb(root);
    first.close();
    const second = openLoopsDb(root);
    assert.equal(listLoops(second).length, 0);
    second.close();
  });
});

describe("loops crud", () => {
  it("inserts, updates, toggles, and deletes loops", () => {
    const db = openLoopsDb(freshRoot());
    const created = insertLoop(db, makeInput());
    assert.ok(created.id);
    assert.equal(created.runCount, 0);
    assert.equal(created.reasoningEffort, "max");
    assert.equal(created.fullPermissions, false);

    const updated = updateLoop(db, created.id, {
      name: "Weekly",
      fullPermissions: true,
    });
    assert.equal(updated?.name, "Weekly");
    assert.equal(updated?.fullPermissions, true);
    assert.equal(updated?.prompt, "run the build", "unset fields unchanged");

    const toggled = setLoopEnabled(db, created.id, false);
    assert.equal(toggled?.enabled, false);

    assert.equal(deleteLoop(db, created.id), true);
    assert.equal(getLoop(db, created.id), null);
    assert.equal(deleteLoop(db, created.id), false);
    db.close();
  });

  it("lists due loops oldest-first", () => {
    const db = openLoopsDb(freshRoot());
    const now = 1_000_000;
    const older = insertLoop(db, makeInput({ nextRunAt: now - 100 }));
    const newer = insertLoop(db, makeInput({ nextRunAt: now - 10 }));
    insertLoop(db, makeInput({ nextRunAt: now + 50 }));
    insertLoop(db, makeInput({ nextRunAt: now - 5, enabled: false }));
    insertLoop(db, makeInput({ nextRunAt: null as unknown as number }));

    const due = dueLoops(db, now);
    assert.deepEqual(
      due.map((l) => l.id),
      [older.id, newer.id],
    );

    setLoopNextRun(db, older.id, now + 999);
    assert.equal(dueLoops(db, now).length, 1);
    db.close();
  });

  it("tracks run lifecycle and re-entry guard", () => {
    const db = openLoopsDb(freshRoot());
    const loop = insertLoop(db, makeInput());
    const run = insertLoopRun(db, loop.id, "running");
    assert.equal(hasRunningRun(db, loop.id), true);

    finishLoopRun(db, run.id, {
      status: "succeeded",
      sessionId: "sess-1",
      error: null,
    });
    assert.equal(hasRunningRun(db, loop.id), false);

    recordLoopRunCompletion(db, loop.id, Date.now());
    const after = getLoop(db, loop.id);
    assert.equal(after?.runCount, 1);
    assert.ok(after?.lastRunAt);

    const runs = listLoopRuns(db, loop.id, 10);
    assert.equal(runs.length, 1);
    const first = runs[0];
    assert.ok(first);
    assert.equal(first.sessionId, "sess-1");
    assert.equal(first.status, "succeeded");

    // Deleting a loop cascades to its runs.
    deleteLoop(db, loop.id);
    assert.equal(listLoopRuns(db, loop.id, 10).length, 0);
    db.close();
  });

  it("upserts daemon heartbeat", () => {
    const db = openLoopsDb(freshRoot());
    assert.equal(getDaemonInfo(db), null);
    updateDaemonHeartbeat(db, 123, "0.5.1");
    const first = getDaemonInfo(db);
    assert.equal(first?.pid, 123);
    updateDaemonHeartbeat(db, 456, "0.6.0");
    const second = getDaemonInfo(db);
    assert.equal(second?.pid, 456);
    assert.equal(second?.appVersion, "0.6.0");
    assert.ok(second?.heartbeatAt >= (first?.heartbeatAt ?? 0));
    db.close();
  });

  it("round-trips the deliberate-stop marker (default off)", () => {
    const db = openLoopsDb(freshRoot());
    assert.equal(getDaemonStoppedByUser(db), false);
    setDaemonStoppedByUser(db, true);
    assert.equal(getDaemonStoppedByUser(db), true);
    setDaemonStoppedByUser(db, false);
    assert.equal(getDaemonStoppedByUser(db), false);
    db.close();
  });

  it("migrates a v1 database: adds daemon_state and bumps the version", () => {
    const root = freshRoot();
    const db = openLoopsDb(root);
    db.prepare("UPDATE schema_meta SET value = '1' WHERE key = 'version'")
      .run();
    db.exec("DROP TABLE daemon_state");
    db.close();

    const migrated = openLoopsDb(root);
    const version = migrated
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: string };
    assert.equal(version.value, String(LOOPS_DB_SCHEMA_VERSION));
    assert.equal(getDaemonStoppedByUser(migrated), false);
    setDaemonStoppedByUser(migrated, true);
    assert.equal(getDaemonStoppedByUser(migrated), true);
    migrated.close();
  });
});

describe("dual-connection concurrency smoke (app + daemon)", () => {
  it("interleaves writes across two connections without SQLITE_BUSY", () => {
    const root = freshRoot();
    const app = openLoopsDb(root);
    const daemon = openLoopsDb(root);

    const loop = insertLoop(app, makeInput());

    // Daemon writes runs while the app reads/writes the same DB.
    const runA = insertLoopRun(daemon, loop.id, "running");
    const runB = insertLoopRun(daemon, loop.id, "running");
    assert.equal(listLoops(app).length, 1);
    assert.equal(hasRunningRun(app, loop.id), true);

    finishLoopRun(daemon, runA.id, { status: "succeeded" });
    finishLoopRun(daemon, runB.id, { status: "failed", error: "boom" });
    recordLoopRunCompletion(daemon, loop.id, Date.now());
    updateDaemonHeartbeat(daemon, 4242, "0.5.1");

    assert.equal(getLoop(app, loop.id)?.runCount, 1);
    assert.equal(getDaemonInfo(app)?.pid, 4242);
    const runs = listLoopRuns(app, loop.id, 10);
    assert.equal(runs.length, 2);
    assert.equal(runs.some((r) => r.status === "failed" && r.error === "boom"), true);

    daemon.close();
    app.close();
  });

  it("shares the loops db between processes via the same file path", () => {
    const root = freshRoot();
    const a = openLoopsDb(root);
    const b = new DatabaseSync(loopsDbPath(root));
    b.exec("PRAGMA journal_mode = WAL;");
    b.exec("PRAGMA busy_timeout = 5000;");
    const loop = insertLoop(a, makeInput());
    const row = b
      .prepare("SELECT id FROM loops WHERE id = ?")
      .get(loop.id) as { id: string } | undefined;
    assert.equal(row?.id, loop.id);
    b.close();
    a.close();
  });

  it("opens sessions db twice concurrently (WAL + busy_timeout applied)", () => {
    const root = freshRoot();
    const a = openSessionDb(root);
    const b = openSessionDb(root);
    for (const db of [a, b]) {
      const mode = db.prepare("PRAGMA journal_mode").get() as {
        journal_mode: string;
      };
      assert.equal(mode.journal_mode, "wal");
      const timeout = db.prepare("PRAGMA busy_timeout").get() as {
        timeout: number;
      };
      assert.equal(timeout.timeout, 5000);
    }
    b.close();
    a.close();
  });
});
