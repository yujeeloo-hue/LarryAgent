import type { SessionDatabase } from "./openDb.js";
import {
  clampTailTurns,
  type SessionMessageWindow,
} from "../messageWindow.js";
import { parseStoredMessageParts } from "./sanitizeMessageParts.js";
import type { Message, MessagePart } from "../types.js";
import {
  RETRY_CONTINUATION_PART_ID,
  STEER_CONTINUATION_PART_ID,
} from "../types.js";
import { isContextClearPart, isContextNewTaskPart } from "./windowBoundaries.js";

type PositionRow = { position: number };

type PartsRow = { position: number; parts: string };

function parseParts(raw: string): MessagePart[] {
  try {
    return parseStoredMessageParts(raw);
  } catch {
    return [];
  }
}

function findLastClearPosition(
  db: SessionDatabase,
  sessionId: string,
): number {
  const rows = db
    .prepare(
      `SELECT position, parts FROM messages
       WHERE session_id = ? AND role = 'system'
       ORDER BY position ASC`,
    )
    .all(sessionId) as PartsRow[];
  let clear = -1;
  for (const row of rows) {
    if (parseParts(row.parts).some((part) => isContextClearPart(part))) {
      clear = row.position;
    }
  }
  return clear;
}

function turnStartPositions(
  db: SessionDatabase,
  sessionId: string,
  clearPosition: number,
): number[] {  const rows = db
    .prepare(
      `SELECT position, parts FROM messages
       WHERE session_id = ? AND role = 'user'
       ORDER BY position ASC`,
    )
    .all(sessionId) as PartsRow[];
  const starts: number[] = [];
  for (const row of rows) {
    if (row.position <= clearPosition) continue;
    const continuation = parseParts(row.parts).some(
      (part) =>
        part.type === "text" &&
        (part.id === STEER_CONTINUATION_PART_ID ||
          part.id === RETRY_CONTINUATION_PART_ID),
    );
    if (!continuation) starts.push(row.position);
  }
  return starts;
}

function loadRange(
  db: SessionDatabase,
  sessionId: string,
  minPosition: number | null,
  maxPositionExclusive: number | null,
): Message[] {
  const sql = `SELECT id, session_id, role, created_at, tool_call_id, parts, position
     FROM messages
     WHERE session_id = ?
       ${minPosition !== null ? "AND position >= ?" : ""}
       ${maxPositionExclusive !== null ? "AND position < ?" : ""}
     ORDER BY position ASC`;
  const params: Array<string | number> = [sessionId];
  if (minPosition !== null) params.push(minPosition);
  if (maxPositionExclusive !== null) params.push(maxPositionExclusive);
  const rows = db.prepare(sql).all(...params) as Array<{
    id: string;
    session_id: string;
    role: string;
    created_at: number;
    tool_call_id: string | null;
    parts: string;
    position: number;
  }>;
  return rows.map((row) => {
    const parts = parseParts(row.parts);
    const base = { id: row.id, parts, createdAt: row.created_at };
    if (row.role === "tool" && row.tool_call_id) {
      return { ...base, role: "tool" as const, toolCallId: row.tool_call_id };
    }
    if (row.role === "assistant" && row.tool_call_id) {
      return {
        ...base,
        role: "assistant" as const,
        toolCallId: row.tool_call_id,
      };
    }
    return { ...base, role: row.role as "user" | "assistant" | "system" };
  });
}

function windowInfo(
  messages: Message[],
  hasMore: boolean,
  remainingTurns: number,
): SessionMessageWindow {
  return {
    messages,
    firstMessageId: messages[0]?.id ?? null,
    hasMore,
    remainingTurns,
  };
}

function includeLeadingNewTaskPosition(
  db: SessionDatabase,
  sessionId: string,
  position: number | null,
): number | null {
  let start = position;
  while (start !== null && start > 0) {
    const row = db
      .prepare(
        `SELECT role, parts FROM messages
         WHERE session_id = ? AND position = ?`,
      )
      .get(sessionId, start - 1) as
      | { role: string; parts: string }
      | undefined;
    if (!row || row.role !== "system") break;
    if (!parseParts(row.parts).some((part) => isContextNewTaskPart(part))) break;
    start -= 1;
  }
  return start;
}

export function loadSessionTailWindowFromDb(
  db: SessionDatabase,
  sessionId: string,
  turns: number | undefined,
): SessionMessageWindow {
  const count = clampTailTurns(turns);
  const clearPosition = findLastClearPosition(db, sessionId);
  const starts = turnStartPositions(db, sessionId, clearPosition);

  let minPosition: number | null;
  let hasMore: boolean;
  let remainingTurns: number;
  if (starts.length > count) {
    minPosition = starts[starts.length - count]!;
    hasMore = true;
    remainingTurns = starts.length - count;
  } else {
    minPosition = clearPosition >= 0 ? clearPosition : null;
    hasMore = false;
    remainingTurns = 0;
  }
  return windowInfo(
    loadRange(
      db,
      sessionId,
      includeLeadingNewTaskPosition(db, sessionId, minPosition),
      null,
    ),
    hasMore,
    remainingTurns,
  );
}

export function loadMessagesBeforeFromDb(
  db: SessionDatabase,
  sessionId: string,
  beforeMessageId: string,
  turns: number | undefined,
): SessionMessageWindow | null {
  const cursor = db
    .prepare(
      `SELECT position FROM messages WHERE session_id = ? AND id = ?`,
    )
    .get(sessionId, beforeMessageId) as PositionRow | undefined;
  if (!cursor) return null;

  const count = clampTailTurns(turns);
  const clearPosition = findLastClearPosition(db, sessionId);
  if (cursor.position === 0 || cursor.position === clearPosition) {
    return windowInfo([], false, 0);
  }

  const starts = turnStartPositions(
    db,
    sessionId,
    clearPosition,
  ).filter((position) => position < cursor.position);

  let minPosition: number | null;
  let hasMore: boolean;
  let remainingTurns: number;
  if (starts.length > count) {
    minPosition = starts[starts.length - count]!;
    hasMore = true;
    remainingTurns = starts.length - count;
  } else {
    minPosition = clearPosition >= 0 ? clearPosition : null;
    hasMore = false;
    remainingTurns = 0;
  }
  return windowInfo(
    loadRange(
      db,
      sessionId,
      includeLeadingNewTaskPosition(db, sessionId, minPosition),
      cursor.position,
    ),
    hasMore,
    remainingTurns,
  );
}
