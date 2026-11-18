import type { SessionDatabase } from "./openDb.js";

export type ToolDocRevisionRow = {
  name: string;
  revision: number;
  docHash: string;
  updatedAt: number;
};

export function getToolDocRevision(
  db: SessionDatabase,
  name: string,
): ToolDocRevisionRow | null {
  const row = db
    .prepare(
      `SELECT name, revision, doc_hash, updated_at
       FROM tool_doc_revisions WHERE name = ?`,
    )
    .get(name) as
    | { name: string; revision: number; doc_hash: string; updated_at: number }
    | undefined;
  if (!row) return null;
  return {
    name: row.name,
    revision: Number(row.revision) || 0,
    docHash: row.doc_hash,
    updatedAt: Number(row.updated_at) || 0,
  };
}

export function upsertToolDocRevision(
  db: SessionDatabase,
  row: ToolDocRevisionRow,
): void {
  db.prepare(
    `INSERT INTO tool_doc_revisions (name, revision, doc_hash, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       revision = excluded.revision,
       doc_hash = excluded.doc_hash,
       updated_at = excluded.updated_at`,
  ).run(row.name, row.revision, row.docHash, row.updatedAt);
}

export function listToolDocRevisions(
  db: SessionDatabase,
): ToolDocRevisionRow[] {
  const rows = db
    .prepare(
      `SELECT name, revision, doc_hash, updated_at
       FROM tool_doc_revisions ORDER BY name ASC`,
    )
    .all() as Array<{
    name: string;
    revision: number;
    doc_hash: string;
    updated_at: number;
  }>;
  return rows.map((row) => ({
    name: row.name,
    revision: Number(row.revision) || 0,
    docHash: row.doc_hash,
    updatedAt: Number(row.updated_at) || 0,
  }));
}
