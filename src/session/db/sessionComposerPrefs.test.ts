import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { openSessionDb } from "./openDb.js";
import { SESSION_DB_SCHEMA_VERSION } from "./schema.js";
import {
  loadAllSessions,
  updateComposerPrefs,
  upsertSession,
  validateComposerPrefsPatch,
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
  return mkdtempSync(join(tmpdir(), "jellybot-prefs-"));
}

describe("session composer prefs roundtrip (schema v14)", () => {
  it("persists pinned prefs through upsert and reads them back", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(
      db,
      makeSession("s1", {
        composerRunMode: "plan",
        composerInfinite: true,
        reasoningEffort: "medium",
      }),
    );
    const loaded = loadAllSessions(db).find((s) => s.id === "s1")!;
    assert.equal(loaded.composerRunMode, "plan");
    assert.equal(loaded.composerInfinite, true);
    assert.equal(loaded.reasoningEffort, "medium");
  });

  it("NULL columns read back as null (un-pinned)", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("s2"));
    const loaded = loadAllSessions(db).find((s) => s.id === "s2")!;
    assert.equal(loaded.composerRunMode, null);
    assert.equal(loaded.composerInfinite, null);
    assert.equal(loaded.reasoningEffort, null);
  });

  it("regular upsert does NOT overwrite pinned prefs", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(
      db,
      makeSession("s3", {
        composerRunMode: "ask",
        composerInfinite: true,
        reasoningEffort: "max",
      }),
    );
    // Status-heartbeat style upsert without prefs (fields undefined).
    upsertSession(db, makeSession("s3", { status: "completed" }));
    const loaded = loadAllSessions(db).find((s) => s.id === "s3")!;
    assert.equal(loaded.composerRunMode, "ask");
    assert.equal(loaded.composerInfinite, true);
    assert.equal(loaded.reasoningEffort, "max");
    assert.equal(loaded.status, "completed");
  });

  it("updateComposerPrefs writes partial patches and un-pins with null", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("s4"));
    assert.equal(
      updateComposerPrefs(db, "s4", { runMode: "plan", infinite: true }),
      true,
    );
    let loaded = loadAllSessions(db).find((s) => s.id === "s4")!;
    assert.equal(loaded.composerRunMode, "plan");
    assert.equal(loaded.composerInfinite, true);
    assert.equal(loaded.reasoningEffort, null);

    assert.equal(
      updateComposerPrefs(db, "s4", { reasoningEffort: "off" }),
      true,
    );
    loaded = loadAllSessions(db).find((s) => s.id === "s4")!;
    assert.equal(loaded.reasoningEffort, "off");

    assert.equal(
      updateComposerPrefs(db, "s4", { reasoningEffort: null }),
      true,
    );
    loaded = loadAllSessions(db).find((s) => s.id === "s4")!;
    assert.equal(loaded.reasoningEffort, null);

    assert.equal(updateComposerPrefs(db, "s4", { runMode: null }), true);
    loaded = loadAllSessions(db).find((s) => s.id === "s4")!;
    assert.equal(loaded.composerRunMode, null);
    assert.equal(loaded.composerInfinite, true);

    // Empty patch is a no-op; unknown id reports no change.
    assert.equal(updateComposerPrefs(db, "s4", {}), false);
    assert.equal(
      updateComposerPrefs(db, "missing", { infinite: false }),
      false,
    );
  });
});

describe("schema v14 migration (v13 → v14)", () => {
  function makeLegacyV13Db(root: string): void {
    const db = new DatabaseSync(join(root, "sessions.sqlite"));
    db.exec(`
      CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL,
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
        pending_user_ask TEXT
      );
      INSERT INTO schema_meta (key, value) VALUES ('version', '13');
    `);
    db.prepare(
      `INSERT INTO sessions (
         id, type, title, created_at, updated_at, status, progress_text,
         model, provider_id, workspace_id, workspace_path, pinned,
         archived, context_usage
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-1",
      "agent",
      "Legacy",
      1,
      2,
      "idle",
      "",
      "m",
      "default",
      "ws-1",
      "/tmp/ws",
      0,
      0,
      '{"usedTokens":0}',
    );
    db.close();
  }

  it("adds the three columns and leaves legacy rows NULL", () => {
    const root = freshRoot();
    makeLegacyV13Db(root);
    const db = openSessionDb(root);

    const version = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
      .get() as { value: string };
    // Migration stamps whatever the current schema version is (v15 added
    // sessions.source on top of the v14 composer-pref columns).
    assert.equal(version.value, String(SESSION_DB_SCHEMA_VERSION));

    const columns = (
      db.prepare("PRAGMA table_info(sessions)").all() as Array<{
        name: string;
      }>
    ).map((c) => c.name);
    assert.ok(columns.includes("run_mode"));
    assert.ok(columns.includes("infinite"));
    assert.ok(columns.includes("reasoning_max"));
    assert.ok(columns.includes("reasoning_effort"));
    assert.ok(columns.includes("source"));
    assert.ok(columns.includes("handoff_enabled"));

    const legacy = loadAllSessions(db).find((s) => s.id === "legacy-1")!;
    assert.equal(legacy.composerRunMode, null);
    assert.equal(legacy.composerInfinite, null);
    assert.equal(legacy.reasoningEffort, null);
    assert.equal(legacy.handoffEnabled, null);
  });

  it("legacy reasoning_max boolean migrates to dial levels (v21 read fallback)", () => {
    const root = freshRoot();
    makeLegacyV13Db(root);
    const db = openSessionDb(root);
    db.prepare(
      `UPDATE sessions SET reasoning_max = 1 WHERE id = 'legacy-1'`,
    ).run();
    db.prepare(
      `INSERT INTO sessions (
         id, type, title, created_at, updated_at, status, progress_text,
         model, provider_id, workspace_id, workspace_path, pinned,
         archived, context_usage, reasoning_max
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "legacy-0",
      "agent",
      "Legacy Off",
      1,
      2,
      "idle",
      "",
      "m",
      "default",
      "ws-1",
      "/tmp/ws",
      0,
      0,
      '{"usedTokens":0}',
      0,
    );
    const all = loadAllSessions(db);
    // reasoning_max=1 → "max" via the legacy fallback.
    assert.equal(
      all.find((s) => s.id === "legacy-1")!.reasoningEffort,
      "max",
    );
    // reasoning_max=0 → "low" (the old off-state behavior).
    assert.equal(
      all.find((s) => s.id === "legacy-0")!.reasoningEffort,
      "low",
    );
  });

  it("re-open is idempotent and keeps pinned values", () => {
    const root = freshRoot();
    const db1 = openSessionDb(root);
    upsertSession(
      db1,
      makeSession("s5", { composerRunMode: "plan", composerInfinite: true }),
    );
    db1.close();
    const db2 = openSessionDb(root);
    const loaded = loadAllSessions(db2).find((s) => s.id === "s5")!;
    assert.equal(loaded.composerRunMode, "plan");
    assert.equal(loaded.composerInfinite, true);
  });

  it("persists custom runMode + composerFsmGraphId", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("s-custom"));
    assert.equal(
      updateComposerPrefs(db, "s-custom", {
        runMode: "custom",
        fsmGraphId: "graph-abc",
      }),
      true,
    );
    const loaded = loadAllSessions(db).find((s) => s.id === "s-custom")!;
    assert.equal(loaded.composerRunMode, "custom");
    assert.equal(loaded.composerFsmGraphId, "graph-abc");
  });
});

describe("validateComposerPrefsPatch (IPC input)", () => {
  it("accepts valid patches including null un-pin", () => {
    validateComposerPrefsPatch({});
    validateComposerPrefsPatch({ runMode: "plan" });
    validateComposerPrefsPatch({ runMode: "custom", fsmGraphId: "g1" });
    validateComposerPrefsPatch({ runMode: null });
    validateComposerPrefsPatch({ infinite: true, reasoningEffort: "low" });
    validateComposerPrefsPatch({ infinite: null, reasoningEffort: null });
    validateComposerPrefsPatch({ reasoningEffort: "medium" });
  });

  it("rejects invalid enum and non-boolean values", () => {
    assert.throws(() =>
      validateComposerPrefsPatch({ runMode: "infinite" as never }),
    );
    assert.throws(() => validateComposerPrefsPatch({ infinite: 1 as never }));
    assert.throws(() =>
      validateComposerPrefsPatch({ reasoningEffort: "xhigh" as never }),
    );
    assert.throws(() =>
      validateComposerPrefsPatch({ reasoningEffort: true as never }),
    );
  });
});

describe("handoffEnabled gate (schema v20)", () => {
  it("persists the pinned gate through upsert and reads it back", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("h1", { handoffEnabled: true }));
    upsertSession(db, makeSession("h2", { handoffEnabled: false }));
    upsertSession(db, makeSession("h3"));
    const all = loadAllSessions(db);
    assert.equal(all.find((s) => s.id === "h1")!.handoffEnabled, true);
    assert.equal(all.find((s) => s.id === "h2")!.handoffEnabled, false);
    assert.equal(all.find((s) => s.id === "h3")!.handoffEnabled, null);
  });

  it("regular upsert does NOT overwrite the pinned gate", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("h4", { handoffEnabled: true }));
    // Status-heartbeat style upsert without the gate (field undefined).
    upsertSession(db, makeSession("h4", { status: "completed" }));
    const loaded = loadAllSessions(db).find((s) => s.id === "h4")!;
    assert.equal(loaded.handoffEnabled, true);
    assert.equal(loaded.status, "completed");
  });

  it("updateComposerPrefs writes the gate and un-pins with null", () => {
    const root = freshRoot();
    const db = openSessionDb(root);
    upsertSession(db, makeSession("h5"));
    assert.equal(
      updateComposerPrefs(db, "h5", { handoffEnabled: true }),
      true,
    );
    let loaded = loadAllSessions(db).find((s) => s.id === "h5")!;
    assert.equal(loaded.handoffEnabled, true);

    assert.equal(
      updateComposerPrefs(db, "h5", { handoffEnabled: false }),
      true,
    );
    loaded = loadAllSessions(db).find((s) => s.id === "h5")!;
    assert.equal(loaded.handoffEnabled, false);

    assert.equal(
      updateComposerPrefs(db, "h5", { handoffEnabled: null }),
      true,
    );
    loaded = loadAllSessions(db).find((s) => s.id === "h5")!;
    assert.equal(loaded.handoffEnabled, null);
  });

  it("validateComposerPrefsPatch accepts boolean/null and rejects others", () => {
    validateComposerPrefsPatch({ handoffEnabled: true });
    validateComposerPrefsPatch({ handoffEnabled: false });
    validateComposerPrefsPatch({ handoffEnabled: null });
    assert.throws(() =>
      validateComposerPrefsPatch({ handoffEnabled: 1 as never }),
    );
    assert.throws(() =>
      validateComposerPrefsPatch({ handoffEnabled: "yes" as never }),
    );
  });
});
