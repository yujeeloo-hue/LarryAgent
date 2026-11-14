import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openSessionDb } from "./openDb.js";
import { SESSION_DB_SCHEMA_VERSION } from "./schema.js";
import { loadAllSessions, upsertSession } from "./sessionRepository.js";
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
  return mkdtempSync(join(tmpdir(), "jellybot-fsm-"));
}

describe("session fsm last-state roundtrip (schema v16)", () => {
  it("persists and reads back fsm_last_*", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(
      db,
      makeSession("s1", {
        fsmLastGraphMode: "plan_execute",
        fsmLastNodeId: "executor",
        fsmLastNodeAt: 123456,
      }),
    );
    const loaded = loadAllSessions(db).find((s) => s.id === "s1")!;
    assert.equal(loaded.fsmLastGraphMode, "plan_execute");
    assert.equal(loaded.fsmLastNodeId, "executor");
    assert.equal(loaded.fsmLastNodeAt, 123456);
  });

  it("persists fsmLastGraphId for custom graphs", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(
      db,
      makeSession("s-custom-fsm", {
        fsmLastGraphId: "lib-graph-1",
        fsmLastNodeId: "agent",
        fsmLastNodeAt: 99,
        fsmLastGraphMode: null,
      }),
    );
    const loaded = loadAllSessions(db).find((s) => s.id === "s-custom-fsm")!;
    assert.equal(loaded.fsmLastGraphId, "lib-graph-1");
    assert.equal(loaded.fsmLastGraphMode, null);
  });

  it("NULL columns read back as null (never ran)", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("s2"));
    const loaded = loadAllSessions(db).find((s) => s.id === "s2")!;
    assert.equal(loaded.fsmLastGraphMode, null);
    assert.equal(loaded.fsmLastNodeId, null);
    assert.equal(loaded.fsmLastNodeAt, null);
  });

  it("unknown fsm_last_graph_mode value reads back as null", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("s3"));
    db.prepare(
      `UPDATE sessions SET fsm_last_graph_mode = 'bogus' WHERE id = 's3'`,
    ).run();
    const loaded = loadAllSessions(db).find((s) => s.id === "s3")!;
    assert.equal(loaded.fsmLastGraphMode, null);
  });

  it("later upsert without fsm fields clears them (rides in-memory session)", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(
      db,
      makeSession("s4", {
        fsmLastGraphMode: "react",
        fsmLastNodeId: "agent",
        fsmLastNodeAt: 1,
      }),
    );
    // Fresh in-memory session (e.g. app restart) without telemetry yet.
    upsertSession(db, makeSession("s4", { status: "completed" }));
    const loaded = loadAllSessions(db).find((s) => s.id === "s4")!;
    assert.equal(loaded.fsmLastGraphMode, null);
    assert.equal(loaded.fsmLastNodeId, null);
    assert.equal(loaded.fsmLastNodeAt, null);
    assert.equal(loaded.status, "completed");
  });
});

describe("schema v16 migration (v15 → v16)", () => {
  function makeLegacyV15Db(root: string): void {
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
        plan_phase TEXT,
        pending_user_ask TEXT,
        run_mode TEXT,
        infinite INTEGER,
        reasoning_max INTEGER
      );
      INSERT INTO schema_meta (key, value) VALUES ('version', '15');
    `);
    db.close();
  }

  it("adds the three fsm_last_* columns and leaves legacy rows NULL", () => {
    const root = freshRoot();
    makeLegacyV15Db(root);
    const db = openSessionDb(root);
    const version = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: string };
    assert.equal(Number(version.value), SESSION_DB_SCHEMA_VERSION);

    const columns = (
      db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>
    ).map((col) => col.name);
    assert.ok(columns.includes("fsm_last_graph_mode"));
    assert.ok(columns.includes("fsm_last_node_id"));
    assert.ok(columns.includes("fsm_last_node_at"));
  });
});
