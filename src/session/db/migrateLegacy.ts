/**
 * One-time migration from legacy `{cwd}/.jellybot/*` into app userData.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  WORKSPACE_SETTINGS_DIR,
  WORKSPACE_SETTINGS_FILE,
} from "../../settings/types.js";
import { resolveSettingsDir } from "../../settings/settingsRoot.js";
import { SESSION_DB_FILENAME } from "./schema.js";
import { sessionDbPath } from "./openDb.js";

const MIGRATION_FLAG = "legacy_cwd_migrated";

function appSettingsPath(appDataRoot: string): string {
  // Route through the settings-root override: under jellybot-agentd this
  // resolves to /etc/jellybot-agent, not the data dir (desktop/tests keep
  // the historical appDataRoot path — override is null there).
  return join(resolveSettingsDir(appDataRoot), WORKSPACE_SETTINGS_FILE);
}

function legacySettingsPath(cwd: string): string {
  return join(cwd, WORKSPACE_SETTINGS_DIR, WORKSPACE_SETTINGS_FILE);
}

function legacySessionDbPath(cwd: string): string {
  return join(cwd, WORKSPACE_SETTINGS_DIR, SESSION_DB_FILENAME);
}

function setMigrationFlag(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(MIGRATION_FLAG, "1");
  } finally {
    db.close();
  }
}

/**
 * Copy legacy cwd `.jellybot` settings/db into appDataRoot when targets are missing.
 * Does not open the app DB through openSessionDb (caller does that after).
 */
export function migrateLegacyCwdData(appDataRoot: string, cwd: string): void {
  mkdirSync(appDataRoot, { recursive: true });

  const destSettings = appSettingsPath(appDataRoot);
  const destDb = sessionDbPath(appDataRoot);
  const srcSettings = legacySettingsPath(cwd);
  const srcDb = legacySessionDbPath(cwd);

  if (!existsSync(destSettings) && existsSync(srcSettings)) {
    try {
      copyFileSync(srcSettings, destSettings);
      console.log(`[migrate] copied settings → ${destSettings}`);
    } catch (err) {
      console.error("[migrate] failed to copy settings", err);
    }
  }

  if (!existsSync(destDb) && existsSync(srcDb)) {
    try {
      copyFileSync(srcDb, destDb);
      console.log(`[migrate] copied sessions db → ${destDb}`);
    } catch (err) {
      console.error("[migrate] failed to copy sessions db", err);
    }
  }

  // Ensure settings carry a default activeWorkspaceId after workspace bootstrap
  // (done in session store once workspaces exist).
  void cwd;
}

/**
 * Ensure at least one workspace exists; attach orphan sessions; set migration flag.
 * Call after openSessionDb so schema is v3.
 */
export function ensureDefaultWorkspaceAndAttachSessions(
  db: DatabaseSync,
  cwd: string,
  options?: { preferredName?: string },
): { workspaceId: string; created: boolean } {
  const existing = db
    .prepare(
      `SELECT id FROM workspaces ORDER BY updated_at DESC LIMIT 1`,
    )
    .get() as { id: string } | undefined;

  if (existing) {
    // Attach sessions still missing workspace_id
    db.prepare(
      `UPDATE sessions
       SET workspace_id = ?
       WHERE (workspace_id IS NULL OR workspace_id = '')
         AND type = 'agent'`,
    ).run(existing.id);
    setMigrationFlagOnOpenDb(db);
    return { workspaceId: existing.id, created: false };
  }

  const now = Date.now();
  const id = randomUUID();
  const name =
    options?.preferredName?.trim() ||
    basename(cwd) ||
    "Workspace";
  const path = cwd;

  db.prepare(
    `INSERT INTO workspaces (id, name, path, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, name, path, now, now);

  db.prepare(
    `UPDATE sessions
     SET workspace_id = ?, workspace_path = ?
     WHERE (workspace_id IS NULL OR workspace_id = '')
       AND type = 'agent'`,
  ).run(id, path);

  // Also fix agent sessions that have empty workspace_id after copy
  db.prepare(
    `UPDATE sessions SET workspace_path = ? WHERE workspace_id = ?`,
  ).run(path, id);

  setMigrationFlagOnOpenDb(db);
  console.log(`[migrate] created default workspace id=${id} path=${path}`);
  return { workspaceId: id, created: true };
}

function setMigrationFlagOnOpenDb(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO schema_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(MIGRATION_FLAG, "1");
}

/** Seed activeWorkspaceId in settings.json if missing. */
export function seedActiveWorkspaceInSettings(
  appDataRoot: string,
  workspaceId: string,
): void {
  const filePath = appSettingsPath(appDataRoot);
  try {
    let data: Record<string, unknown> = {};
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      }
    }
    if (
      typeof data.activeWorkspaceId === "string" &&
      data.activeWorkspaceId.trim()
    ) {
      return;
    }
    data.activeWorkspaceId = workspaceId;
    writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  } catch (err) {
    console.error("[migrate] failed to seed activeWorkspaceId", err);
  }
}

export { MIGRATION_FLAG };
