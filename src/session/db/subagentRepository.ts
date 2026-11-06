import type { SessionDatabase } from "./openDb.js";
import type {
  Message,
  MessageRole,
} from "../types.js";
import type {
  SubagentDetailSnapshot,
  SubagentRole,
  SubagentRunStatus,
  SubagentRunSummary,
  SubagentTranscript,
  SubagentTranscriptMessage,
} from "../../agent/subagents/types.js";
import { buildSubagentTranscript } from "../../agent/subagents/summary.js";
import {
  parseStoredMessageParts,
  serializeStoredMessageParts,
} from "./sanitizeMessageParts.js";

export type SubagentRunRecord = {
  id: string;
  parentSessionId: string;
  parentToolCallId: string;
  batchId: string;
  name: string;
  prompt: string;
  role: SubagentRole;
  priority: number;
  status: SubagentRunStatus;
  progressText: string;
  resultSummary?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
};

type SubagentRunRow = {
  id: string;
  parent_session_id: string;
  parent_tool_call_id: string;
  batch_id: string;
  name: string;
  prompt: string;
  role: string;
  priority: number;
  status: string;
  progress_text: string;
  result_summary: string | null;
  error_message: string | null;
  created_at: number;
  updated_at: number;
};

type SubagentMessageRow = {
  id: string;
  run_id: string;
  role: string;
  created_at: number;
  tool_call_id: string | null;
  parts: string;
  position: number;
};

function rowToMessage(row: SubagentMessageRow): Message {
  const parts = parseStoredMessageParts(row.parts);
  const role = row.role as MessageRole;
  const base = {
    id: row.id,
    parts,
    createdAt: row.created_at,
  };

  if (role === "tool") {
    if (!row.tool_call_id) {
      throw new Error(`Subagent tool message ${row.id} missing tool_call_id`);
    }
    return { ...base, role: "tool", toolCallId: row.tool_call_id };
  }
  if (role === "assistant") {
    return {
      ...base,
      role: "assistant",
      ...(row.tool_call_id ? { toolCallId: row.tool_call_id } : {}),
    };
  }
  if (role === "user" || role === "system") {
    return { ...base, role };
  }
  throw new Error(`Unknown subagent message role: ${row.role}`);
}

function rowToRun(row: SubagentRunRow): SubagentRunRecord {
  return {
    id: row.id,
    parentSessionId: row.parent_session_id,
    parentToolCallId: row.parent_tool_call_id,
    batchId: row.batch_id,
    name: row.name,
    prompt: row.prompt,
    role: row.role as SubagentRole,
    priority: row.priority,
    status: row.status as SubagentRunStatus,
    progressText: row.progress_text,
    ...(row.result_summary ? { resultSummary: row.result_summary } : {}),
    ...(row.error_message ? { errorMessage: row.error_message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Upsert subagent run metadata (does not touch messages). */
export function upsertSubagentRun(
  db: SessionDatabase,
  run: SubagentRunRecord,
): void {
  db.prepare(
    `INSERT INTO subagent_runs (
       id, parent_session_id, parent_tool_call_id, batch_id,
       name, prompt, role, priority, status, progress_text,
       result_summary, error_message, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       parent_session_id = excluded.parent_session_id,
       parent_tool_call_id = excluded.parent_tool_call_id,
       batch_id = excluded.batch_id,
       name = excluded.name,
       prompt = excluded.prompt,
       role = excluded.role,
       priority = excluded.priority,
       status = excluded.status,
       progress_text = excluded.progress_text,
       result_summary = excluded.result_summary,
       error_message = excluded.error_message,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
  ).run(
    run.id,
    run.parentSessionId,
    run.parentToolCallId,
    run.batchId,
    run.name,
    run.prompt,
    run.role,
    run.priority,
    run.status,
    run.progressText,
    run.resultSummary ?? null,
    run.errorMessage ?? null,
    run.createdAt,
    run.updatedAt,
  );
}

/** Replace all messages for a subagent run (transactional). */
export function replaceSubagentMessages(
  db: SessionDatabase,
  runId: string,
  messages: Message[],
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM subagent_messages WHERE run_id = ?").run(runId);
    const insert = db.prepare(
      `INSERT INTO subagent_messages (
         id, run_id, role, created_at, tool_call_id, parts, position
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    messages.forEach((message, position) => {
      const toolCallId =
        message.role === "tool"
          ? message.toolCallId
          : message.role === "assistant" && message.toolCallId
            ? message.toolCallId
            : null;
      insert.run(
        message.id,
        runId,
        message.role,
        message.createdAt,
        toolCallId,
        serializeStoredMessageParts(message.parts),
        position,
      );
    });
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore
    }
    throw err;
  }
}

export function getSubagentRun(
  db: SessionDatabase,
  runId: string,
): SubagentRunRecord | null {
  const row = db
    .prepare(`SELECT * FROM subagent_runs WHERE id = ?`)
    .get(runId) as SubagentRunRow | undefined;
  return row ? rowToRun(row) : null;
}

export function loadSubagentMessages(
  db: SessionDatabase,
  runId: string,
): Message[] {
  const rows = db
    .prepare(
      `SELECT * FROM subagent_messages WHERE run_id = ? ORDER BY position ASC`,
    )
    .all(runId) as SubagentMessageRow[];
  return rows.map((row) => rowToMessage(row));
}

export function listSubagentRunsForSession(
  db: SessionDatabase,
  parentSessionId: string,
): SubagentRunRecord[] {
  const rows = db
    .prepare(
      `SELECT * FROM subagent_runs WHERE parent_session_id = ? ORDER BY created_at ASC`,
    )
    .all(parentSessionId) as SubagentRunRow[];
  return rows.map((row) => rowToRun(row));
}

/** Subagents-window list item shape from a DB run row. */
export function runRecordToSummary(run: SubagentRunRecord): SubagentRunSummary {
  return {
    id: run.id,
    batchId: run.batchId,
    name: run.name,
    role: run.role,
    priority: run.priority,
    status: run.status,
    progressText: run.progressText,
    parentToolCallId: run.parentToolCallId,
    ...(run.resultSummary ? { summary: run.resultSummary } : {}),
    ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

/** Full-fidelity transcript from DB (manager gone — post-restart history). */
export function loadSubagentTranscriptFromDb(
  db: SessionDatabase,
  parentSessionId: string,
  runId: string,
): SubagentTranscript | null {
  const run = getSubagentRun(db, runId);
  if (!run || run.parentSessionId !== parentSessionId) return null;
  return {
    run: runRecordToSummary(run),
    messages: loadSubagentMessages(db, runId),
  };
}

/** Detail snapshot from DB (projected transcript text, same as live getDetail). */
export function loadSubagentDetailFromDb(
  db: SessionDatabase,
  parentSessionId: string,
  runId: string,
): SubagentDetailSnapshot | null {
  const run = getSubagentRun(db, runId);
  if (!run || run.parentSessionId !== parentSessionId) return null;
  const messages = loadSubagentMessages(db, runId);
  const projected: SubagentTranscriptMessage[] = buildSubagentTranscript({
    id: run.id,
    type: "agent",
    title: run.name,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    status: "idle",
    progressText: "",
    messages,
    model: "",
    providerId: "",
    workspaceId: "",
    workspacePath: "",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
  });
  return {
    id: run.id,
    batchId: run.batchId,
    name: run.name,
    role: run.role,
    priority: run.priority,
    status: run.status,
    progressText: run.progressText,
    parentToolCallId: run.parentToolCallId,
    ...(run.resultSummary ? { summary: run.resultSummary } : {}),
    ...(run.errorMessage ? { errorMessage: run.errorMessage } : {}),
    prompt: run.prompt,
    messages: projected,
  };
}
