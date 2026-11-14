import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openSessionDb } from "./openDb.js";
import { SESSION_DB_SCHEMA_VERSION } from "./schema.js";
import {
  deleteSession,
  FSM_BLACKBOARD_MAX_BYTES,
  loadAllSessions,
  updateFsmBlackboard,
  upsertSession,
} from "./sessionRepository.js";
import type { Session } from "../types.js";

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  const now = Date.now();
  return {
    id,
    type: "agent",
    title: `Session ${id}`,
    createdAt: now,
    updatedAt: now,
    status: "idle",
    progressText: "",
    messages: [],
    model: "test-model",
    providerId: "default",
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

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "jellybot-bb-"));
}

function loadedById(db: ReturnType<typeof openSessionDb>, id: string): Session {
  const loaded = loadAllSessions(db).find((s) => s.id === id);
  assert.ok(loaded, `session ${id} should exist`);
  return loaded;
}

describe("session fsm blackboard (schema v19)", () => {
  it("roundtrips via upsert (rides the in-memory session)", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(
      db,
      makeSession("s1", {
        fsmBlackboard: { count: 3, label: "phase-2", nested: { ok: true } },
      }),
    );
    const loaded = loadedById(db, "s1");
    assert.deepEqual(loaded.fsmBlackboard, {
      count: 3,
      label: "phase-2",
      nested: { ok: true },
    });
  });

  it("updateFsmBlackboard lands immediately without a full upsert", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("s2"));
    assert.equal(updateFsmBlackboard(db, "s2", { hits: 4 }), true);
    assert.deepEqual(loadedById(db, "s2").fsmBlackboard, { hits: 4 });

    // Missing session id → no row changed.
    assert.equal(updateFsmBlackboard(db, "nope", { hits: 1 }), false);
  });

  it("null / empty data clears the blackboard", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("s3"));
    updateFsmBlackboard(db, "s3", { hits: 1 });
    updateFsmBlackboard(db, "s3", null);
    assert.equal(loadedById(db, "s3").fsmBlackboard, null);
    updateFsmBlackboard(db, "s3", { hits: 1 });
    updateFsmBlackboard(db, "s3", {});
    assert.equal(loadedById(db, "s3").fsmBlackboard, null);
  });

  it("malformed JSON column reads back as null (self-heal on next write)", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("s4"));
    db.prepare(`UPDATE sessions SET fsm_blackboard = '{not json' WHERE id = 's4'`).run();
    assert.equal(loadedById(db, "s4").fsmBlackboard, null);

    db.prepare(`UPDATE sessions SET fsm_blackboard = '[1,2]' WHERE id = 's4'`).run();
    assert.equal(loadedById(db, "s4").fsmBlackboard, null);
  });

  it("deleting the session removes its blackboard (column dies with the row)", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("s5", { fsmBlackboard: { keep: 1 } }));
    assert.equal(deleteSession(db, "s5"), true);
    const row = db
      .prepare("SELECT fsm_blackboard FROM sessions WHERE id = 's5'")
      .get() as { fsm_blackboard: string | null } | undefined;
    assert.equal(row, undefined);
  });

  it("later upsert from a stale session overwrites with in-memory values", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("s6", { fsmBlackboard: { a: 1 } }));
    updateFsmBlackboard(db, "s6", { a: 1, b: 2 });
    // Restart flow: a fresh in-memory session carries its own blackboard.
    upsertSession(db, makeSession("s6", { fsmBlackboard: { a: 9 } }));
    assert.deepEqual(loadedById(db, "s6").fsmBlackboard, { a: 9 });
  });

  it("FSM_BLACKBOARD_MAX_BYTES is the documented 64KB cap", () => {
    assert.equal(FSM_BLACKBOARD_MAX_BYTES, 64 * 1024);
  });
});

describe("schema v19 migration (v18 → v19)", () => {
  function makeLegacyV18Db(root: string): void {
    const db = new DatabaseSync(join(root, "sessions.sqlite"));
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'app',
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        progress_text TEXT NOT NULL,
        model TEXT NOT NULL,
        provider_id TEXT NOT NULL DEFAULT '',
        workspace_id TEXT NOT NULL DEFAULT '',
        workspace_path TEXT NOT NULL,
        pinned INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        archived_at INTEGER,
        context_usage TEXT NOT NULL,
        plan TEXT,
        plan_doc TEXT,
        phase TEXT,
        pending_user_ask TEXT,
        run_mode TEXT,
        infinite INTEGER,
        reasoning_max INTEGER,
        fsm_last_graph_mode TEXT,
        fsm_last_node_id TEXT,
        fsm_last_node_at INTEGER,
        fsm_graph_id TEXT,
        fsm_last_graph_id TEXT
      );
      INSERT INTO schema_meta (key, value) VALUES ('version', '18');
      INSERT INTO sessions (id, type, title, created_at, updated_at, status, progress_text, model, workspace_path, pinned, context_usage)
        VALUES ('legacy', 'agent', 'Legacy', 1, 1, 'idle', '', 'm', '/tmp/ws', 0, '{}');
    `);
    db.close();
  }

  it("adds fsm_blackboard, bumps the version, keeps legacy rows NULL", () => {
    const root = freshRoot();
    makeLegacyV18Db(root);
    const db = openSessionDb(root);
    const version = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: string };
    // Migration stamps the current schema version (v20 added handoff_enabled
    // on top of v19's fsm_blackboard).
    assert.equal(Number(version.value), SESSION_DB_SCHEMA_VERSION);

    const columns = (
      db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
    ).map((col) => col.name);
    assert.ok(columns.includes("fsm_blackboard"));

    const loaded = loadedById(db, "legacy");
    assert.equal(loaded.fsmBlackboard, null);
  });
});
