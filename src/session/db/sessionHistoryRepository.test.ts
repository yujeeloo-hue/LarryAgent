import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { openSessionDb } from "./openDb.js";
import { SESSION_DB_SCHEMA_VERSION } from "./schema.js";
import { upsertSession } from "./sessionRepository.js";
import {
  completeHistoryTask,
  countOutstandingHistoryTasks,
  earliestHistoryAttemptAt,
  failHistoryTask,
  forceDueAllHistoryTasks,
  getHistoryBySessionId,
  getHistoryTaskPayload,
  loadSummarizedHistory,
  markHistoryTaskRunning,
  moveSessionToHistory,
  snapshotSessionToHistory,
  getLatestHistoryBySessionId,
  historyRowCoversSession,
  pickNextHistoryTask,
  resetRunningHistoryTasks,
} from "./sessionHistoryRepository.js";
import type { Session } from "../types.js";
import type { SessionDatabase as Db } from "./openDb.js";

function makeSession(
  id: string,
  overrides: Partial<Session> = {},
): Session {
  const now = Date.parse("2026-01-02T03:04:05Z");
  return {
    id,
    type: "agent",
    title: `Session ${id}`,
    createdAt: now,
    updatedAt: now + 5_000,
    status: "idle",
    progressText: "",
    messages: [
      {
        id: `${id}-m1`,
        role: "user",
        parts: [{ type: "text", text: "fix relay deploy" }],
        createdAt: now + 1_000,
      },
      {
        id: `${id}-m2`,
        role: "assistant",
        parts: [{ type: "text", text: "deployed relay" }],
        createdAt: now + 2_000,
      },
    ],
    model: "test-model",
    providerId: "prov-1",
    workspaceId: "ws-1",
    workspacePath: "/tmp/ws",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
    ...overrides,
  };
}

function freshDb(): { root: string; db: Db } {
  const root = mkdtempSync(join(tmpdir(), "jellybot-history-"));
  const db = openSessionDb(root);
  db.prepare(
    `INSERT INTO workspaces (id, name, path, created_at, updated_at)
     VALUES ('ws-1', 'Proj', '/tmp/ws', 1, 1)`,
  ).run();
  return { root, db };
}

function historyRow(db: Db, id: string): Record<string, unknown> {
  return db
    .prepare(`SELECT * FROM session_history WHERE id = ?`)
    .get(id) as Record<string, unknown>;
}

describe("session_history schema (v23)", () => {
  it("creates the table on a fresh database", () => {
    const { root, db } = freshDb();
    const version = db
      .prepare(`SELECT value FROM schema_meta WHERE key = 'version'`)
      .get() as { value: string };
    assert.equal(Number(version.value), SESSION_DB_SCHEMA_VERSION);
    const table = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='session_history'`,
      )
      .get();
    assert.ok(table);
    // Device snapshot columns (v23) exist on fresh databases.
    const columns = (
      db.prepare(`PRAGMA table_info(session_history)`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    for (const name of ["device_id", "device_name", "device_os", "app_version"]) {
      assert.ok(columns.includes(name), `missing column ${name}`);
    }
    db.close();
    void root;
  });
});

describe("moveSessionToHistory", () => {
  it("relocates transcript + snapshot and hard-deletes the session atomically", () => {
    const { db } = freshDb();
    const session = makeSession("s1");
    upsertSession(db, session);
    const ok = moveSessionToHistory(db, session, {
      historyId: "h1",
      deletedAt: 123,
      device: {
        deviceId: "dev-1234-abcd",
        deviceName: "Mac Studio",
        deviceOs: "darwin arm64 24.6.0",
        appVersion: "1.2.3",
      },
    });
    assert.equal(ok, true);
    // Session row and messages are gone.
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id='s1'`).get()!
        .n,
      0,
    );
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id='s1'`)
        .get()!.n,
      0,
    );
    // History row is pending with the full snapshot.
    const row = historyRow(db, "h1");
    assert.equal(row.status, "pending");
    assert.equal(row.session_id, "s1");
    assert.equal(row.title, "Session s1");
    assert.equal(row.workspace_id, "ws-1");
    assert.equal(row.workspace_name, "Proj"); // resolved from workspaces
    assert.equal(row.workspace_path, "/tmp/ws");
    assert.equal(row.provider_id, "prov-1");
    assert.equal(row.model, "test-model");
    assert.equal(row.device_id, "dev-1234-abcd");
    assert.equal(row.device_name, "Mac Studio");
    assert.equal(row.device_os, "darwin arm64 24.6.0");
    assert.equal(row.app_version, "1.2.3");
    assert.equal(row.session_created_at, session.createdAt);
    assert.equal(row.session_updated_at, session.updatedAt);
    assert.equal(row.first_message_at, session.messages[0]!.createdAt);
    assert.equal(row.last_message_at, session.messages[1]!.createdAt);
    assert.equal(row.deleted_at, 123);
    assert.equal(row.summary, null);
    // Payload round-trips through the reader.
    const payload = getHistoryTaskPayload(db, "h1");
    assert.equal(payload.length, 2);
    assert.equal(payload[0]!.parts[0]!.type, "text");
    db.close();
  });

  it("archives an archived session identically (same delete funnel)", () => {
    const { db } = freshDb();
    const session = makeSession("s2", {
      archived: true,
      archivedAt: 999,
    });
    upsertSession(db, session);
    assert.equal(
      moveSessionToHistory(db, session, { historyId: "h2", deletedAt: 200 }),
      true,
    );
    const row = historyRow(db, "h2");
    assert.equal(row.status, "pending");
    // Omitted device snapshot (legacy callers) records '' — unknown device.
    assert.equal(row.device_id, "");
    assert.equal(row.device_name, "");
    assert.equal(row.device_os, "");
    assert.equal(row.app_version, "");
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE id='s2'`).get()!
        .n,
      0,
    );
    db.close();
  });

  it("returns false when the session row is missing", () => {
    const { db } = freshDb();
    const ghost = makeSession("ghost");
    assert.equal(
      moveSessionToHistory(db, ghost, { historyId: "h3", deletedAt: 1 }),
      false,
    );
    assert.equal(historyRow(db, "h3"), undefined);
    db.close();
  });
});

describe("history task state machine", () => {
  function seedPending(db: Db, id: string): void {
    const session = makeSession(id);
    upsertSession(db, session);
    moveSessionToHistory(db, session, { historyId: `h-${id}`, deletedAt: 10 });
  }

  it("runs pending → running → done with payload freed", () => {
    const { db } = freshDb();
    seedPending(db, "t1");
    const now = 100;
    const task = pickNextHistoryTask(db, now);
    assert.ok(task);
    assert.equal(task!.id, "h-t1");
    assert.equal(task!.sessionId, "t1");

    assert.equal(markHistoryTaskRunning(db, "h-t1"), true);
    // A running row is not pickable and cannot be double-claimed.
    assert.equal(pickNextHistoryTask(db, now), null);
    assert.equal(markHistoryTaskRunning(db, "h-t1"), false);

    assert.equal(
      completeHistoryTask(db, "h-t1", {
        summary: "SUMMARY",
        summarySource: "llm",
        summaryModel: "m1",
        inputTruncated: true,
        now: 500,
      }),
      true,
    );
    const row = historyRow(db, "h-t1");
    assert.equal(row.status, "done");
    assert.equal(row.summary, "SUMMARY");
    assert.equal(row.summary_source, "llm");
    assert.equal(row.summary_model, "m1");
    assert.equal(row.input_truncated, 1);
    assert.equal(row.summarized_at, 500);
    assert.equal(row.payload, null); // freed
    assert.deepEqual(getHistoryTaskPayload(db, "h-t1"), []);
    assert.equal(countOutstandingHistoryTasks(db), 0);
    assert.equal(loadSummarizedHistory(db).length, 1);
    db.close();
  });

  it("backs off on failure and retries after the window", () => {
    const { db } = freshDb();
    seedPending(db, "t2");
    markHistoryTaskRunning(db, "h-t2");
    assert.equal(
      failHistoryTask(db, "h-t2", {
        attempts: 1,
        nextAttemptAt: 1_000,
        error: "provider down",
      }),
      true,
    );
    const row = historyRow(db, "h-t2");
    assert.equal(row.status, "pending");
    assert.equal(row.attempts, 1);
    assert.equal(row.next_attempt_at, 1_000);
    assert.equal(row.error, "provider down");
    // Not due before the window; due after.
    assert.equal(pickNextHistoryTask(db, 999), null);
    const due = pickNextHistoryTask(db, 1_000);
    assert.ok(due);
    assert.equal(due!.id, "h-t2");
    db.close();
  });

  it("recovers running rows to pending on reopen (crash recovery)", () => {
    const { db } = freshDb();
    seedPending(db, "t3");
    markHistoryTaskRunning(db, "h-t3");
    assert.equal(resetRunningHistoryTasks(db), 1);
    assert.equal(historyRow(db, "h-t3").status, "pending");
    // Idempotent when nothing is running.
    assert.equal(resetRunningHistoryTasks(db), 0);
    db.close();
  });

  it("force-due and earliest-attempt helpers drive wake scheduling", () => {
    const { db } = freshDb();
    seedPending(db, "t4");
    seedPending(db, "t5");
    db.prepare(
      `UPDATE session_history SET next_attempt_at = 5000 WHERE id='h-t4'`,
    ).run();
    assert.equal(earliestHistoryAttemptAt(db), 0); // h-t5 still due now
    assert.equal(forceDueAllHistoryTasks(db), 2);
    assert.equal(earliestHistoryAttemptAt(db), 0);
    // getHistoryBySessionId resolves done rows only (search read path);
    // pending rows are invisible until summarized.
    assert.equal(getHistoryBySessionId(db, "t4"), null);
    // completion only accepts a claimed (running) row — same guard the
    // worker goes through.
    assert.equal(markHistoryTaskRunning(db, "h-t4"), true);
    assert.equal(
      completeHistoryTask(db, "h-t4", {
        summary: "S",
        summarySource: "llm",
        summaryModel: "m",
        inputTruncated: false,
        now: 600,
      }),
      true,
    );
    const bySession = getHistoryBySessionId(db, "t4");
    assert.ok(bySession);
    assert.equal(bySession!.id, "h-t4");
    db.close();
  });
});

describe("archive snapshot (archive-time memory write)", () => {
  it("copies the transcript into the queue without deleting the session", () => {
    const { db } = freshDb();
    const session = makeSession("a1");
    upsertSession(db, session);

    snapshotSessionToHistory(db, session, {
      historyId: "h-a1",
      archivedAt: 4_242,
    });

    const row = historyRow(db, "h-a1");
    assert.equal(row.status, "pending");
    assert.equal(row.session_id, "a1");
    assert.equal(row.deleted_at, 4_242); // stamped at archive time
    assert.equal(row.session_updated_at, session.updatedAt);
    assert.ok(typeof row.payload === "string" && row.payload.length > 0);

    // The session row and its messages survive the snapshot.
    const live = db
      .prepare(`SELECT id FROM sessions WHERE id = 'a1'`)
      .get();
    assert.ok(live);
    const messages = db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = 'a1'`)
      .get() as { n: number };
    assert.equal(messages.n, 2);

    // The snapshot rides the normal queue: pickable by the worker.
    const task = pickNextHistoryTask(db, 0);
    assert.ok(task);
    assert.equal(task!.id, "h-a1");
    db.close();
  });

  it("covers the session until conversation activity moves past the row", () => {
    const { db } = freshDb();
    const session = makeSession("a2");
    upsertSession(db, session);
    snapshotSessionToHistory(db, session, {
      historyId: "h-a2",
      archivedAt: 10,
    });

    // Fresh snapshot covers the current transcript.
    const fresh = getLatestHistoryBySessionId(db, "a2");
    assert.ok(fresh);
    assert.equal(historyRowCoversSession(fresh!, session), true);

    // More conversation after the snapshot ⇒ no longer covered.
    const grown: Session = { ...session, updatedAt: session.updatedAt + 1 };
    assert.equal(historyRowCoversSession(fresh!, grown), false);

    // Equal timestamps cover (archiving itself never bumps updated_at).
    assert.equal(
      historyRowCoversSession(
        { sessionUpdatedAt: session.updatedAt },
        { updatedAt: session.updatedAt },
      ),
      true,
    );
    db.close();
  });

  it("supersedes a prior row for the same session (one row per session)", () => {
    const { db } = freshDb();
    const session = makeSession("a3");
    upsertSession(db, session);

    // First archive snapshot, then the worker summarizes it.
    snapshotSessionToHistory(db, session, {
      historyId: "h-a3-1",
      archivedAt: 10,
    });
    markHistoryTaskRunning(db, "h-a3-1");
    completeHistoryTask(db, "h-a3-1", {
      summary: "first summary",
      summarySource: "llm",
      summaryModel: "m",
      inputTruncated: false,
      now: 20,
    });

    // Session grew after unarchive, then re-archived: the new snapshot
    // REPLACES the done row instead of duplicating it.
    const grown: Session = {
      ...session,
      updatedAt: session.updatedAt + 60_000,
      messages: [
        ...session.messages,
        {
          id: "a3-m3",
          role: "user",
          parts: [{ type: "text", text: "follow-up work" }],
          createdAt: session.updatedAt + 30_000,
        },
      ],
    };
    upsertSession(db, grown);
    snapshotSessionToHistory(db, grown, {
      historyId: "h-a3-2",
      archivedAt: 100,
    });

    const rows = db
      .prepare(`SELECT id FROM session_history WHERE session_id = 'a3'`)
      .all() as Array<{ id: string }>;
    assert.deepEqual(
      rows.map((r) => r.id),
      ["h-a3-2"],
    );
    const latest = getLatestHistoryBySessionId(db, "a3");
    assert.ok(latest);
    assert.equal(latest!.status, "pending");
    assert.equal(latest!.sessionUpdatedAt, grown.updatedAt);
    assert.equal(historyRowCoversSession(latest!, grown), true);
    db.close();
  });

  it("moveSessionToHistory supersedes a prior snapshot row (delete path)", () => {
    const { db } = freshDb();
    const session = makeSession("a4");
    upsertSession(db, session);

    // Archived pre-feature (or snapshot pending) → stale because the
    // session kept growing; delete must re-summarize via the move path.
    snapshotSessionToHistory(db, session, {
      historyId: "h-a4-snap",
      archivedAt: 10,
    });
    const grown: Session = { ...session, updatedAt: session.updatedAt + 1 };
    upsertSession(db, grown);

    assert.equal(
      moveSessionToHistory(db, grown, { historyId: "h-a4-move", deletedAt: 50 }),
      true,
    );
    const rows = db
      .prepare(`SELECT id FROM session_history WHERE session_id = 'a4'`)
      .all() as Array<{ id: string }>;
    assert.deepEqual(
      rows.map((r) => r.id),
      ["h-a4-move"],
    );
    // Session row is gone (messages cascade).
    assert.equal(
      db.prepare(`SELECT id FROM sessions WHERE id = 'a4'`).get(),
      undefined,
    );
    db.close();
  });
});
