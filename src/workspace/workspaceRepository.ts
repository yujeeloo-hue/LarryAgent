import type { SessionDatabase } from "../session/db/openDb.js";
import { COCO_HOME_WORKSPACE_ID, type Workspace } from "./types.js";

type WorkspaceRow = {
  id: string;
  name: string;
  path: string;
  origin?: string | null;
  created_at: number;
  updated_at: number;
};

function rowToWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    origin: row.origin === "coco" ? "coco" : "user",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const WORKSPACE_COLUMNS = `id, name, path, origin, created_at, updated_at`;

/** All project workspaces (Coco home excluded); callers derive archive visibility from sessions. */
export function loadAllWorkspaces(db: SessionDatabase): Workspace[] {
  const rows = db
    .prepare(
      `SELECT ${WORKSPACE_COLUMNS}
       FROM workspaces WHERE id != ?
       ORDER BY updated_at DESC`,
    )
    .all(COCO_HOME_WORKSPACE_ID) as WorkspaceRow[];
  return rows.map(rowToWorkspace);
}

export function getWorkspace(
  db: SessionDatabase,
  workspaceId: string,
): Workspace | null {
  const row = db
    .prepare(
      `SELECT ${WORKSPACE_COLUMNS}
       FROM workspaces WHERE id = ?`,
    )
    .get(workspaceId) as WorkspaceRow | undefined;
  return row ? rowToWorkspace(row) : null;
}

export function upsertWorkspace(db: SessionDatabase, workspace: Workspace): void {
  db.prepare(
    `INSERT INTO workspaces (id, name, path, origin, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       path = excluded.path,
       origin = excluded.origin,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  ).run(
    workspace.id,
    workspace.name,
    workspace.path,
    workspace.origin,
    workspace.createdAt,
    workspace.updatedAt,
  );
}

export function deleteWorkspaceRow(
  db: SessionDatabase,
  workspaceId: string,
): boolean {
  const result = db
    .prepare("DELETE FROM workspaces WHERE id = ?")
    .run(workspaceId) as { changes: number };
  return result.changes > 0;
}

/** Sync denormalized session.workspace_path when a workspace path changes. */
export function syncSessionWorkspacePaths(
  db: SessionDatabase,
  workspaceId: string,
  path: string,
): void {
  db.prepare(
    `UPDATE sessions SET workspace_path = ? WHERE workspace_id = ?`,
  ).run(path, workspaceId);
}

export function listSessionIdsForWorkspace(
  db: SessionDatabase,
  workspaceId: string,
): string[] {
  const rows = db
    .prepare(`SELECT id FROM sessions WHERE workspace_id = ?`)
    .all(workspaceId) as Array<{ id: string }>;
  return rows.map((r) => r.id);
}
