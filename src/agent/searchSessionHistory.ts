import type { Message, Session } from "../session/types.js";
import type { SessionHistoryRecord } from "../session/db/sessionHistoryRepository.js";

export type SessionHistoryHit = {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  /** Display label: workspace name when known, else raw id. */
  workspaceName: string;
  messageId: string;
  role: string;
  createdAt: number;
  snippet: string;
  matchKind: "title" | "message" | "history_summary";
  /** Present on history_summary hits: archive-row metadata for the readout. */
  archived?: {
    deletedAt: number;
    firstMessageAt: number | null;
    lastMessageAt: number | null;
    inputTruncated: boolean;
    summarySource: string;
  };
};

/**
 * Resolve workspace ids allowed in the search pool.
 * Empty / undefined = all workspaces (cross-workspace scope).
 */
export type WorkspaceNameMap = Map<string, string>;

export type SessionHistorySearchInput = {
  sessions: Session[];
  currentSessionId: string;
  /** Scope to one workspace id; empty / undefined = all workspaces. */
  workspaceId?: string | undefined;
  /** workspaceId → display name (used to label cross-workspace hits). */
  workspaceNames?: WorkspaceNameMap;
  /** Multi-keyword AND (split on whitespace/commas). Empty = no keyword filter. */
  query?: string;
  /** Narrow to one session id, or `"current"` for the calling session. */
  sessionId?: string;
  /** Inclusive lower bound (epoch ms). */
  afterMs?: number;
  /** Inclusive upper bound (epoch ms). */
  beforeMs?: number;
  /** Max hits. Default 12, hard max 20. */
  limit?: number;
};

export type SessionHistoryReadInput = {
  sessions: Session[];
  currentSessionId: string;
  /** Scope to one workspace id; empty / undefined = all workspaces. */
  workspaceId?: string | undefined;
  /** workspaceId → display name (used to label the header line). */
  workspaceNames?: WorkspaceNameMap;
  sessionId?: string;
  /** Center message id; omit to read newest messages. */
  aroundMessageId?: string;
  /** Messages before center (or from end when no center). Default 3, max 8. */
  beforeCount?: number;
  /** Messages after center. Default 3, max 8. */
  afterCount?: number;
  /** When no aroundMessageId: how many newest messages. Default 12, max 20. */
  limit?: number;
};

/** Snippet window around a keyword match. */
const PREVIEW_RADIUS = 60;
const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 20;
/** Max messages before/after an around_message_id center. */
const MAX_AROUND = 8;
const DEFAULT_AROUND = 3;
/** Per-message / per-hit text shown to the model. */
export const MAX_SNIPPET_CHARS = 200;
/** Hard cap on the entire tool result body (keeps context safe). */
export const MAX_RESULT_CHARS = 16_000;
/** Truncate tool_call argumentsRaw when indexing / previewing. */
const MAX_TOOL_ARG_CHARS = 120;

function clampLimit(raw: number | undefined, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
}

function clampAround(raw: number | undefined, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return fallback;
  return Math.max(0, Math.min(MAX_AROUND, Math.floor(raw)));
}

function clipChars(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function splitSearchKeywords(raw: string): string[] {
  return raw
    .split(/[\s,]+/u)
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0);
}

function collectSearchableTexts(message: Message): string[] {
  const texts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim()) {
      texts.push(part.text);
      continue;
    }
    if (part.type === "tool_result") {
      for (const child of part.content) {
        if (child.type === "text" && child.text.trim()) {
          texts.push(clipChars(child.text, MAX_SNIPPET_CHARS * 2));
        }
      }
      continue;
    }
    if (part.type === "tool_call") {
      if (part.name.trim()) texts.push(`[tool ${part.name}]`);
      if (part.argumentsRaw.trim()) {
        texts.push(clipChars(part.argumentsRaw, MAX_TOOL_ARG_CHARS));
      }
    }
  }
  return texts;
}

/** Prefer plain text parts for display; fall back to clipped searchable texts. */
function messagePlainPreview(message: Message): string {
  const textParts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim()) {
      textParts.push(part.text.trim());
    }
  }
  if (textParts.length > 0) {
    return clipChars(textParts.join("\n").replace(/\s+/g, " ").trim(), MAX_SNIPPET_CHARS);
  }
  const texts = collectSearchableTexts(message);
  const joined = texts.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) return `(${message.role})`;
  return clipChars(joined, MAX_SNIPPET_CHARS);
}

function makeSnippet(text: string, keywords: string[]): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const lower = normalized.toLowerCase();
  let idx = -1;
  let matched = "";
  for (const kw of keywords) {
    const at = lower.indexOf(kw);
    if (at >= 0 && (idx < 0 || at < idx)) {
      idx = at;
      matched = kw;
    }
  }
  if (idx < 0) {
    return normalized.length > PREVIEW_RADIUS * 2
      ? `${normalized.slice(0, PREVIEW_RADIUS * 2)}…`
      : normalized;
  }
  const start = Math.max(0, idx - PREVIEW_RADIUS);
  const end = Math.min(
    normalized.length,
    idx + matched.length + PREVIEW_RADIUS,
  );
  let snippet = normalized.slice(start, end);
  if (start > 0) snippet = `…${snippet}`;
  if (end < normalized.length) snippet = `${snippet}…`;
  return snippet.length > MAX_SNIPPET_CHARS
    ? clipChars(snippet, MAX_SNIPPET_CHARS)
    : snippet;
}

function textMatchesAllKeywords(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return true;
  const lower = text.toLowerCase();
  return keywords.every((kw) => lower.includes(kw));
}

function resolveSessionIdFilter(
  raw: string | undefined,
  currentSessionId: string,
): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed === "current" || trimmed === ".") return currentSessionId;
  return trimmed;
}

function workspaceAgentSessions(
  sessions: Session[],
  workspaceId: string | undefined,
): Session[] {
  const wid = workspaceId?.trim() ?? "";
  return sessions.filter(
    (s) => s.type === "agent" && (!wid || s.workspaceId === wid),
  );
}

/** Human label for a workspace id (falls back to the raw id). */
function workspaceLabel(
  workspaceId: string,
  names: WorkspaceNameMap | undefined,
): string {
  return names?.get(workspaceId)?.trim() || workspaceId;
}

/**
 * Search agent sessions by keywords (AND) and/or time range.
 * Scope: one workspace via `workspaceId`, or all workspaces when unset.
 * Returns message-level hits (plus title hits when query matches title).
 */
export function searchSessionHistory(
  input: SessionHistorySearchInput,
): SessionHistoryHit[] {
  const keywords = splitSearchKeywords(input.query ?? "");
  const limit = clampLimit(input.limit, DEFAULT_LIMIT);
  const sessionFilter = resolveSessionIdFilter(
    input.sessionId,
    input.currentSessionId,
  );
  const afterMs =
    typeof input.afterMs === "number" && Number.isFinite(input.afterMs)
      ? input.afterMs
      : undefined;
  const beforeMs =
    typeof input.beforeMs === "number" && Number.isFinite(input.beforeMs)
      ? input.beforeMs
      : undefined;

  if (keywords.length === 0 && afterMs === undefined && beforeMs === undefined) {
    // No filters: return newest user/assistant messages across scope.
    return listRecentHistoryHits({
      sessions: input.sessions,
      currentSessionId: input.currentSessionId,
      workspaceId: input.workspaceId,
      ...(sessionFilter ? { sessionId: sessionFilter } : {}),
      limit,
    });
  }

  const pool = workspaceAgentSessions(input.sessions, input.workspaceId);
  const hits: SessionHistoryHit[] = [];

  for (const session of pool) {
    if (sessionFilter && session.id !== sessionFilter) continue;
    const title = session.title.trim() || "Untitled";

    if (
      keywords.length > 0 &&
      textMatchesAllKeywords(title, keywords) &&
      (afterMs === undefined || session.updatedAt >= afterMs) &&
      (beforeMs === undefined || session.updatedAt <= beforeMs)
    ) {
      hits.push({
        sessionId: session.id,
        sessionTitle: title,
        workspaceId: session.workspaceId,
        workspaceName: workspaceLabel(session.workspaceId, input.workspaceNames),
        messageId: "",
        role: "title",
        createdAt: session.updatedAt,
        snippet: title,
        matchKind: "title",
      });
    }

    for (const message of session.messages) {
      if (message.role === "system") continue;
      if (afterMs !== undefined && message.createdAt < afterMs) continue;
      if (beforeMs !== undefined && message.createdAt > beforeMs) continue;

      const texts = collectSearchableTexts(message);
      if (texts.length === 0 && keywords.length > 0) continue;

      const haystack = texts.join("\n");
      if (keywords.length > 0 && !textMatchesAllKeywords(haystack, keywords)) {
        continue;
      }

      hits.push({
        sessionId: session.id,
        sessionTitle: title,
        workspaceId: session.workspaceId,
        workspaceName: workspaceLabel(session.workspaceId, input.workspaceNames),
        messageId: message.id,
        role: message.role,
        createdAt: message.createdAt,
        snippet:
          keywords.length > 0
            ? makeSnippet(haystack, keywords)
            : messagePlainPreview(message),
        matchKind: "message",
      });
    }
  }

  hits.sort((a, b) => b.createdAt - a.createdAt);
  return hits.slice(0, limit);
}

function listRecentHistoryHits(
  input: SessionHistorySearchInput & { limit: number },
): SessionHistoryHit[] {
  const sessionFilter = resolveSessionIdFilter(
    input.sessionId,
    input.currentSessionId,
  );
  const pool = workspaceAgentSessions(input.sessions, input.workspaceId);
  const hits: SessionHistoryHit[] = [];

  for (const session of pool) {
    if (sessionFilter && session.id !== sessionFilter) continue;
    const title = session.title.trim() || "Untitled";
    for (const message of session.messages) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      hits.push({
        sessionId: session.id,
        sessionTitle: title,
        workspaceId: session.workspaceId,
        workspaceName: workspaceLabel(
          session.workspaceId,
          input.workspaceNames,
        ),
        messageId: message.id,
        role: message.role,
        createdAt: message.createdAt,
        snippet: messagePlainPreview(message),
        matchKind: "message",
      });
    }
  }

  hits.sort((a, b) => b.createdAt - a.createdAt);
  return hits.slice(0, input.limit);
}

export type SessionHistoryReadMessage = {
  messageId: string;
  role: string;
  createdAt: number;
  text: string;
};

export type SessionHistoryReadResult = {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  workspaceName: string;
  messages: SessionHistoryReadMessage[];
};

/**
 * Read a contiguous window of messages from one session
 * (any workspace when `workspaceId` is unset).
 */
export function readSessionHistory(
  input: SessionHistoryReadInput,
): SessionHistoryReadResult | null {
  const sessionFilter =
    resolveSessionIdFilter(input.sessionId, input.currentSessionId) ??
    input.currentSessionId;
  const pool = workspaceAgentSessions(input.sessions, input.workspaceId);
  const session = pool.find((s) => s.id === sessionFilter);
  if (!session) return null;

  const usable = session.messages.filter((m) => m.role !== "system");
  const title = session.title.trim() || "Untitled";

  const aroundId = input.aroundMessageId?.trim() ?? "";
  let slice: Message[];

  if (aroundId) {
    const idx = usable.findIndex((m) => m.id === aroundId);
    if (idx < 0) return null;
    const before = clampAround(input.beforeCount, DEFAULT_AROUND);
    const after = clampAround(input.afterCount, DEFAULT_AROUND);
    const start = Math.max(0, idx - before);
    const end = Math.min(usable.length, idx + after + 1);
    slice = usable.slice(start, end);
  } else {
    const limit = clampLimit(input.limit, DEFAULT_LIMIT);
    slice = usable.slice(Math.max(0, usable.length - limit));
  }

  return {
    sessionId: session.id,
    sessionTitle: title,
    workspaceId: session.workspaceId,
    workspaceName: workspaceLabel(session.workspaceId, input.workspaceNames),
    messages: slice.map((m) => ({
      messageId: m.id,
      role: m.role,
      createdAt: m.createdAt,
      text: messagePlainPreview(m),
    })),
  };
}

/** Parse ISO-8601 or epoch-ms string/number into epoch ms. */
export function parseTimeBound(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.floor(raw);
  }
  if (typeof raw !== "string" || !raw.trim()) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

/** Truncate a finished tool result; appends a short notice when cut. */
export function truncateSessionHistoryResult(body: string): string {
  if (body.length <= MAX_RESULT_CHARS) return body;
  const keep = Math.max(0, MAX_RESULT_CHARS - 80);
  return `${body.slice(0, keep)}\n\n…(truncated: result capped at ${MAX_RESULT_CHARS} chars; narrow query/session_id or use mode=read with a smaller window)`;
}

export function formatSessionHistoryHits(hits: SessionHistoryHit[]): string {
  if (hits.length === 0) {
    return "No matching session history.";
  }
  const lines = [`Found ${hits.length} hit(s):`, ""];
  for (let i = 0; i < hits.length; i += 1) {
    const h = hits[i]!;
    const when = new Date(h.createdAt).toISOString();
    const loc =
      h.matchKind === "title"
        ? "title"
        : h.matchKind === "history_summary"
          ? `archived summary (activity ${isoOr(h.archived?.firstMessageAt)} → ${isoOr(h.archived?.lastMessageAt)}, deleted ${isoOr(h.archived?.deletedAt)}${h.archived?.inputTruncated ? ", input truncated" : ""})`
          : `message ${h.messageId || "(none)"} (${h.role})`;
    lines.push(
      `${i + 1}. [${when}] workspace="${h.workspaceName}" session=${h.sessionId} title="${h.sessionTitle}" ${loc}`,
    );
    lines.push(`   ${clipChars(h.snippet, MAX_SNIPPET_CHARS)}`);
    lines.push("");
  }
  lines.push(
    'Tip: call again with mode="read", session_id, and optional around_message_id to load a message window; add workspace="current" to narrow to this workspace.',
  );
  return truncateSessionHistoryResult(lines.join("\n").trimEnd());
}

export function formatSessionHistoryRead(
  result: SessionHistoryReadResult,
): string {
  const lines = [
    `Session ${result.sessionId} — "${result.sessionTitle}" (workspace "${result.workspaceName}", ${result.messages.length} message(s)):`,
    "",
  ];
  for (const m of result.messages) {
    const when = new Date(m.createdAt).toISOString();
    lines.push(`[${when}] ${m.role} id=${m.messageId}`);
    lines.push(clipChars(m.text, MAX_SNIPPET_CHARS));
    lines.push("");
  }
  return truncateSessionHistoryResult(lines.join("\n").trimEnd());
}

export type SessionHistoryArchiveSearchInput = {
  records: SessionHistoryRecord[];
  /** Scope to one workspace id; empty / undefined = all workspaces. */
  workspaceId?: string | undefined;
  /** workspaceId → display name (records carry their own snapshot name). */
  workspaceNames?: WorkspaceNameMap;
  /** Multi-keyword AND — title or summary must contain every keyword. */
  query?: string;
  /** Narrow to one original session id. */
  sessionId?: string;
  /** Inclusive lower bound (epoch ms; matched against the activity window). */
  afterMs?: number;
  /** Inclusive upper bound (epoch ms; matched against the activity window). */
  beforeMs?: number;
  /** Max hits. Default 12, hard max 20. */
  limit?: number;
};

/**
 * Search summarized session_history records (deleted sessions) by keywords
 * and/or time window. A record matches when its title OR summary contains
 * every keyword; time bounds match the session's activity window
 * (first→last message, falling back to session timestamps).
 */
export function searchSessionHistoryArchive(
  input: SessionHistoryArchiveSearchInput,
): SessionHistoryHit[] {
  const keywords = splitSearchKeywords(input.query ?? "");
  const limit = clampLimit(input.limit, DEFAULT_LIMIT);
  const wid = input.workspaceId?.trim() ?? "";
  const sessionFilter = input.sessionId?.trim() ?? "";
  const afterMs =
    typeof input.afterMs === "number" && Number.isFinite(input.afterMs)
      ? input.afterMs
      : undefined;
  const beforeMs =
    typeof input.beforeMs === "number" && Number.isFinite(input.beforeMs)
      ? input.beforeMs
      : undefined;

  const hits: SessionHistoryHit[] = [];
  for (const record of input.records) {
    if (record.status !== "done" || !record.summary) continue;
    // LLM-discarded tombstones stay out of search (audit lives in sqlite).
    if (record.summarySource === "discarded") continue;
    if (wid && record.workspaceId !== wid) continue;
    if (sessionFilter && record.sessionId !== sessionFilter) continue;

    // Activity-window overlap; empty sessions fall back to session dates.
    const first = record.firstMessageAt ?? record.sessionCreatedAt;
    const last = record.lastMessageAt ?? record.sessionUpdatedAt;
    if (afterMs !== undefined && last < afterMs) continue;
    if (beforeMs !== undefined && first > beforeMs) continue;

    const title = record.title.trim() || "Untitled";
    if (keywords.length > 0) {
      const titleHit = textMatchesAllKeywords(title, keywords);
      const summaryHit = textMatchesAllKeywords(record.summary, keywords);
      if (!titleHit && !summaryHit) continue;
    }

    hits.push({
      sessionId: record.sessionId,
      sessionTitle: title,
      workspaceId: record.workspaceId,
      workspaceName:
        record.workspaceName.trim() ||
        workspaceLabel(record.workspaceId, input.workspaceNames),
      messageId: "",
      role: "summary",
      createdAt: last,
      snippet:
        keywords.length > 0
          ? makeSnippet(record.summary, keywords)
          : clipChars(
              record.summary.replace(/\s+/g, " ").trim(),
              MAX_SNIPPET_CHARS,
            ),
      matchKind: "history_summary",
      archived: {
        deletedAt: record.deletedAt,
        firstMessageAt: record.firstMessageAt,
        lastMessageAt: record.lastMessageAt,
        inputTruncated: record.inputTruncated,
        summarySource: record.summarySource ?? "",
      },
    });
  }

  hits.sort((a, b) => b.createdAt - a.createdAt);
  return hits.slice(0, limit);
}

/**
 * scope=all: newest-first merge of live-session and archive hits.
 *
 * Archive snapshots taken at archive time (session still alive) are dropped
 * here when the same session also has a live hit — the live transcript is
 * strictly richer than its summary; the summary surfaces only after the
 * session row is truly deleted.
 */
export function mergeSessionHistoryHits(
  sessionHits: SessionHistoryHit[],
  archiveHits: SessionHistoryHit[],
  limit: number,
): SessionHistoryHit[] {
  const liveSessionIds = new Set(sessionHits.map((hit) => hit.sessionId));
  const merged = [
    ...sessionHits,
    ...archiveHits.filter((hit) => !liveSessionIds.has(hit.sessionId)),
  ];
  merged.sort((a, b) => b.createdAt - a.createdAt);
  return merged.slice(0, Math.max(1, Math.floor(limit) || DEFAULT_LIMIT));
}

export type SessionHistoryArchiveReadResult = {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  workspaceName: string;
  summary: string;
  summarySource: string;
  summaryModel: string | null;
  inputTruncated: boolean;
  sessionCreatedAt: number;
  sessionUpdatedAt: number;
  firstMessageAt: number | null;
  lastMessageAt: number | null;
  deletedAt: number;
};

/** Fetch one archived record's full summary by original session id. */
export function readSessionHistoryArchive(input: {
  records: SessionHistoryRecord[];
  sessionId: string;
  workspaceNames?: WorkspaceNameMap;
}): SessionHistoryArchiveReadResult | null {
  const trimmed = input.sessionId.trim();
  if (!trimmed) return null;
  const record = input.records.find(
    (r) =>
      r.sessionId === trimmed &&
      r.status === "done" &&
      r.summary &&
      r.summarySource !== "discarded",
  );
  if (!record || !record.summary) return null;
  return {
    sessionId: record.sessionId,
    sessionTitle: record.title.trim() || "Untitled",
    workspaceId: record.workspaceId,
    workspaceName:
      record.workspaceName.trim() ||
      workspaceLabel(record.workspaceId, input.workspaceNames),
    summary: record.summary,
    summarySource: record.summarySource ?? "",
    summaryModel: record.summaryModel,
    inputTruncated: record.inputTruncated,
    sessionCreatedAt: record.sessionCreatedAt,
    sessionUpdatedAt: record.sessionUpdatedAt,
    firstMessageAt: record.firstMessageAt,
    lastMessageAt: record.lastMessageAt,
    deletedAt: record.deletedAt,
  };
}

/** Clamp a caller-provided limit to the tool's 1..20 range (default 12). */
export function clampSessionHistoryLimit(raw: number | undefined): number {
  return clampLimit(raw, DEFAULT_LIMIT);
}

function isoOr(t: number | null | undefined): string {
  return typeof t === "number" && Number.isFinite(t)
    ? new Date(t).toISOString()
    : "?";
}

/** Format one archived record for mode=read (full summary body). */
export function formatSessionHistoryArchiveRead(
  result: SessionHistoryArchiveReadResult,
): string {
  const lines = [
    `Archived session ${result.sessionId} — "${result.sessionTitle}" (workspace "${result.workspaceName}")`,
    `activity ${isoOr(result.firstMessageAt ?? result.sessionCreatedAt)} → ${isoOr(result.lastMessageAt ?? result.sessionUpdatedAt)} · deleted ${isoOr(result.deletedAt)} · summary by ${result.summarySource}${result.summaryModel ? ` (${result.summaryModel})` : ""}${result.inputTruncated ? " · input truncated" : ""}`,
    "",
    result.summary,
  ];
  return truncateSessionHistoryResult(lines.join("\n").trimEnd());
}
