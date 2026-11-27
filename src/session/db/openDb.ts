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

function migrateToV4(db: SessionDatabase): void {
  if (tableExists(db, "sessions") && !tableHasColumn(db, "sessions", "plan")) {
    db.exec(`ALTER TABLE sessions ADD COLUMN plan TEXT`);
  }
}

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

function migrateToV6(_db: SessionDatabase): void {}

function migrateToV7(db: SessionDatabase): void {
  db.exec(`DROP TABLE IF EXISTS session_spills;`);
}

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

function migrateToV9(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "plan_doc")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN plan_doc TEXT`);
  }
}

function migrateToV10(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "plan_phase")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN plan_phase TEXT`);
  }
}

function migrateToV11(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "pending_user_ask")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN pending_user_ask TEXT`);
  }
}

function migrateToV12(db: SessionDatabase): void {
  if (!tableHasColumn(db, "workspaces", "archived")) {
    db.exec(`ALTER TABLE workspaces ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
  }
  if (!tableHasColumn(db, "workspaces", "archived_at")) {
    db.exec(`ALTER TABLE workspaces ADD COLUMN archived_at INTEGER`);
  }
}

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

function migrateToV15(db: SessionDatabase): void {
  if (tableExists(db, "sessions") && !tableHasColumn(db, "sessions", "source")) {
    db.exec(
      `ALTER TABLE sessions ADD COLUMN source TEXT NOT NULL DEFAULT 'app'`,
    );
  }
}

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

function migrateToV19(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "fsm_blackboard")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN fsm_blackboard TEXT`);
  }
}

function migrateToV21(db: SessionDatabase): void {
  if (
    tableExists(db, "sessions") &&
    !tableHasColumn(db, "sessions", "reasoning_effort")
  ) {
    db.exec(`ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT`);
  }
}

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

function migrateToV26(db: SessionDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS skill_usage (
      id TEXT PRIMARY KEY NOT NULL,
      skill_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_revision INTEGER,
      session_id TEXT NOT NULL,
      subagent_id TEXT,
      read_at INTEGER NOT NULL,
      errors_at_read INTEGER NOT NULL DEFAULT 0,
      recoveries_at_read INTEGER NOT NULL DEFAULT 0,
      corrections_at_read INTEGER NOT NULL DEFAULT 0,
      outcome TEXT,
      errors_after INTEGER,
      recoveries_after INTEGER,
      user_steered INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_skill_usage_skill
      ON skill_usage(skill_id, read_at);

    CREATE INDEX IF NOT EXISTS idx_skill_usage_session
      ON skill_usage(session_id, read_at);
  `);
}

function migrateToV27(db: SessionDatabase): void {
  if (
    tableExists(db, "tool_invocations") &&
    !tableHasColumn(db, "tool_invocations", "doc_revision")
  ) {
    db.exec(
      `ALTER TABLE tool_invocations ADD COLUMN doc_revision INTEGER NOT NULL DEFAULT 0`,
    );
  }
}

function migrateToV28(db: SessionDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_doc_revisions (
      name TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0,
      doc_hash TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  if (tableExists(db, "sessions") && tableHasColumn(db, "sessions", "handoff_enabled")) {
    db.exec(`ALTER TABLE sessions DROP COLUMN handoff_enabled`);
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

export function openSessionDb(appDataRoot: string): SessionDatabase {
  mkdirSync(appDataRoot, { recursive: true });

  const db = new DatabaseSync(sessionDbPath(appDataRoot));
  db.exec("PRAGMA foreign_keys = ON;");
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
    migrateToV21(db);
    migrateToV22(db);
    migrateToV23(db);
    migrateToV24(db);
    migrateToV25(db);
    migrateToV26(db);
    migrateToV27(db);
    migrateToV28(db);
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
    migrateToV21(db);
    migrateToV22(db);
    migrateToV23(db);
    migrateToV24(db);
    migrateToV25(db);
    migrateToV26(db);
    migrateToV27(db);
    migrateToV28(db);
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
