import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  SESSION_DB_FILENAME,
  SESSION_DB_SCHEMA_VERSION,
  SESSION_DB_SQL,
} from "./schema.js";
import {
  parseStoredMessageParts,
  serializeStoredMessageParts,
} from "./sanitizeMessageParts.js";

export type SessionDatabase = DatabaseSync;

/** Absolute path to the app-level session SQLite file. */
export function sessionDbPath(appDataRoot: string): string {
  return join(appDataRoot, SESSION_DB_FILENAME);
}

function tableHasColumn(
  db: SessionDatabase,
  table: string,
  column: string,
): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.some((row) => row.name === column);
}

function tableExists(db: SessionDatabase, table: string): boolean {
  const row = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    )
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

function migrateToV2(db: SessionDatabase): void {
  if (!tableHasColumn(db, "sessions", "provider_id")) {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN provider_id TEXT NOT NULL DEFAULT ''`,
    );
  }
}

/** Ensure workspaces table + sessions.workspace_id (safe on already-migrated DBs). */
function migrateToV3(db: SessionDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  if (tableExists(db, "sessions") && !tableHasColumn(db, "sessions", "workspace_id")) {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN workspace_id TEXT NOT NULL DEFAULT ''`,
    );
  }
  if (tableHasColumn(db, "sessions", "workspace_id")) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_workspace_id
        ON sessions(workspace_id);
    `);
  }
}

/** Persist multi-step Session.plan JSON (nullable). */
function migrateToV4(db: SessionDatabase): void {
  if (tableExists(db, "sessions") && !tableHasColumn(db, "sessions", "plan")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN plan TEXT`);
  }
}

/** Subagent runs + messages (dedicated tables; not sidebar sessions). */
function migrateToV5(db: SessionDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subagent_runs (
      id TEXT PRIMARY KEY NOT NULL,
      parent_session_id TEXT NOT NULL,
      parent_tool_call_id TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      role TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 50,
      status TEXT NOT NULL,
      progress_text TEXT NOT NULL,
      result_summary TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (parent_session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent
      ON subagent_runs(parent_session_id);

    CREATE TABLE IF NOT EXISTS subagent_messages (
      id TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      tool_call_id TEXT,
      parts TEXT NOT NULL,
      position INTEGER NOT NULL,
      FOREIGN KEY (run_id) REFERENCES subagent_runs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_subagent_messages_run_position
      ON subagent_messages(run_id, position);
  `);
}

/** v6 no-op (version ladder placeholder; session_spills removed in v7). */
function migrateToV6(_db: SessionDatabase): void {}

/** Drop spill index table; scrub legacy spill/anomaly fields from message parts. */
function migrateToV7(db: SessionDatabase): void {
  db.exec(`DROP TABLE IF EXISTS session_spills;`);
}

/** Tool call stats — one row per invocation (separate from agentLog). */
function migrateToV8(db: SessionDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_invocations (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      parent_session_id TEXT,
      subagent_id TEXT,
      tool_call_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_mcp INTEGER NOT NULL DEFAULT 0,
      mcp_server_id TEXT,
      status TEXT NOT NULL,
      reason TEXT NOT NULL,
      return_code INTEGER,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL,
      scene_json TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tool_invocations_name
      ON tool_invocations(name);

    CREATE INDEX IF NOT EXISTS idx_tool_invocations_status
      ON tool_invocations(status);

    CREATE INDEX IF NOT EXISTS idx_tool_invocations_started
      ON tool_invocations(started_at DESC);

    CREATE INDEX IF NOT EXISTS idx_tool_invocations_name_status
      ON tool_invocations(name, status);
  `);
}

/** Persist Session.planDoc JSON (nullable) — docs/plans/ path + summary. */
function migrateToV9(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "plan_doc")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN plan_doc TEXT`);
  }
}

/** Persist Session.phase (nullable) — gathering | drafting | review | executing. */
function migrateToV10(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "plan_phase")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN plan_phase TEXT`);
  }
}

/** Persist Session.pendingUserAsk JSON (nullable). */
function migrateToV11(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "pending_user_ask")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN pending_user_ask TEXT`);
  }
}

/** Workspaces archive flag + timestamp (superseded by v13 session-level archive). */
function migrateToV12(db: SessionDatabase): void {
  if (!tableHasColumn(db, "workspaces", "archived")) {
    db.exec(`ALTER TABLE workspaces ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
  }
  if (!tableHasColumn(db, "workspaces", "archived_at")) {
    db.exec(`ALTER TABLE workspaces ADD COLUMN archived_at INTEGER`);
  }
}

/**
 * Session-level archive. One-time pushdown: workspaces that were archived
 * wholesale mark all their sessions archived, then the workspace archive
 * columns are dropped — visibility is derived from sessions alone.
 * Idempotent: guarded column adds, pushdown only while legacy columns exist.
 */
function migrateToV13(db: SessionDatabase): void {
  if (!tableHasColumn(db, "sessions", "archived")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
  }
  if (!tableHasColumn(db, "sessions", "archived_at")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN archived_at INTEGER`);
  }

  if (tableHasColumn(db, "workspaces", "archived")) {
    const now = Date.now();
    db.prepare(
      `UPDATE sessions
       SET archived = 1,
           archived_at = COALESCE(
             (SELECT w.archived_at FROM workspaces w WHERE w.id = sessions.workspace_id),
             ?
           )
       WHERE workspace_id IN (SELECT id FROM workspaces WHERE archived = 1)`,
    ).run(now);
    db.exec(`ALTER TABLE workspaces DROP COLUMN archived`);
  }
  if (tableHasColumn(db, "workspaces", "archived_at")) {
    db.exec(`ALTER TABLE workspaces DROP COLUMN archived_at`);
  }
}

/**
 * Per-session composer prefs. NULL = not customized → fall back to the
 * process-wide defaults in settings.json; first in-session toggle pins it.
 */
function migrateToV14(db: SessionDatabase): void {
  if (tableExists(db, "sessions") && !tableHasColumn(db, "sessions", "run_mode")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN run_mode TEXT`);
  }
  if (tableExists(db, "sessions") && !tableHasColumn(db, "sessions", "infinite")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN infinite INTEGER`);
  }
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "reasoning_max")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN reasoning_max INTEGER`);
  }
}

/** Session origin marker: 'app' (default) | 'subagent' | 'loop' (daemon). */
function migrateToV15(db: SessionDatabase): void {
  if (tableExists(db, "sessions") && !tableHasColumn(db, "sessions", "source")) {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'app'`,
    );
  }
}

/**
 * DevTools FSM Graph tab persistence (schema v16): last graph mode actually
 * executed + last node visited + timestamp. NULL = never ran a turn → the
 * renderer falls back to composer runMode derivation.
 */
function migrateToV16(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "fsm_last_graph_mode")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN fsm_last_graph_mode TEXT`);
  }
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "fsm_last_node_id")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN fsm_last_node_id TEXT`);
  }
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "fsm_last_node_at")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN fsm_last_node_at INTEGER`);
  }
}

/**
 * Custom FSM graph selection (schema v17): per-session composer graph id +
 * last executed library graph id for the Detail FSM viewer.
 */
function migrateToV17(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "fsm_graph_id")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN fsm_graph_id TEXT`);
  }
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "fsm_last_graph_id")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN fsm_last_graph_id TEXT`);
  }
}

/**
 * Rename Session.planPhase → Session.phase (schema v18).
 * Copies legacy plan_phase into phase when present.
 */
function migrateToV18(db: SessionDatabase): void {
  if (!tableExists(db, "sessions")) return;
  if (!tableHasColumn(db, "sessions", "phase")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN phase TEXT`);
  }
  if (tableHasColumn(db, "sessions", "plan_phase")) {
    db.exec(
      `UPDATE sessions SET phase = plan_phase WHERE phase IS NULL AND plan_phase IS NOT NULL`,
    );
  }
}

/**
 * FSM session blackboard (schema v19): session-scoped key/value JSON blob
 * for NodeActionWriteBlackboard / ReadBlackboard / Compare.
 * NULL = blackboard never written.
 */
function migrateToV19(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "fsm_blackboard")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN fsm_blackboard TEXT`);
  }
}

/**
 * Turn handoff gate (schema v20): per-session opt-in for the turn_handoff
 * tool (composer Self Learning toggle). NULL/false = disabled (default).
 * Written only via the dedicated updateComposerPrefs path.
 */
function migrateToV20(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "handoff_enabled")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN handoff_enabled INTEGER`);
  }
}

/**
 * Reasoning-effort dial (schema v21): per-session level "off" | "low" |
 * "medium" | "high" | "max". NULL = follow the settings.json default.
 * The legacy reasoning_max boolean stays in sync for old builds; reads
 * fall back to it when reasoning_effort is NULL (see sessionRepository).
 */
function migrateToV21(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "reasoning_effort")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT`);
  }
}

/**
 * Session delete-archive summary queue (schema v22): one row per deleted
 * session. The delete transaction moves the full transcript (payload JSON)
 * plus a metadata/date/workspace snapshot here and hard-deletes the
 * sessions row immediately; a serial worker later LLM-summarizes the
 * payload (previous compaction summary + uncovered turns), stores the
 * summary and frees the payload. status: pending|running|done — rows flip
 * running→pending at boot so interrupted tasks resume losslessly.
 */
function migrateToV22(db: SessionDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_history (
      id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      workspace_id TEXT NOT NULL DEFAULT '',
      workspace_name TEXT NOT NULL DEFAULT '',
      workspace_path TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      session_created_at INTEGER NOT NULL,
      session_updated_at INTEGER NOT NULL,
      first_message_at INTEGER,
      last_message_at INTEGER,
      deleted_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      summary TEXT,
      summary_source TEXT,
      input_truncated INTEGER NOT NULL DEFAULT 0,
      summary_model TEXT,
      summarized_at INTEGER,
      payload TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_session_history_status_next
      ON session_history(status, next_attempt_at);

    CREATE INDEX IF NOT EXISTS idx_session_history_workspace
      ON session_history(workspace_id, session_created_at);

    CREATE INDEX IF NOT EXISTS idx_session_history_session_id
      ON session_history(session_id);
  `);
}

/**
 * Device snapshot columns (schema v23): every session_history row records
 * which install deleted the session — groundwork for cross-device memory.
 * device_id reuses the persisted per-install remote relay identity
 * (settings.json remote.deviceId), device_name the relay device name or the
 * hostname, device_os `${platform} ${arch} ${release}`, plus the app
 * version. Pre-v23 rows keep '' (unknown device) — no backfill exists.
 */
function migrateToV23(db: SessionDatabase): void {
  const columns: Array<[name: string, decl: string]> = [
    ["device_id", `TEXT NOT NULL DEFAULT ''`],
    ["device_name", `TEXT NOT NULL DEFAULT ''`],
    ["device_os", `TEXT NOT NULL DEFAULT ''`],
    ["app_version", `TEXT NOT NULL DEFAULT ''`],
  ];
  if (!tableExists(db, "session_history")) return;
  for (const [name, decl] of columns) {
    if (!tableHasColumn(db, "session_history", name)) {
      db.exec(`ALTER TABLE session_history ADD COLUMN ${name} ${decl}`);
    }
  }
}

/**
 * Memory sync groundwork (schema v24):
 * - `session_history.pushed_at` — epoch ms of the last successful remote
 *   push for that done row (0 = never pushed). Remote-merged rows insert
 *   with pushed_at=now so they never echo back (design §7).
 * - `memory_sync_state` — generic KV store for the sync engine: pull cursor
 *   (keyed per serverUrl+deviceId island), last push/pull timestamps and
 *   the human-readable status line payload.
 */
function migrateToV24(db: SessionDatabase): void {
  if (
    tableExists(db, "session_history") &&
    !tableHasColumn(db, "session_history", "pushed_at")
  ) {
    db.exec(
      `ALTER TABLE session_history ADD COLUMN pushed_at INTEGER NOT NULL DEFAULT 0`,
    );
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_sync_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    );
  `);
}

function migrateToV25(db: SessionDatabase): void {
  if (!tableHasColumn(db, "workspaces", "origin")) {
    db.exec(
      `ALTER TABLE workspaces ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'`,
    );
  }
}

function scrubMessagePartsTable(
  db: SessionDatabase,
  table: "messages" | "subagent_messages",
): void {
  if (!tableExists(db, table)) return;
  const rows = db
    .prepare(`SELECT id, role, parts FROM ${table}`)
    .all() as Array<{ id: string; role: string; parts: string }>;
  const update = db.prepare(`UPDATE ${table} SET parts = ? WHERE id = ?`);
  const remove = db.prepare(`DELETE FROM ${table} WHERE id = ?`);
  for (const row of rows) {
    let parts;
    try {
      parts = parseStoredMessageParts(row.parts);
    } catch {
      continue;
    }
    if (parts.length === 0 && row.role === "system") {
      remove.run(row.id);
      continue;
    }
    const next = serializeStoredMessageParts(parts);
    if (next !== row.parts) {
      update.run(next, row.id);
    }
  }
}

/**
 * Open (and migrate) the app-level session database at `{appDataRoot}/sessions.sqlite`.
 *
 * Note: `CREATE TABLE IF NOT EXISTS sessions` does not alter an existing legacy
 * table, so later columns are applied via migrateToV* after the bootstrap SQL.
 */
export function openSessionDb(appDataRoot: string): SessionDatabase {
  mkdirSync(appDataRoot, { recursive: true });

  const db = new DatabaseSync(sessionDbPath(appDataRoot));
  db.exec("PRAGMA foreign_keys = ON;");
  // Multi-process safety: the Loops daemon and the app open this DB concurrently.
  // WAL lets readers proceed while a writer holds the lock; busy_timeout makes
  // lock contention cooperative (wait) instead of failing with SQLITE_BUSY.
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SESSION_DB_SQL);

  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get() as { value: string } | undefined;

  if (!row) {
    migrateToV3(db);
    migrateToV4(db);
    migrateToV5(db);
    migrateToV6(db);
    migrateToV7(db);
    migrateToV8(db);
    migrateToV9(db);
    migrateToV10(db);
    migrateToV11(db);
    migrateToV12(db);
    migrateToV13(db);
    migrateToV14(db);
    migrateToV15(db);
    migrateToV16(db);
    migrateToV17(db);
    migrateToV18(db);
    migrateToV19(db);
    migrateToV20(db);
    migrateToV21(db);
    migrateToV22(db);
    migrateToV23(db);
    migrateToV24(db);
    migrateToV25(db);
    scrubMessagePartsTable(db, "messages");
    scrubMessagePartsTable(db, "subagent_messages");
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('version', ?)",
    ).run(String(SESSION_DB_SCHEMA_VERSION));
  } else {
    const version = Number(row.value);
    if (Number.isNaN(version) || version > SESSION_DB_SCHEMA_VERSION) {
      throw new Error(
        `Unsupported session DB schema version: ${row.value}`,
      );
    }
    if (version < 2) {
      migrateToV2(db);
    }
    // Always ensure later shapes (handles copied legacy DBs and partial upgrades).
    migrateToV3(db);
    migrateToV4(db);
    migrateToV5(db);
    migrateToV6(db);
    migrateToV7(db);
    migrateToV8(db);
    migrateToV9(db);
    migrateToV10(db);
    migrateToV11(db);
    migrateToV12(db);
    migrateToV13(db);
    migrateToV14(db);
    migrateToV15(db);
    migrateToV16(db);
    migrateToV17(db);
    migrateToV18(db);
    migrateToV19(db);
    migrateToV20(db);
    migrateToV21(db);
    migrateToV22(db);
    migrateToV23(db);
    migrateToV24(db);
    migrateToV25(db);
    if (version < 7) {
      scrubMessagePartsTable(db, "messages");
      scrubMessagePartsTable(db, "subagent_messages");
    }
    if (version < SESSION_DB_SCHEMA_VERSION) {
      db.prepare(
        "UPDATE schema_meta SET value = ? WHERE key = 'version'",
      ).run(String(SESSION_DB_SCHEMA_VERSION));
    }
  }

  return db;
}
