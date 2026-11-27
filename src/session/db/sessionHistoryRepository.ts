import type { SessionDatabase } from "./openDb.js";
import type { Message, Session } from "../types.js";
import {
  parseStoredMessageParts,
  serializeStoredMessageParts,
} from "./sanitizeMessageParts.js";


export type SessionHistoryStatus = "pending" | "running" | "done";

export type SessionHistorySummarySource = "llm" | "empty" | "discarded";

export type SessionHistoryDevice = {
  deviceId: string;
  deviceName: string;
  deviceOs: string;
  appVersion: string;
};

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

function deleteHistoryRowsForSession(
  db: SessionDatabase,
  sessionId: string,
): number {
  const result = db
    .prepare(`DELETE FROM session_history WHERE session_id = ?`)
    .run(sessionId) as { changes: number };
  return result.changes;
}

export function moveSessionToHistory(
  db: SessionDatabase,
  session: Session,
  input: {
    historyId: string;
    deletedAt: number;
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
      db.exec("ROLLBACK");
      return false;
    }

    db.exec("COMMIT");
    return true;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
    }
    throw err;
  }
}

export function snapshotSessionToHistory(
  db: SessionDatabase,
  session: Session,
  input: {
    historyId: string;
    archivedAt: number;
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
    }
    throw err;
  }
}

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

export function historyRowCoversSession(
  record: Pick<SessionHistoryRecord, "sessionUpdatedAt">,
  session: Pick<Session, "updatedAt">,
): boolean {
  return record.sessionUpdatedAt >= session.updatedAt;
}

export function resetRunningHistoryTasks(db: SessionDatabase): number {
  const result = db
    .prepare(`UPDATE session_history SET status = 'pending' WHERE status = 'running'`)
    .run() as { changes: number };
  return result.changes;
}

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

export function getHistoryTaskPayload(
  db: SessionDatabase,
  id: string,
): Message[] {
  const row = db
    .prepare(`SELECT payload FROM session_history WHERE id = ?`)
    .get(id) as { payload: string | null } | undefined;
  return parseHistoryPayload(row?.payload ?? null);
}

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

export function countOutstandingHistoryTasks(db: SessionDatabase): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM session_history
       WHERE status IN ('pending', 'running')`,
    )
    .get() as { n: number };
  return row.n;
}

export function earliestHistoryAttemptAt(db: SessionDatabase): number | null {
  const row = db
    .prepare(
      `SELECT MIN(next_attempt_at) AS t FROM session_history
       WHERE status = 'pending'`,
    )
    .get() as { t: number | null };
  return row.t;
}

export function forceDueAllHistoryTasks(db: SessionDatabase): number {
  const result = db
    .prepare(
      `UPDATE session_history SET next_attempt_at = 0 WHERE status = 'pending'`,
    )
    .run() as { changes: number };
  return result.changes;
}

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

export function resetAllHistoryPushed(db: SessionDatabase): number {
  const result = db
    .prepare(`UPDATE session_history SET pushed_at = 0 WHERE status = 'done'`)
    .run() as { changes: number };
  return result.changes;
}

export function getMemorySyncState(
  db: SessionDatabase,
  key: string,
): string | null {
  const row = db
    .prepare(`SELECT value FROM memory_sync_state WHERE key = ?`)
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

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
