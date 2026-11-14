import { randomUUID } from "node:crypto";
import { isMcpToolName, MCP_TOOL_PREFIX } from "../mcp/toolNames.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import type { SessionDatabase } from "../session/db/openDb.js";
import type {
  ToolInvocationRecord,
  ToolInvocationStatus,
} from "../session/db/toolInvocationRepository.js";
import { parseStoredMessageParts } from "../session/db/sanitizeMessageParts.js";
import type { MessagePart, ToolCallPart } from "../session/types.js";
import type {
  ToolInvocationReason,
  ToolInvocationScene,
} from "./types.js";

const SCENE_ARGS_MAX = 32_000;
const SCENE_RESULT_MAX = 32_000;
const SCENE_RAW_MAX = 32_000;
const META_KEY = "tool_stats_backfill_v1";

export type ToolStatsBackfillResult = {
  scannedCalls: number;
  inserted: number;
  skippedExisting: number;
  skippedIncomplete: number;
};

type MessageScanRow = {
  role: string;
  created_at: number;
  tool_call_id: string | null;
  parts: string;
};

type ToolCallHit = {
  call: ToolCallPart;
  startedAt: number;
};

type ToolResultHit = {
  returnCode: number;
  resultText: string;
  finishedAt: number;
};

/**
 * One-shot (idempotent) backfill of tool_invocations from persisted transcripts.
 * Skips tool_call_ids already present. Safe to call on every startup until marked done;
 * after success, schema_meta records completion so subsequent boots no-op quickly.
 */
export function backfillToolInvocationsFromHistory(
  db: SessionDatabase,
): ToolStatsBackfillResult {
  if (isBackfillDone(db)) {
    return {
      scannedCalls: 0,
      inserted: 0,
      skippedExisting: 0,
      skippedIncomplete: 0,
    };
  }

  const existing = loadExistingToolCallIds(db);
  const result: ToolStatsBackfillResult = {
    scannedCalls: 0,
    inserted: 0,
    skippedExisting: 0,
    skippedIncomplete: 0,
  };

  const insertMany = db.prepare(
    `INSERT INTO tool_invocations (
      id, session_id, parent_session_id, subagent_id, tool_call_id,
      name, is_mcp, mcp_server_id, status, reason, return_code,
      started_at, duration_ms, doc_revision, scene_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec("BEGIN IMMEDIATE");
  try {
    const sessionIds = db
      .prepare(`SELECT id FROM sessions`)
      .all() as Array<{ id: string }>;
    for (const { id: sessionId } of sessionIds) {
      const rows = db
        .prepare(
          `SELECT role, created_at, tool_call_id, parts
           FROM messages
           WHERE session_id = ?
           ORDER BY position ASC`,
        )
        .all(sessionId) as MessageScanRow[];
      collectAndInsert(rows, {
        sessionId,
        existing,
        result,
        insertMany,
      });
    }

    const runs = db
      .prepare(`SELECT id, parent_session_id FROM subagent_runs`)
      .all() as Array<{ id: string; parent_session_id: string }>;
    for (const run of runs) {
      const rows = db
        .prepare(
          `SELECT role, created_at, tool_call_id, parts
           FROM subagent_messages
           WHERE run_id = ?
           ORDER BY position ASC`,
        )
        .all(run.id) as MessageScanRow[];
      collectAndInsert(rows, {
        sessionId: run.id,
        parentSessionId: run.parent_session_id,
        subagentId: run.id,
        existing,
        result,
        insertMany,
      });
    }

    db.prepare(
      `INSERT INTO schema_meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(META_KEY, String(Date.now()));

    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ignore rollback errors
    }
    throw err;
  }

  return result;
}

function isBackfillDone(db: SessionDatabase): boolean {
  const row = db
    .prepare(`SELECT value FROM schema_meta WHERE key = ?`)
    .get(META_KEY) as { value: string } | undefined;
  return Boolean(row?.value);
}

function loadExistingToolCallIds(db: SessionDatabase): Set<string> {
  const rows = db
    .prepare(`SELECT tool_call_id FROM tool_invocations`)
    .all() as Array<{ tool_call_id: string }>;
  return new Set(rows.map((r) => r.tool_call_id));
}

function collectAndInsert(
  rows: MessageScanRow[],
  ctx: {
    sessionId: string;
    parentSessionId?: string;
    subagentId?: string;
    existing: Set<string>;
    result: ToolStatsBackfillResult;
    insertMany: ReturnType<SessionDatabase["prepare"]>;
  },
): void {
  const calls = new Map<string, ToolCallHit>();
  const results = new Map<string, ToolResultHit>();

  for (const row of rows) {
    let parts: MessagePart[];
    try {
      parts = parseStoredMessageParts(row.parts);
    } catch {
      continue;
    }

    if (row.role === "assistant") {
      for (const part of parts) {
        if (part.type !== "tool_call" || typeof part.id !== "string") continue;
        if (!part.name) continue;
        calls.set(part.id, {
          call: part,
          startedAt: row.created_at,
        });
      }
    }

    if (row.role === "tool") {
      for (const part of parts) {
        if (part.type !== "tool_result") continue;
        const toolCallId =
          typeof part.toolCallId === "string" && part.toolCallId
            ? part.toolCallId
            : row.tool_call_id;
        if (!toolCallId) continue;
        results.set(toolCallId, {
          returnCode:
            typeof part.returnCode === "number" ? part.returnCode : 1,
          resultText: textFromResultContent(part.content),
          finishedAt: row.created_at,
        });
      }
    }
  }

  for (const [toolCallId, hit] of calls) {
    ctx.result.scannedCalls += 1;
    if (ctx.existing.has(toolCallId)) {
      ctx.result.skippedExisting += 1;
      continue;
    }
    const result = results.get(toolCallId);
    if (!result) {
      // No persisted result — skip incomplete/aborted mid-stream calls.
      ctx.result.skippedIncomplete += 1;
      continue;
    }

    const record = buildRecordFromTranscript({
      sessionId: ctx.sessionId,
      ...(ctx.parentSessionId
        ? { parentSessionId: ctx.parentSessionId }
        : {}),
      ...(ctx.subagentId ? { subagentId: ctx.subagentId } : {}),
      toolCallId,
      call: hit.call,
      startedAt: hit.startedAt,
      result,
    });

    ctx.insertMany.run(
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
      record.docRevision,
      record.sceneJson ?? null,
      record.createdAt,
    );
    ctx.existing.add(toolCallId);
    ctx.result.inserted += 1;
  }
}

function buildRecordFromTranscript(input: {
  sessionId: string;
  parentSessionId?: string;
  subagentId?: string;
  toolCallId: string;
  call: ToolCallPart;
  startedAt: number;
  result: ToolResultHit;
}): ToolInvocationRecord {
  const outcome = mapReturnCode(input.result.returnCode);
  const durationMs = Math.max(
    0,
    input.result.finishedAt - input.startedAt,
  );
  const mcpServerId = mcpServerIdFromToolName(input.call.name);
  const scene =
    outcome.status === "success"
      ? undefined
      : buildScene({
          arguments: input.call.arguments,
          argumentsRaw: input.call.argumentsRaw,
          resultText: input.result.resultText,
          ...(input.result.resultText
            ? { errorMessage: input.result.resultText }
            : {}),
        });

  return {
    id: randomUUID(),
    sessionId: input.sessionId,
    ...(input.parentSessionId
      ? { parentSessionId: input.parentSessionId }
      : {}),
    ...(input.subagentId ? { subagentId: input.subagentId } : {}),
    toolCallId: input.toolCallId,
    name: input.call.name,
    isMcp: isMcpToolName(input.call.name),
    ...(mcpServerId ? { mcpServerId } : {}),
    status: outcome.status,
    reason: outcome.reason,
    returnCode: input.result.returnCode,
    startedAt: input.startedAt,
    durationMs,
    // Historical transcript rows predate doc revisions → baseline 0.
    docRevision: 0,
    ...(scene !== undefined ? { sceneJson: scene } : {}),
    createdAt: Date.now(),
  };
}

function mapReturnCode(returnCode: number): {
  status: ToolInvocationStatus;
  reason: ToolInvocationReason;
} {
  if (returnCode === ToolReturnCode.Success) {
    return { status: "success", reason: "ok" };
  }
  if (returnCode === ToolReturnCode.PermissionDenied) {
    return { status: "denied", reason: "full_permissions_required" };
  }
  if (returnCode === ToolReturnCode.InvalidArguments) {
    return { status: "invalid", reason: "invalid_arguments_schema" };
  }
  if (returnCode === ToolReturnCode.Cancelled) {
    return { status: "cancelled", reason: "handler" };
  }
  return { status: "tool_error", reason: "handler" };
}

function textFromResultContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (
      part &&
      typeof part === "object" &&
      (part as { type?: string }).type === "text" &&
      typeof (part as { text?: unknown }).text === "string"
    ) {
      texts.push((part as { text: string }).text);
    }
  }
  return texts.join("\n");
}

function mcpServerIdFromToolName(name: string): string | undefined {
  if (!isMcpToolName(name)) return undefined;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const idx = rest.indexOf("__");
  if (idx <= 0) return undefined;
  return rest.slice(0, idx);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…(+${value.length - max} chars)`;
}

function buildScene(scene: ToolInvocationScene): string {
  const out: Record<string, unknown> = {};
  if (scene.arguments !== undefined) {
    try {
      const raw = JSON.stringify(scene.arguments);
      out.arguments =
        raw.length <= SCENE_ARGS_MAX
          ? scene.arguments
          : {
              _truncated: true,
              preview: truncate(raw, SCENE_ARGS_MAX),
            };
    } catch {
      out.arguments = { _error: "unserializable_arguments" };
    }
  }
  if (typeof scene.argumentsRaw === "string") {
    out.argumentsRaw = truncate(scene.argumentsRaw, SCENE_RAW_MAX);
  }
  if (typeof scene.resultText === "string") {
    out.resultText = truncate(scene.resultText, SCENE_RESULT_MAX);
  }
  if (typeof scene.errorMessage === "string") {
    out.errorMessage = truncate(scene.errorMessage, 4_000);
  }
  try {
    return JSON.stringify(out);
  } catch {
    return JSON.stringify({
      errorMessage: "Failed to serialize backfill scene.",
    });
  }
}
