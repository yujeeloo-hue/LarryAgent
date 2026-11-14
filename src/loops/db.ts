import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "../llm/reasoningEffort.js";

/** SQLite schema version for the Loops database. */
export const LOOPS_DB_SCHEMA_VERSION = 3;

export const LOOPS_DB_FILENAME = "loops.sqlite";

export type LoopRunMode = "agent" | "plan" | "ask";

export type LoopRunStatus =
  | "running"
  | "succeeded"
  | "failed"
  | "timeout"
  | "skipped";

export interface LoopRecord {
  id: string;
  name: string;
  prompt: string;
  workspaceId: string;
  runMode: LoopRunMode;
  providerId: string;
  /** Reasoning-effort dial level for loop turns (schema v3). */
  reasoningEffort: ReasoningEffort;
  fullPermissions: boolean;
  /** Cadence stored as a JSON string (shape owned by src/loops/schedule.ts). */
  cadenceJson: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

/** Loop fields settable at creation; id/timestamps/run stats are generated. */
export interface NewLoop {
  name: string;
  prompt: string;
  workspaceId: string;
  runMode: LoopRunMode;
  providerId: string;
  reasoningEffort: ReasoningEffort;
  fullPermissions: boolean;
  cadenceJson: string;
  enabled: boolean;
  nextRunAt: number | null;
}

/** Mutable subset for updates; all fields optional, undefined = unchanged. */
export type LoopPatch = Partial<NewLoop>;

export interface LoopRunRecord {
  id: string;
  loopId: string;
  sessionId: string | null;
  status: LoopRunStatus;
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

export interface DaemonInfoRecord {
  pid: number;
  appVersion: string;
  heartbeatAt: number;
}

const LOOPS_DB_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loops (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  prompt TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  run_mode TEXT NOT NULL DEFAULT 'agent',
  provider_id TEXT NOT NULL DEFAULT '',
  reasoning_max INTEGER NOT NULL DEFAULT 0,
  reasoning_effort TEXT NOT NULL DEFAULT 'low',
  full_permissions INTEGER NOT NULL DEFAULT 0,
  cadence TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  run_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_loops_due
  ON loops(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS loop_runs (
  id TEXT PRIMARY KEY NOT NULL,
  loop_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  error TEXT,
  FOREIGN KEY (loop_id) REFERENCES loops(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_loop_runs_loop_started
  ON loop_runs(loop_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_loop_runs_status
  ON loop_runs(status);

CREATE TABLE IF NOT EXISTS daemon_info (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  pid INTEGER NOT NULL,
  app_version TEXT NOT NULL,
  heartbeat_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS daemon_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK (id = 1),
  stopped_by_user INTEGER NOT NULL DEFAULT 0
);
`;

/** Absolute path to the Loops SQLite file. */
export function loopsDbPath(appDataRoot: string): string {
  return join(appDataRoot, LOOPS_DB_FILENAME);
}

/**
 * Open (and migrate) the Loops database at `{appDataRoot}/loops.sqlite`.
 *
 * Shared data plane between the app and the Loops daemon: WAL journal mode +
 * busy_timeout so both processes can read/write concurrently; keep statements
 * short (no long transactions) to avoid cross-process lock stalls.
 */
export function openLoopsDb(appDataRoot: string): DatabaseSync {
  mkdirSync(appDataRoot, { recursive: true });

  const db = new DatabaseSync(loopsDbPath(appDataRoot));
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(LOOPS_DB_SQL);

  // v3: reasoning-effort dial column. Existing rows backfill from the legacy
  // Max boolean (1 → "max", 0 → "low") in one UPDATE.
  const loopColumns = db
    .prepare("PRAGMA table_info(loops)")
    .all() as Array<{ name: string }>;
  if (!loopColumns.some((column) => column.name === "reasoning_effort")) {
    db.exec(`ALTER TABLE loops ADD COLUMN reasoning_effort TEXT`);
    db
      .prepare(
        `UPDATE loops SET reasoning_effort = CASE WHEN reasoning_max = 1 THEN 'max' ELSE 'low' END`,
      )
      .run();
  }

  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'version'")
    .get() as { value: string } | undefined;
  if (!row) {
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('version', ?)",
    ).run(String(LOOPS_DB_SCHEMA_VERSION));
  } else {
    const version = Number(row.value);
    if (Number.isNaN(version) || version > LOOPS_DB_SCHEMA_VERSION) {
      db.close();
      throw new Error(`Unsupported loops DB schema version: ${row.value}`);
    }
    // Migrations: v2 added daemon_state, v3 the reasoning_effort dial
    // column (both handled by the CREATE IF NOT EXISTS / column check above);
    // older rows just record the new version.
    if (version < LOOPS_DB_SCHEMA_VERSION) {
      db.prepare(
        "UPDATE schema_meta SET value = ? WHERE key = 'version'",
      ).run(String(LOOPS_DB_SCHEMA_VERSION));
    }
  }

  return db;
}

type LoopRow = {
  id: string;
  name: string;
  prompt: string;
  workspace_id: string;
  run_mode: string;
  provider_id: string;
  reasoning_max: number;
  reasoning_effort: string | null;
  full_permissions: number;
  cadence: string;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  run_count: number;
  created_at: number;
  updated_at: number;
};

function parseRunMode(value: string): LoopRunMode {
  return value === "plan" || value === "ask" ? value : "agent";
}

function mapLoopRow(row: LoopRow): LoopRecord {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    workspaceId: row.workspace_id,
    runMode: parseRunMode(row.run_mode),
    providerId: row.provider_id,
    // Schema v3 dial level; pre-v3 rows fall back to the Max boolean.
    reasoningEffort: normalizeReasoningEffort(
      row.reasoning_effort ?? row.reasoning_max,
    ),
    fullPermissions: row.full_permissions !== 0,
    cadenceJson: row.cadence,
    enabled: row.enabled !== 0,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listLoops(db: DatabaseSync): LoopRecord[] {
  const rows = db
    .prepare("SELECT * FROM loops ORDER BY created_at ASC")
    .all() as LoopRow[];
  return rows.map(mapLoopRow);
}

export function getLoop(db: DatabaseSync, id: string): LoopRecord | null {
  const row = db
    .prepare("SELECT * FROM loops WHERE id = ?")
    .get(id) as LoopRow | undefined;
  return row ? mapLoopRow(row) : null;
}

export function insertLoop(db: DatabaseSync, input: NewLoop): LoopRecord {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO loops (
       id, name, prompt, workspace_id, run_mode, provider_id,
       reasoning_max, reasoning_effort, full_permissions, cadence, enabled,
       next_run_at, last_run_at, run_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
  ).run(
    id,
    input.name,
    input.prompt,
    input.workspaceId,
    input.runMode,
    input.providerId,
    input.reasoningEffort === "max" ? 1 : 0,
    input.reasoningEffort,
    input.fullPermissions ? 1 : 0,
    input.cadenceJson,
    input.enabled ? 1 : 0,
    input.nextRunAt,
    now,
    now,
  );
  const record = getLoop(db, id);
  if (!record) throw new Error(`insertLoop failed for ${id}`);
  return record;
}

export function updateLoop(
  db: DatabaseSync,
  id: string,
  patch: LoopPatch,
): LoopRecord | null {
  const current = getLoop(db, id);
  if (!current) return null;
  const next: NewLoop & { nextRunAt: number | null } = {
    name: patch.name ?? current.name,
    prompt: patch.prompt ?? current.prompt,
    workspaceId: patch.workspaceId ?? current.workspaceId,
    runMode: patch.runMode ?? current.runMode,
    providerId: patch.providerId ?? current.providerId,
    reasoningEffort: patch.reasoningEffort ?? current.reasoningEffort,
    fullPermissions: patch.fullPermissions ?? current.fullPermissions,
    cadenceJson: patch.cadenceJson ?? current.cadenceJson,
    enabled: patch.enabled ?? current.enabled,
    nextRunAt: patch.nextRunAt ?? current.nextRunAt,
  };
  db.prepare(
    `UPDATE loops SET
       name = ?, prompt = ?, workspace_id = ?, run_mode = ?, provider_id = ?,
       reasoning_max = ?, reasoning_effort = ?, full_permissions = ?, cadence = ?, enabled = ?,
       next_run_at = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    next.name,
    next.prompt,
    next.workspaceId,
    next.runMode,
    next.providerId,
    next.reasoningEffort === "max" ? 1 : 0,
    next.reasoningEffort,
    next.fullPermissions ? 1 : 0,
    next.cadenceJson,
    next.enabled ? 1 : 0,
    next.nextRunAt,
    Date.now(),
    id,
  );
  return getLoop(db, id);
}

export function deleteLoop(db: DatabaseSync, id: string): boolean {
  const result = db.prepare("DELETE FROM loops WHERE id = ?").run(id);
  return (result.changes ?? 0) > 0;
}

export function setLoopEnabled(
  db: DatabaseSync,
  id: string,
  enabled: boolean,
): LoopRecord | null {
  db.prepare("UPDATE loops SET enabled = ?, updated_at = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    Date.now(),
    id,
  );
  return getLoop(db, id);
}

/** Enabled loops whose next_run_at is due (<= now), oldest first. */
export function dueLoops(db: DatabaseSync, now: number): LoopRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM loops
       WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC`,
    )
    .all(now) as LoopRow[];
  return rows.map(mapLoopRow);
}

/** Advance a loop's next_run_at after a run was queued/executed. */
export function setLoopNextRun(
  db: DatabaseSync,
  id: string,
  nextRunAt: number | null,
): void {
  db.prepare("UPDATE loops SET next_run_at = ? WHERE id = ?").run(
    nextRunAt,
    id,
  );
}

/** Record a finished run: bump run_count + last_run_at. */
export function recordLoopRunCompletion(
  db: DatabaseSync,
  loopId: string,
  endedAt: number,
): void {
  db.prepare(
    `UPDATE loops SET
       run_count = run_count + 1,
       last_run_at = ?,
       updated_at = ?
     WHERE id = ?`,
  ).run(endedAt, Date.now(), loopId);
}

type LoopRunRow = {
  id: string;
  loop_id: string;
  session_id: string | null;
  status: string;
  started_at: number;
  ended_at: number | null;
  error: string | null;
};

function parseRunStatus(value: string): LoopRunStatus {
  switch (value) {
    case "running":
    case "succeeded":
    case "failed":
    case "timeout":
    case "skipped":
      return value;
    default:
      return "failed";
  }
}

function mapRunRow(row: LoopRunRow): LoopRunRecord {
  return {
    id: row.id,
    loopId: row.loop_id,
    sessionId: row.session_id,
    status: parseRunStatus(row.status),
    startedAt: row.started_at,
    endedAt: row.ended_at,
    error: row.error,
  };
}

export function insertLoopRun(
  db: DatabaseSync,
  loopId: string,
  status: LoopRunStatus = "running",
): LoopRunRecord {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO loop_runs (id, loop_id, session_id, status, started_at, ended_at)
     VALUES (?, ?, NULL, ?, ?, NULL)`,
  ).run(id, loopId, status, now);
  const row = db
    .prepare("SELECT * FROM loop_runs WHERE id = ?")
    .get(id) as LoopRunRow;
  return mapRunRow(row);
}

export function finishLoopRun(
  db: DatabaseSync,
  runId: string,
  finish: {
    status: LoopRunStatus;
    sessionId?: string | null;
    error?: string | null;
  },
): void {
  db.prepare(
    `UPDATE loop_runs SET status = ?, session_id = COALESCE(?, session_id),
       ended_at = ?, error = ? WHERE id = ?`,
  ).run(
    finish.status,
    finish.sessionId ?? null,
    Date.now(),
    finish.error ?? null,
    runId,
  );
}

export function listLoopRuns(
  db: DatabaseSync,
  loopId: string,
  limit = 20,
): LoopRunRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM loop_runs WHERE loop_id = ?
       ORDER BY started_at DESC LIMIT ?`,
    )
    .all(loopId, limit) as LoopRunRow[];
  return rows.map(mapRunRow);
}

/** True while a loop's latest run is still 'running' (re-entry guard). */
export function hasRunningRun(db: DatabaseSync, loopId: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM loop_runs
       WHERE loop_id = ? AND status = 'running' LIMIT 1`,
    )
    .get(loopId) as { hit: number } | undefined;
  return Boolean(row);
}

export function updateDaemonHeartbeat(
  db: DatabaseSync,
  pid: number,
  appVersion: string,
): void {
  db.prepare(
    `INSERT INTO daemon_info (id, pid, app_version, heartbeat_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       pid = excluded.pid,
       app_version = excluded.app_version,
       heartbeat_at = excluded.heartbeat_at`,
  ).run(pid, appVersion, Date.now());
}

export function getDaemonInfo(
  db: DatabaseSync,
): DaemonInfoRecord | null {
  const row = db
    .prepare("SELECT pid, app_version, heartbeat_at FROM daemon_info WHERE id = 1")
    .get() as
    | { pid: number; app_version: string; heartbeat_at: number }
    | undefined;
  if (!row) return null;
  return {
    pid: row.pid,
    appVersion: row.app_version,
    heartbeatAt: row.heartbeat_at,
  };
}

/**
 * Deliberate-stop marker. While set, the app must not resurrect the daemon
 * (screen-entry auto-ensure, startup repair) — only an explicit user start
 * (Install & Enable) clears it.
 */
export function getDaemonStoppedByUser(db: DatabaseSync): boolean {
  const row = db
    .prepare(
      "SELECT stopped_by_user AS stopped FROM daemon_state WHERE id = 1",
    )
    .get() as { stopped: number } | undefined;
  return row ? row.stopped !== 0 : false;
}

export function setDaemonStoppedByUser(
  db: DatabaseSync,
  stopped: boolean,
): void {
  db.prepare(
    `INSERT INTO daemon_state (id, stopped_by_user) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET stopped_by_user = excluded.stopped_by_user`,
  ).run(stopped ? 1 : 0);
}
