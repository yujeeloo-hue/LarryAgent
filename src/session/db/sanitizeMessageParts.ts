import type { ContextCompactionPart, MessagePart } from "../types.js";

/**
 * Normalize persisted message parts: accept a bare array or a legacy
 * `{ parts, … }` envelope, and rewrite compaction markers to known fields only.
 */
export function sanitizeMessageParts(parts: MessagePart[]): MessagePart[] {
  const out: MessagePart[] = [];
  for (const part of parts) {
    if (part.type !== "context_compaction") {
      out.push(part);
      continue;
    }
    const raw = part as ContextCompactionPart & Record<string, unknown>;
    const cleaned: ContextCompactionPart = {
      type: "context_compaction",
      id: String(raw.id ?? ""),
      summary: String(raw.summary ?? ""),
      fromMessageId: String(raw.fromMessageId ?? ""),
      toMessageId: String(raw.toMessageId ?? ""),
      usedTokensBefore:
        typeof raw.usedTokensBefore === "number" ? raw.usedTokensBefore : 0,
      usedTokensAfter:
        typeof raw.usedTokensAfter === "number" ? raw.usedTokensAfter : 0,
    };
    if (typeof raw.coveredThroughUserMessageId === "string") {
      cleaned.coveredThroughUserMessageId = raw.coveredThroughUserMessageId;
    }
    if (typeof raw.coveredThroughMessageId === "string") {
      cleaned.coveredThroughMessageId = raw.coveredThroughMessageId;
    }
    if (typeof raw.coldTurnCount === "number") {
      cleaned.coldTurnCount = raw.coldTurnCount;
    }
    if (typeof raw.demoVerbatim === "string" && raw.demoVerbatim.trim()) {
      cleaned.demoVerbatim = raw.demoVerbatim;
    }
    out.push(cleaned);
  }
  return out;
}

/** Parse a messages.parts / subagent_messages.parts JSON cell. */
export function parseStoredMessageParts(raw: string): MessagePart[] {
  const value: unknown = JSON.parse(raw);
  if (Array.isArray(value)) {
    return sanitizeMessageParts(value as MessagePart[]);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (!Array.isArray(obj.parts)) {
      throw new Error("Invalid message parts JSON");
    }
    return sanitizeMessageParts(obj.parts as MessagePart[]);
  }
  throw new Error("Invalid message parts JSON");
}

export function serializeStoredMessageParts(parts: MessagePart[]): string {
  return JSON.stringify(sanitizeMessageParts(parts));
}
