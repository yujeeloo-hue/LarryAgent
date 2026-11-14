import type { Session, TextPart } from "../../session/types.js";
import {
  SUBAGENT_MAX_ATTACHMENT_NOTE_CHARS,
  SUBAGENT_MAX_ATTACHMENT_PAYLOAD_CHARS,
  SUBAGENT_MAX_ATTACHMENTS,
  SUBAGENT_MAX_TABLE_CELL_CHARS,
  SUBAGENT_MAX_TABLE_COLS,
  SUBAGENT_MAX_TABLE_PAYLOAD_CHARS,
  SUBAGENT_MAX_TABLE_ROWS,
  SUBAGENT_MAX_TABLE_TITLE_CHARS,
  SUBAGENT_MAX_TABLES,
  SUBAGENT_SUMMARY_MAX_CHARS,
} from "./constants.js";
import type { SubagentTranscriptMessage } from "./types.js";

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** Drop trailing items until JSON.stringify(items) fits under maxChars. */
function fitUnderCharBudget<T>(items: T[], maxChars: number): T[] {
  if (items.length === 0) return items;
  if (JSON.stringify(items).length <= maxChars) return items;
  const out: T[] = [];
  for (const item of items) {
    const next = [...out, item];
    if (JSON.stringify(next).length > maxChars) break;
    out.push(item);
  }
  return out;
}

export type SubagentResultAttachment = {
  path: string;
  note?: string;
};

export type SubagentResultTable = {
  title?: string;
  headers: string[];
  rows: string[][];
};

/** Structured final reply from a subagent (parent-facing). */
export type SubagentResultPayload = {
  result: string;
  attachment: SubagentResultAttachment[];
  table: SubagentResultTable[];
};

function lastAssistantText(session: Session): string {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const message = session.messages[i];
    if (!message || message.role !== "assistant") continue;
    const chunks: string[] = [];
    for (const part of message.parts) {
      if (part.type === "text" && part.text.trim()) {
        chunks.push(part.text.trim());
      }
    }
    if (chunks.length > 0) {
      return chunks.join("\n\n");
    }
  }
  return "";
}

function asStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => (typeof item === "string" ? item : String(item ?? "")))
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeAttachment(raw: unknown): SubagentResultAttachment[] {
  if (!Array.isArray(raw)) return [];
  const out: SubagentResultAttachment[] = [];
  for (const item of raw) {
    if (out.length >= SUBAGENT_MAX_ATTACHMENTS) break;
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const path =
      typeof rec.path === "string"
        ? rec.path.trim()
        : typeof rec.uri === "string"
          ? rec.uri.trim()
          : "";
    if (!path) continue;
    const noteRaw =
      typeof rec.note === "string" && rec.note.trim()
        ? rec.note.trim()
        : undefined;
    const note = noteRaw
      ? truncate(noteRaw, SUBAGENT_MAX_ATTACHMENT_NOTE_CHARS)
      : undefined;
    out.push(note ? { path, note } : { path });
  }
  return fitUnderCharBudget(out, SUBAGENT_MAX_ATTACHMENT_PAYLOAD_CHARS);
}

function normalizeTable(raw: unknown): SubagentResultTable[] {
  if (!Array.isArray(raw)) return [];
  const out: SubagentResultTable[] = [];
  for (const item of raw) {
    if (out.length >= SUBAGENT_MAX_TABLES) break;
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const headers = asStringArray(rec.headers)
      .slice(0, SUBAGENT_MAX_TABLE_COLS)
      .map((h) => truncate(h, SUBAGENT_MAX_TABLE_CELL_CHARS));
    const rowsRaw = Array.isArray(rec.rows) ? rec.rows : [];
    const rows: string[][] = rowsRaw
      .slice(0, SUBAGENT_MAX_TABLE_ROWS)
      .map((row) => {
        const cells = Array.isArray(row)
          ? row.map((cell) =>
              typeof cell === "string" ? cell : String(cell ?? ""),
            )
          : [String(row ?? "")];
        return cells
          .slice(0, SUBAGENT_MAX_TABLE_COLS)
          .map((cell) => truncate(cell, SUBAGENT_MAX_TABLE_CELL_CHARS));
      });
    if (headers.length === 0 && rows.length === 0) continue;
    const titleRaw =
      typeof rec.title === "string" && rec.title.trim()
        ? rec.title.trim()
        : undefined;
    const title = titleRaw
      ? truncate(titleRaw, SUBAGENT_MAX_TABLE_TITLE_CHARS)
      : undefined;
    out.push(title ? { title, headers, rows } : { headers, rows });
  }
  return fitUnderCharBudget(out, SUBAGENT_MAX_TABLE_PAYLOAD_CHARS);
}

/** Pull a JSON object from model text (raw or fenced); null if none. */
export function extractJsonObjectText(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence?.[1] ?? trimmed).trim();
  if (candidate.startsWith("{") && candidate.endsWith("}")) {
    return candidate;
  }

  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return candidate.slice(start, end + 1);
  }
  return null;
}

export function normalizeSubagentResultPayload(
  raw: unknown,
  fallbackResult: string,
): SubagentResultPayload {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      result: truncate(fallbackResult || "(No assistant summary.)", SUBAGENT_SUMMARY_MAX_CHARS),
      attachment: [],
      table: [],
    };
  }
  const rec = raw as Record<string, unknown>;
  const resultSource =
    typeof rec.result === "string"
      ? rec.result
      : typeof rec.summary === "string"
        ? rec.summary
        : fallbackResult;
  const result = truncate(
    (resultSource || "(No assistant summary.)").trim() ||
      "(No assistant summary.)",
    SUBAGENT_SUMMARY_MAX_CHARS,
  );
  return {
    result,
    attachment: normalizeAttachment(rec.attachment ?? rec.attachments),
    table: normalizeTable(rec.table ?? rec.tables),
  };
}

export function parseSubagentResultPayload(rawText: string): SubagentResultPayload {
  const text = rawText.trim();
  if (!text) {
    return {
      result: "(No assistant summary.)",
      attachment: [],
      table: [],
    };
  }

  const jsonText = extractJsonObjectText(text);
  if (jsonText) {
    try {
      return normalizeSubagentResultPayload(JSON.parse(jsonText), text);
    } catch {
      // fall through — wrap non-JSON as result
    }
  }
  return {
    result: truncate(text, SUBAGENT_SUMMARY_MAX_CHARS),
    attachment: [],
    table: [],
  };
}

export function serializeSubagentResultPayload(
  payload: SubagentResultPayload,
): string {
  return JSON.stringify({
    result: payload.result,
    attachment: payload.attachment,
    table: payload.table,
  });
}

/**
 * Parse the child session's last assistant text into structured JSON for the parent.
 * Invalid / non-JSON replies are wrapped as `{ result, attachment: [], table: [] }`.
 */
export function extractSubagentResult(session: Session): {
  payload: SubagentResultPayload;
  /** Compact JSON string stored on the run / injected to parent. */
  summaryJson: string;
  /** Plain `result` text for UI stream cards. */
  resultText: string;
} {
  const payload = parseSubagentResultPayload(lastAssistantText(session));
  return {
    payload,
    summaryJson: serializeSubagentResultPayload(payload),
    resultText: payload.result,
  };
}

export function buildSubagentTranscript(
  session: Session,
): SubagentTranscriptMessage[] {
  const out: SubagentTranscriptMessage[] = [];
  for (const message of session.messages) {
    const texts: string[] = [];
    for (const part of message.parts) {
      if (part.type === "text" && (part as TextPart).text.trim()) {
        texts.push((part as TextPart).text.trim());
      } else if (part.type === "tool_call") {
        texts.push(`[tool:${part.name}]`);
      } else if (part.type === "tool_result") {
        const body = part.content
          .filter((p): p is TextPart => p.type === "text")
          .map((p) => p.text)
          .join("\n")
          .trim();
        if (body) {
          texts.push(truncate(body, 500));
        }
      }
    }
    if (texts.length === 0) continue;
    out.push({
      role: message.role,
      text: texts.join("\n"),
    });
  }
  return out;
}

/** Max length for an LLM-assigned subagent nickname (UI display). */
export const SUBAGENT_NAME_MAX_CHARS = 40;

/**
 * Normalize an optional display nickname.
 * Empty / oversized → null (caller falls back to prompt-derived label).
 */
export function normalizeSubagentName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) return null;
  if (name.length > SUBAGENT_NAME_MAX_CHARS) {
    return `${name.slice(0, SUBAGENT_NAME_MAX_CHARS - 1)}…`;
  }
  return name;
}

/** Human-readable label when the model omits `name`. */
export function nameFromPrompt(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/)[0]?.trim() ?? "Subagent";
  if (!line) return "Subagent";
  return line.length > SUBAGENT_NAME_MAX_CHARS
    ? `${line.slice(0, SUBAGENT_NAME_MAX_CHARS - 1)}…`
    : line;
}
