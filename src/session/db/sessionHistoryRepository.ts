import type { SessionDatabase } from "./openDb.js";
import type { Message, Session } from "../types.js";
import {
  parseStoredMessageParts,
  serializeStoredMessageParts,
} from "./sanitizeMessageParts.js";

/**
 * session_history (schema v22) — the delete-archive summary queue AND the
 * long-term work-history record. Lifecycle:
 *
 *   deleteSession ──moveSessionToHistory──▶ pending (payload = full transcript)
 *   archive flag  ──snapshotSessionToHistory▶ pending (copy; session row stays)
 *   worker pump   ──pickNext + markRunning▶ running
 *   summarize ok  ──completeHistoryTask───▶ done (summary stored, payload freed)
 *   summarize err ──failHistoryTask───────▶ pending (attempts/error/backoff)
 *   app boot      ──resetRunningHistoryTasks▶ pending (crash recovery)
 *
 * Invariant: at most ONE row per original session_id. Both insert paths
 * supersede (delete + reinsert) any prior row for the same session, so a
 * re-summarize after further conversation replaces instead of duplicating;
 * memory-sync arbitration (newer summarizedAt wins) converges the relay.
 */

/** Queue lifecycle of a history row. "failed" is reserved (never set today). */
export type SessionHistoryStatus = "pending" | "running" | "done";

/**
 * How the stored summary was produced. "discarded" rows are LLM-judged
 * no-value tombstones: summary holds the one-line discard reason (audit),
 * and search surfaces skip them.
 */
export type SessionHistorySummarySource = "llm" | "empty" | "discarded";

/**
 * Device snapshot stamped onto the row at delete time (schema v23) — which
 * install deleted the session. Groundwork for cross-device memory; see
 * `readSessionDeviceSnapshot` for how the values are sourced.
 */
export type SessionHistoryDevice = {
  deviceId: string;
  deviceName: string;
  deviceOs: string;
  appVersion: string;
};

/** Domain view of one session_history row (payload handled separately). */
export type SessionHistoryRecord = {
  id: string;
  sessionId: string;
  title: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  providerId: string;
  model: string;
  deviceId: string;
  deviceName: string;
  deviceOs: string;
  appVersion: string;
  sessionCreatedAt: number;
  sessionUpdatedAt: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  deletedAt: number;
  status: SessionHistoryStatus;
  attempts: number;
  nextAttemptAt: number;
  error: string | null;
  summary: string | null;
  summarySource: SessionHistorySummarySource | null;
  inputTruncated: boolean;
  summaryModel: string | null;
  summarizedAt: number | null;
};

type SessionHistoryRow = {
  id: string;
  session_id: string;
  title: string;
  workspace_id: string;
  workspace_name: string;
  workspace_path: string;
  provider_id: string;
  model: string;
  device_id: string;
  device_name: string;
  device_os: string;
  app_version: string;
  session_created_at: number;
  session_updated_at: number;
  first_message_at: number | null;
  last_message_at: number | null;
  deleted_at: number;
  status: string;
  attempts: number;
  next_attempt_at: number;
  error: string | null;
  summary: string | null;
  summary_source: string | null;
  input_truncated: number;
  summary_model: string | null;
  summarized_at: number | null;
};

/** Stored payload item — the messages table row shape, JSON-encoded. */
type HistoryPayloadItem = {
  id: string;
  role: string;
  created_at: number;
  tool_call_id: string | null;
  parts: string;
  position: number;
};

const HISTORY_COLUMNS = `id, session_id, title, workspace_id, workspace_name, workspace_path,
       provider_id, model, device_id, device_name, device_os, app_version,
       session_created_at, session_updated_at,
       first_message_at, last_message_at, deleted_at, status, attempts,
       next_attempt_at, error, summary, summary_source, input_truncated,
       summary_model, summarized_at`;

function rowToHistoryRecord(row: SessionHistoryRow): SessionHistoryRecord {
  const status: SessionHistoryStatus =
    row.status === "running" || row.status === "done" ? row.status : "pending";
  const summarySource =
    row.summary_source === "llm" ||
    row.summary_source === "empty" ||
    row.summary_source === "discarded"
      ? row.summary_source
      : null;
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspacePath: row.workspace_path,
    providerId: row.provider_id,
    model: row.model,
    deviceId: row.device_id,
    deviceName: row.device_name,
    deviceOs: row.device_os,
    appVersion: row.app_version,
    sessionCreatedAt: row.session_created_at,
    sessionUpdatedAt: row.session_updated_at,
    firstMessageAt: row.first_message_at,
    lastMessageAt: row.last_message_at,
    deletedAt: row.deleted_at,
    status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    error: row.error,
    summary: row.summary,
    summarySource,
    inputTruncated: row.input_truncated === 1,
    summaryModel: row.summary_model,
    summarizedAt: row.summarized_at,
  };
}

/** Serialize Message[] into the stored payload JSON (messages-row shape). */
export function serializeHistoryPayload(messages: Message[]): string {
  const items: HistoryPayloadItem[] = messages.map((message, index) => ({
    id: message.id,
    role: message.role,
    created_at: message.createdAt,
    tool_call_id:
      message.role === "tool" || message.role === "assistant"
        ? (message.toolCallId ?? null)
        : null,
    parts: serializeStoredMessageParts(message.parts),
    position: index,
  }));
  return JSON.stringify(items);
}

/**
 * Parse a stored payload back into Message[]. Malformed JSON throws — the
 * worker catches and routes the task through the retry/backoff path.
 */
export function parseHistoryPayload(payload: string | null): Message[] {
  if (!payload) return [];
  const items = JSON.parse(payload) as HistoryPayloadItem[];
  if (!Array.isArray(items)) {
    throw new Error("session_history payload is not a JSON array");
  }
  return items.map((item) => {
    const parts = parseStoredMessageParts(item.parts);
    const base = {
      id: item.id,
      parts,
      createdAt: item.created_at,
    };
    if (item.role === "tool") {
      if (!item.tool_call_id) {
        throw new Error(`Tool message ${item.id} missing tool_call_id`);
      }
      return { ...base, role: "tool" as const, toolCallId: item.tool_call_id };
    }
    if (item.role === "assistant") {
      return item.tool_call_id
        ? { ...base, role: "assistant" as const, toolCallId: item.tool_call_id }
        : { ...base, role: "assistant" as const };
    }
    if (item.role === "user") {
      return { ...base, role: "user" as const };
    }
    return { ...base, role: "system" as const };
  });
}

/** Insert the pending history row (shared by move + snapshot callers). */
function insertPendingHistoryRow(
  db: SessionDatabase,
  session: Session,
  input: {
    historyId: string;
    stampedAt: number;
    device?: SessionHistoryDevice;
  },
): void {
  const payload = serializeHistoryPayload(session.messages);
  const first =
    session.messages.length > 0 ? session.messages[0]!.createdAt : null;
  const last =
    session.messages.length > 0
      ? session.messages[session.messages.length - 1]!.createdAt
      : null;

  // Snapshot the workspace name inside the caller's transaction — the
  // workspaces row may be renamed/deleted later, the history record must
  // not drift.
  let workspaceName = "";
  if (session.workspaceId) {
    const ws = db
      .prepare(`SELECT name FROM workspaces WHERE id = ?`)
      .get(session.workspaceId) as { name: string } | undefined;
    workspaceName = ws?.name ?? "";
  }

  db.prepare(
    `INSERT INTO session_history (
       id, session_id, title, workspace_id, workspace_name, workspace_path,
       provider_id, model, device_id, device_name, device_os, app_version,
       session_created_at, session_updated_at,
       first_message_at, last_message_at, deleted_at, status, attempts,
       next_attempt_at, payload
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, ?)`,
  ).run(
    input.historyId,
    session.id,
    session.title,
    session.workspaceId ?? "",
    workspaceName,
    session.workspacePath ?? "",
    session.providerId ?? "",
    session.model ?? "",
    input.device?.deviceId ?? "",
    input.device?.deviceName ?? "",
    input.device?.deviceOs ?? "",
    input.device?.appVersion ?? "",
    session.createdAt,
    session.updatedAt,
    first,
    last,
    input.stampedAt,
    payload,
  );
}

/** Drop every history row for one original session id (supersede path). */
function deleteHistoryRowsForSession(
  db: SessionDatabase,
  sessionId: string,
): number {
  const result = db
    .prepare(`DELETE FROM session_history WHERE session_id = ?`)
    .run(sessionId) as { changes: number };
  return result.changes;
}

/**
 * One-transaction archival move: insert the session_history row (pending,
 * full transcript payload + workspace/date/device snapshot), superseding any
 * prior row for the session, and delete the sessions row (messages/subagent
 * rows cascade). Returns true when the session row was removed; false when
 * it no longer exists (whole move rolled back — history and sessions stay
 * consistent).
 */
export function moveSessionToHistory(
  db: SessionDatabase,
  session: Session,
  input: {
    historyId: string;
    deletedAt: number;
    /** Delete-time device snapshot (schema v23); absent ⇒ '' (unknown). */
    device?: SessionHistoryDevice;
  },
): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    deleteHistoryRowsForSession(db, session.id);
    insertPendingHistoryRow(db, session, {
      historyId: input.historyId,
      stampedAt: input.deletedAt,
      ...(input.device ? { device: input.device } : {}),
    });

    const removed = db
      .prepare(`DELETE FROM sessions WHERE id = ?`)
      .run(session.id) as { changes: number };
    if (removed.changes === 0) {
      // Session row vanished concurrently — roll the whole move back so no
      // orphan history row survives without its session having existed.
      db.exec("ROLLBACK");
      return false;
    }

    db.exec("COMMIT");
    return true;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

/**
 * Archive-time snapshot: insert a pending history row for the summarize
 * queue WITHOUT touching the sessions row — the session stays alive in the
 * Archived view. Supersedes any prior row for the session (see invariant
 * above). `stampedAt` is the archive timestamp; it lands in `deleted_at`,
 * which for archive-sourced rows means "entered history", not "deleted".
 */
export function snapshotSessionToHistory(
  db: SessionDatabase,
  session: Session,
  input: {
    historyId: string;
    archivedAt: number;
    /** Archive-time device snapshot (schema v23); absent ⇒ '' (unknown). */
    device?: SessionHistoryDevice;
  },
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    deleteHistoryRowsForSession(db, session.id);
    insertPendingHistoryRow(db, session, {
      historyId: input.historyId,
      stampedAt: input.archivedAt,
      ...(input.device ? { device: input.device } : {}),
    });
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  }
}

/** Latest history row for one original session id, ANY status. */
export function getLatestHistoryBySessionId(
  db: SessionDatabase,
  sessionId: string,
): SessionHistoryRecord | null {
  const row = db
    .prepare(
      `SELECT ${HISTORY_COLUMNS}
       FROM session_history
       WHERE session_id = ?
       ORDER BY deleted_at DESC, id DESC
       LIMIT 1`,
    )
    .get(sessionId) as SessionHistoryRow | undefined;
  return row ? rowToHistoryRecord(row) : null;
}

/**
 * Whether a history row already accounts for the session's entire current
 * transcript: the row froze `session_updated_at` at snapshot/move time, and
 * archiving never bumps `updated_at` (it tracks conversation activity), so
 * `row.sessionUpdatedAt >= session.updatedAt` means nothing was said since.
 * A covering row makes re-snapshotting / re-summarizing (archive again,
 * then delete) a no-op.
 */
export function historyRowCoversSession(
  record: Pick<SessionHistoryRecord, "sessionUpdatedAt">,
  session: Pick<Session, "updatedAt">,
): boolean {
  return record.sessionUpdatedAt >= session.updatedAt;
}

/** Boot recovery: flip interrupted running rows back to pending. */
export function resetRunningHistoryTasks(db: SessionDatabase): number {
  const result = db
    .prepare(`UPDATE session_history SET status = 'pending' WHERE status = 'running'`)
    .run() as { changes: number };
  return result.changes;
}

/** Oldest due pending task (FIFO by deleted_at). */
export function pickNextHistoryTask(
  db: SessionDatabase,
  now: number,
): SessionHistoryRecord | null {
  const row = db
    .prepare(
      `SELECT ${HISTORY_COLUMNS}
       FROM session_history
       WHERE status = 'pending' AND next_attempt_at <= ?
       ORDER BY deleted_at ASC, id ASC
       LIMIT 1`,
    )
    .get(now) as SessionHistoryRow | undefined;
  return row ? rowToHistoryRecord(row) : null;
}

/** Claim a task (pending → running); guards against double-pick. */
export function markHistoryTaskRunning(
  db: SessionDatabase,
  id: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE session_history SET status = 'running', error = NULL
       WHERE id = ? AND status = 'pending'`,
    )
    .run(id) as { changes: number };
  return result.changes > 0;
}

/** Load + parse a task's transcript payload for summarization. */
export function getHistoryTaskPayload(
  db: SessionDatabase,
  id: string,
): Message[] {
  const row = db
    .prepare(`SELECT payload FROM session_history WHERE id = ?`)
    .get(id) as { payload: string | null } | undefined;
  return parseHistoryPayload(row?.payload ?? null);
}

/**
 * Finish a task: store the summary, free the payload, mark done. Only a
 * running row can complete (guards against racing boot-resets).
 */
export function completeHistoryTask(
  db: SessionDatabase,
  id: string,
  input: {
    summary: string;
    summarySource: SessionHistorySummarySource;
    summaryModel: string | null;
    inputTruncated: boolean;
    now: number;
  },
): boolean {
  const result = db
    .prepare(
      `UPDATE session_history
       SET status = 'done', summary = ?, summary_source = ?, summary_model = ?,
           input_truncated = ?, summarized_at = ?, payload = NULL,
           error = NULL, next_attempt_at = 0
       WHERE id = ? AND status = 'running'`,
    )
    .run(
      input.summary,
      input.summarySource,
      input.summaryModel,
      input.inputTruncated ? 1 : 0,
      input.now,
      id,
    ) as { changes: number };
  return result.changes > 0;
}

/**
 * Record a summarize failure: back to pending with attempts/next_attempt_at
 * (patient backoff — never terminally failed) and the error text for
 * debugging. Only a running row can fail (same double-pick guard).
 */
export function failHistoryTask(
  db: SessionDatabase,
  id: string,
  input: { attempts: number; nextAttemptAt: number; error: string },
): boolean {
  const result = db
    .prepare(
      `UPDATE session_history
       SET status = 'pending', attempts = ?, next_attempt_at = ?, error = ?
       WHERE id = ? AND status = 'running'`,
    )
    .run(input.attempts, input.nextAttemptAt, input.error, id) as {
    changes: number;
  };
  return result.changes > 0;
}

/** Pending + running count (queue depth for tests / diagnostics). */
export function countOutstandingHistoryTasks(db: SessionDatabase): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM session_history
       WHERE status IN ('pending', 'running')`,
    )
    .get() as { n: number };
  return row.n;
}

/** Earliest next_attempt_at among pending rows (worker wake scheduling). */
export function earliestHistoryAttemptAt(db: SessionDatabase): number | null {
  const row = db
    .prepare(
      `SELECT MIN(next_attempt_at) AS t FROM session_history
       WHERE status = 'pending'`,
    )
    .get() as { t: number | null };
  return row.t;
}

/**
 * Force every pending row due now (next_attempt_at = 0). Used by boot and
 * provider-settings changes: a possibly-fixed provider should be probed
 * immediately instead of waiting out the remaining backoff.
 */
export function forceDueAllHistoryTasks(db: SessionDatabase): number {
  const result = db
    .prepare(
      `UPDATE session_history SET next_attempt_at = 0 WHERE status = 'pending'`,
    )
    .run() as { changes: number };
  return result.changes;
}

/** All summarized rows (search source), newest activity first. */
export function loadSummarizedHistory(
  db: SessionDatabase,
): SessionHistoryRecord[] {
  const rows = db
    .prepare(
      `SELECT ${HISTORY_COLUMNS}
       FROM session_history
       WHERE status = 'done'
       ORDER BY session_updated_at DESC`,
    )
    .all() as SessionHistoryRow[];
  return rows.map(rowToHistoryRecord);
}

/** One history record by original session id (mode=read for the search tool). */
export function getHistoryBySessionId(
  db: SessionDatabase,
  sessionId: string,
): SessionHistoryRecord | null {
  const row = db
    .prepare(
      `SELECT ${HISTORY_COLUMNS}
       FROM session_history
       WHERE session_id = ? AND status = 'done'
       ORDER BY deleted_at DESC
       LIMIT 1`,
    )
    .get(sessionId) as SessionHistoryRow | undefined;
  return row ? rowToHistoryRecord(row) : null;
}

// ── memory sync (schema v24) ────────────────────────────────────

/** Done rows not yet pushed to a relay (oldest activity first). */
export function loadUnpushedHistory(
  db: SessionDatabase,
  limit: number,
): SessionHistoryRecord[] {
  const rows = db
    .prepare(
      `SELECT ${HISTORY_COLUMNS}
       FROM session_history
       WHERE status = 'done' AND pushed_at = 0
       ORDER BY session_updated_at ASC
       LIMIT ?`,
    )
    .all(limit) as SessionHistoryRow[];
  return rows.map(rowToHistoryRecord);
}

/** Stamp rows as pushed (server "noop" counts — content already there). */
export function markHistoryPushed(
  db: SessionDatabase,
  sessionIds: string[],
  now: number,
): void {
  if (sessionIds.length === 0) return;
  const stmt = db.prepare(
    `UPDATE session_history SET pushed_at = ? WHERE session_id = ?`,
  );
  for (const sessionId of sessionIds) stmt.run(now, sessionId);
}

/**
 * Idempotent merge of one remote archive row (relay pull). Mirrors the
 * server-side arbitration: an incoming row replaces the local one only
 * when strictly more informative (done+summary beats missing; newer
 * summarizedAt wins otherwise). Rows inserted here carry pushed_at=now so
 * they never echo back in the next push cycle. Returns the merge outcome.
 */
export function upsertHistoryFromRemote(
  db: SessionDatabase,
  incoming: {
    sessionId: string;
    title: string;
    workspaceName: string;
    workspacePath: string;
    providerId: string;
    model: string;
    deviceId: string;
    deviceName: string;
    deviceOs: string;
    appVersion: string;
    sessionCreatedAt: number;
    sessionUpdatedAt: number;
    firstMessageAt: number | null;
    lastMessageAt: number | null;
    deletedAt: number;
    summary: string | null;
    summarySource: string | null;
    summaryModel: string | null;
    inputTruncated: boolean;
    summarizedAt: number | null;
  },
  input: { newId: string; now: number },
): "inserted" | "updated" | "skipped" {
  const existing = getHistoryBySessionId(db, incoming.sessionId);
  if (!existing) {
    db.prepare(
      `INSERT INTO session_history (
         id, session_id, title, workspace_id, workspace_name, workspace_path,
         provider_id, model, device_id, device_name, device_os, app_version,
         session_created_at, session_updated_at,
         first_message_at, last_message_at, deleted_at, status, attempts,
         next_attempt_at, summary, summary_source, input_truncated,
         summary_model, summarized_at, pushed_at
       ) VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', 0, 0, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.newId,
      incoming.sessionId,
      incoming.title,
      incoming.workspaceName,
      incoming.workspacePath,
      incoming.providerId,
      incoming.model,
      incoming.deviceId,
      incoming.deviceName,
      incoming.deviceOs,
      incoming.appVersion,
      incoming.sessionCreatedAt,
      incoming.sessionUpdatedAt,
      incoming.firstMessageAt,
      incoming.lastMessageAt,
      incoming.deletedAt,
      incoming.summary,
      incoming.summarySource,
      incoming.inputTruncated ? 1 : 0,
      incoming.summaryModel,
      incoming.summarizedAt,
      input.now,
    );
    return "inserted";
  }
  const existingDone = existing.summary != null && existing.summarySource != null;
  const incomingDone = incoming.summary != null && incoming.summarySource != null;
  const incomingBetter =
    (!existingDone && incomingDone) ||
    (incomingDone && existingDone && (incoming.summarizedAt ?? 0) > (existing.summarizedAt ?? 0));
  if (!incomingBetter) return "skipped";
  db.prepare(
    `UPDATE session_history
     SET title = ?, summary = ?, summary_source = ?, summary_model = ?,
         input_truncated = ?, summarized_at = ?, pushed_at = ?
     WHERE session_id = ? AND status = 'done'`,
  ).run(
    incoming.title,
    incoming.summary,
    incoming.summarySource,
    incoming.summaryModel,
    incoming.inputTruncated ? 1 : 0,
    incoming.summarizedAt,
    input.now,
    incoming.sessionId,
  );
  return "updated";
}

/** Full-resync prep: re-push every done row on the next cycle. */
export function resetAllHistoryPushed(db: SessionDatabase): number {
  const result = db
    .prepare(`UPDATE session_history SET pushed_at = 0 WHERE status = 'done'`)
    .run() as { changes: number };
  return result.changes;
}

/** Read one memory_sync_state value (null when absent). */
export function getMemorySyncState(
  db: SessionDatabase,
  key: string,
): string | null {
  const row = db
    .prepare(`SELECT value FROM memory_sync_state WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/** Upsert one memory_sync_state value. */
export function setMemorySyncState(
  db: SessionDatabase,
  key: string,
  value: string,
): void {
  db.prepare(
    `INSERT INTO memory_sync_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
