import type { SessionDatabase } from "./openDb.js";
import { IS_WINDOWS } from "../../platformCaps.js";
import { SHELL_TOOL_NAME } from "../../tools/shellToolName.js";

export type ToolInvocationStatus =
  | "success"
  | "tool_error"
  | "denied"
  | "invalid"
  | "exception"
  | "cancelled";

export type ToolInvocationRecord = {
  id: string;
  sessionId: string;
  parentSessionId?: string;
  subagentId?: string;
  toolCallId: string;
  name: string;
  isMcp: boolean;
  mcpServerId?: string;
  status: ToolInvocationStatus;
  reason: string;
  returnCode?: number;
  startedAt: number;
  durationMs: number;
  /** Description revision in effect at call time; 0 = code baseline. */
  docRevision: number;
  sceneJson?: string;
  createdAt: number;
};

export type ToolInvocationSummaryRow = {
  name: string;
  calls: number;
  success: number;
  failure: number;
};

export type ListToolInvocationsOptions = {
  status?: ToolInvocationStatus | "failure";
  name?: string;
  /** Restrict to one conversation (own calls + its subagents). */
  sessionId?: string;
  limit?: number;
  offset?: number;
};

type ToolInvocationRow = {
  id: string;
  session_id: string;
  parent_session_id: string | null;
  subagent_id: string | null;
  tool_call_id: string;
  name: string;
  is_mcp: number;
  mcp_server_id: string | null;
  status: string;
  reason: string;
  return_code: number | null;
  started_at: number;
  duration_ms: number;
  doc_revision: number;
  scene_json: string | null;
  created_at: number;
};

function rowToRecord(row: ToolInvocationRow): ToolInvocationRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    ...(row.parent_session_id
      ? { parentSessionId: row.parent_session_id }
      : {}),
    ...(row.subagent_id ? { subagentId: row.subagent_id } : {}),
    toolCallId: row.tool_call_id,
    name: row.name,
    isMcp: row.is_mcp === 1,
    ...(row.mcp_server_id ? { mcpServerId: row.mcp_server_id } : {}),
    status: row.status as ToolInvocationStatus,
    reason: row.reason,
    ...(row.return_code != null ? { returnCode: row.return_code } : {}),
    startedAt: row.started_at,
    durationMs: row.duration_ms,
    docRevision: row.doc_revision,
    ...(row.scene_json != null ? { sceneJson: row.scene_json } : {}),
    createdAt: row.created_at,
  };
}

export function insertToolInvocation(
  db: SessionDatabase,
  record: ToolInvocationRecord,
): void {
  db.prepare(
    `INSERT INTO tool_invocations (
      id, session_id, parent_session_id, subagent_id, tool_call_id,
      name, is_mcp, mcp_server_id, status, reason, return_code,
      started_at, duration_ms, doc_revision, scene_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.sessionId,
    record.parentSessionId ?? null,
    record.subagentId ?? null,
    record.toolCallId,
    record.name,
    record.isMcp ? 1 : 0,
    record.mcpServerId ?? null,
    record.status,
    record.reason,
    record.returnCode ?? null,
    record.startedAt,
    record.durationMs,
    record.docRevision ?? 0,
    record.sceneJson ?? null,
    record.createdAt,
  );
}

/**
 * Retired builtin tool names → current canonical name. Stats history predates
 * renames (edit_file/append_file were replaced by patch; bash by run_shell),
 * so reads canonicalize for grouping instead of rewriting stored rows.
 * Windows v1: the shell tool registers as exec_command there — rows written
 * as run_shell (or bash) canonicalize to the local name on Windows builds.
 */
export const LEGACY_TOOL_NAME_ALIASES: Readonly<Record<string, string>> = {
  edit_file: "patch",
  append_file: "patch",
  bash: SHELL_TOOL_NAME,
  ...(IS_WINDOWS ? { run_shell: "exec_command" } : {}),
};

/** SQL CASE that maps legacy names to canonical ones at query time. */
const CANONICAL_NAME_SQL = `CASE name
  WHEN 'edit_file' THEN 'patch'
  WHEN 'append_file' THEN 'patch'
  WHEN 'bash' THEN '${SHELL_TOOL_NAME}'
  ${IS_WINDOWS ? "WHEN 'run_shell' THEN 'exec_command'" : ""}
  ELSE name
END`;

export function canonicalToolName(name: string): string {
  return LEGACY_TOOL_NAME_ALIASES[name] ?? name;
}

/** All stored names that read back as `name` after canonicalization. */
function storedNamesFor(name: string): string[] {
  const names = [name];
  for (const [legacy, canonical] of Object.entries(LEGACY_TOOL_NAME_ALIASES)) {
    if (canonical === name && !names.includes(legacy)) names.push(legacy);
  }
  return names;
}

export function summarizeToolInvocations(
  db: SessionDatabase,
  options: { sessionId?: string } = {},
): ToolInvocationSummaryRow[] {
  const sessionClause =
    options.sessionId && options.sessionId.trim()
      ? `WHERE session_id = ? OR parent_session_id = ?`
      : "";
  const sessionParams = sessionClause
    ? [options.sessionId!.trim(), options.sessionId!.trim()]
    : [];
  const rows = db
    .prepare(
      `SELECT
         ${CANONICAL_NAME_SQL} AS name,
         COUNT(*) AS calls,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
         SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS failure
       FROM tool_invocations
       ${sessionClause}
       GROUP BY ${CANONICAL_NAME_SQL}
       ORDER BY calls DESC, name ASC`,
    )
    .all(...sessionParams) as Array<{
    name: string;
    calls: number;
    success: number;
    failure: number;
  }>;
  return rows.map((row) => ({
    name: row.name,
    calls: Number(row.calls) || 0,
    success: Number(row.success) || 0,
    failure: Number(row.failure) || 0,
  }));
}

/** Delete every recorded invocation; returns the number of rows removed. */
export function clearToolInvocations(db: SessionDatabase): number {
  const result = db.prepare(`DELETE FROM tool_invocations`).run();
  return Number(result.changes) || 0;
}

export function listToolInvocations(
  db: SessionDatabase,
  options: ListToolInvocationsOptions = {},
): ToolInvocationRecord[] {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (options.status === "failure") {
    clauses.push(`status != 'success'`);
  } else if (options.status) {
    clauses.push(`status = ?`);
    params.push(options.status);
  }
  if (options.name && options.name.trim()) {
    const stored = storedNamesFor(options.name.trim());
    clauses.push(
      stored.length === 1 ? `name = ?` : `name IN (${stored.map(() => "?").join(", ")})`,
    );
    params.push(...stored);
  }
  if (options.sessionId && options.sessionId.trim()) {
    const sid = options.sessionId.trim();
    clauses.push(`(session_id = ? OR parent_session_id = ?)`);
    params.push(sid, sid);
  }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit, offset);

  const rows = db
    .prepare(
      `SELECT * FROM tool_invocations
       ${where}
       ORDER BY started_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params) as ToolInvocationRow[];

  return rows.map(rowToRecord);
}

export function getToolInvocation(
  db: SessionDatabase,
  id: string,
): ToolInvocationRecord | null {
  const row = db
    .prepare(`SELECT * FROM tool_invocations WHERE id = ?`)
    .get(id) as ToolInvocationRow | undefined;
  return row ? rowToRecord(row) : null;
}
