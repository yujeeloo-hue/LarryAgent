import { randomUUID } from "node:crypto";

import type { StreamEvent } from "../streamEvents.js";
import type { LlmRequestMeta } from "../types.js";

/**
 * In-memory recorder for the Dev Panel "Timeline" tab: one record per
 * Agent↔LLM round-trip that goes through openaiCompatibleClient
 * (chat + aux purposes). Dev-debug surface only — nothing is persisted,
 * everything is gone after app restart. Never throws into the agent turn.
 */
export type LlmTimelineRecordKind = "llm" | "tool" | "user";

type TimelineRecordBase = {
  id: string;
  sessionId: string;
  /** Wall-clock ms epoch. */
  startedAt: number;
  /** null while the call is in flight. */
  endedAt: number | null;
  durationMs: number | null;
  error?: string;
};

export type LlmCallTimelineRecord = TimelineRecordBase & {
  kind: "llm";
  purpose?: LlmRequestMeta["purpose"];
  iteration?: number;
  model: string;
  stream: boolean;
  messageCount: number;
  toolDefCount: number;
  /** Attempt count within the client's internal retry loop (starts at 1). */
  attempts: number;
  doneReason?: string;
  httpStatus?: number;
  textChars?: number;
  reasoningChars?: number;
  toolCallCount?: number;
  toolNames?: string[];
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  /**
   * Phase timestamps for the LLM track segmentation (ms epoch, observed
   * live): wait = startedAt→firstEventAt, reasoning = reasoning*At,
   * content = content*At. Only set for streaming calls.
   */
  firstEventAt?: number;
  reasoningStartAt?: number;
  reasoningEndAt?: number;
  contentStartAt?: number;
  contentEndAt?: number;
  /** Capped raw payloads for the detail panel (see RAW_CAP / RAW_KEEP_RECENT). */
  reqRaw?: string;
  textRaw?: string;
  reasoningRaw?: string;
};

export type ToolTimelineRecord = TimelineRecordBase & {
  kind: "tool";
  name: string;
  toolCallId?: string;
  status?: string;
  returnCode?: number;
  argsRaw?: string;
  resultRaw?: string;
};

export type UserTimelineRecord = TimelineRecordBase & {
  kind: "user";
  label: string;
  promptRaw?: string;
};

export type LlmTimelineRecord =
  | LlmCallTimelineRecord
  | ToolTimelineRecord
  | UserTimelineRecord;

export type LlmTimelineSnapshot = {
  records: LlmTimelineRecord[];
  /** Oldest records dropped by the per-session ring buffer. */
  truncatedCount: number;
};

export type BeginLlmTimelineInput = {
  sessionId: string;
  purpose?: LlmRequestMeta["purpose"];
  iteration?: number;
  model: string;
  stream: boolean;
  messageCount: number;
  toolDefCount: number;
  reqRaw?: string;
};

export type LlmTimelineFinishPatch = Partial<
  Pick<
    LlmCallTimelineRecord,
    | "doneReason"
    | "error"
    | "httpStatus"
    | "textChars"
    | "reasoningChars"
    | "toolCallCount"
    | "toolNames"
    | "promptTokens"
    | "completionTokens"
    | "totalTokens"
    | "cachedTokens"
    | "cacheWriteTokens"
    | "textRaw"
  >
>;

export type BeginToolTimelineInput = {
  sessionId: string;
  name: string;
  toolCallId?: string;
  argsRaw?: string;
};

export type ToolTimelineFinishPatch = {
  status?: string;
  error?: string;
  returnCode?: number;
  resultRaw?: string;
};

/** Mutable handle owned by the tool execution path until it settles. */
export type ToolTimelineEntry = {
  readonly recordId: string;
  /** Seal the record (idempotent). */
  finish(patch?: ToolTimelineFinishPatch): void;
};

export type RecordUserPromptInput = {
  sessionId: string;
  label: string;
  promptRaw?: string;
  /**
   * Clear the session buffer first (turn start). Defaults to true;
   * mid-turn steer prompts pass false so the running turn survives.
   */
  clearPrevious?: boolean;
};

/** Mutable handle owned by the LLM client until the call finishes. */
export type LlmTimelineEntry = {
  readonly recordId: string;
  /** Internal retry loop will re-send; `nextAttempt` is the upcoming attempt number. */
  noteRetry(nextAttempt: number): void;
  noteHttpStatus(status: number): void;
  /** Accumulate stats from streamed `StreamEvent`s (chars / tools / usage / outcome). */
  observe(event: StreamEvent): void;
  /** Seal the record (idempotent). Explicit patch fields win over observed ones. */
  finish(patch?: LlmTimelineFinishPatch): void;
};

const DEFAULT_CAPACITY = 5_000;
const TOOL_NAMES_CAP = 24;
/** Hard cap per raw payload field (bytes of string content). */
const RAW_CAP = 32_768;
/** Raw payloads are only kept for this many most-recent records per session. */
const RAW_KEEP_RECENT = 300;

type SessionBuffer = {
  records: LlmTimelineRecord[];
  truncatedCount: number;
};

let capacity = DEFAULT_CAPACITY;
const buffers = new Map<string, SessionBuffer>();
const listeners = new Set<(sessionId: string) => void>();

export function setLlmTimelineCapacity(value: number): void {
  if (!Number.isFinite(value) || value < 1) return;
  capacity = Math.floor(value);
  for (const buffer of buffers.values()) trim(buffer);
}

export function subscribeLlmTimeline(
  listener: (sessionId: string) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearLlmTimeline(sessionId?: string): void {
  if (sessionId === undefined) {
    buffers.clear();
  } else {
    buffers.delete(sessionId);
  }
}

export function listLlmTimeline(sessionId: string): LlmTimelineSnapshot {
  const buffer = buffers.get(sessionId);
  if (!buffer) return { records: [], truncatedCount: 0 };
  return {
    records: buffer.records.slice(),
    truncatedCount: buffer.truncatedCount,
  };
}

function emit(sessionId: string): void {
  for (const listener of listeners) {
    try {
      listener(sessionId);
    } catch {
      // Dev panel must never break the agent turn.
    }
  }
}

function trim(buffer: SessionBuffer): void {
  while (buffer.records.length > capacity) {
    buffer.records.shift();
    buffer.truncatedCount += 1;
  }
}

function insertRecord(record: LlmTimelineRecord): void {
  let buffer = buffers.get(record.sessionId);
  if (!buffer) {
    buffer = { records: [], truncatedCount: 0 };
    buffers.set(record.sessionId, buffer);
  }
  buffer.records.push(record);
  trim(buffer);
  // Incrementally strip raw payloads from records that just left the
  // recent window — bounded memory without a full sweep per insert.
  const keepFrom = buffer.records.length - RAW_KEEP_RECENT;
  if (keepFrom > 0) {
    for (let i = Math.max(0, keepFrom - 4); i < keepFrom; i++) {
      const old = buffer.records[i];
      if (old) stripRaw(old);
    }
  }
  emit(record.sessionId);
}

/** Clamp a raw payload to RAW_CAP. */
function capRaw(value: string): string {
  return value.length <= RAW_CAP ? value : value.slice(0, RAW_CAP);
}

/** Drop raw payloads from an aged-out record (stats stay). */
function stripRaw(record: LlmTimelineRecord): void {
  if (record.kind === "llm") {
    delete record.reqRaw;
    delete record.textRaw;
    delete record.reasoningRaw;
  } else if (record.kind === "tool") {
    delete record.argsRaw;
    delete record.resultRaw;
  } else {
    delete record.promptRaw;
  }
}

/** Track first/last timestamps of a streaming phase (reasoning / content). */
function markPhase(
  record: LlmCallTimelineRecord,
  now: number,
  phase: "reasoning" | "content",
): void {
  if (phase === "reasoning") {
    if (record.reasoningStartAt === undefined) record.reasoningStartAt = now;
    record.reasoningEndAt = now;
  } else {
    if (record.contentStartAt === undefined) record.contentStartAt = now;
    record.contentEndAt = now;
  }
}

export function beginLlmTimelineEntry(
  input: BeginLlmTimelineInput,
): LlmTimelineEntry | null {
  if (!input.sessionId) return null;
  const record: LlmCallTimelineRecord = {
    id: randomUUID(),
    sessionId: input.sessionId,
    kind: "llm",
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.iteration !== undefined ? { iteration: input.iteration } : {}),
    model: input.model,
    stream: input.stream,
    messageCount: input.messageCount,
    toolDefCount: input.toolDefCount,
    ...(input.reqRaw !== undefined ? { reqRaw: capRaw(input.reqRaw) } : {}),
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    attempts: 1,
  };
  insertRecord(record);

  let finished = false;
  return {
    recordId: record.id,
    noteRetry(nextAttempt: number): void {
      if (finished) return;
      if (Number.isFinite(nextAttempt) && nextAttempt > record.attempts) {
        record.attempts = Math.floor(nextAttempt);
      }
    },
    noteHttpStatus(status: number): void {
      if (finished) return;
      if (Number.isFinite(status)) record.httpStatus = status;
    },
    observe(event: StreamEvent): void {
      if (finished) return;
      try {
        const now = Date.now();
        switch (event.type) {
          case "text_delta":
            record.textChars = (record.textChars ?? 0) + event.text.length;
            if ((record.textRaw?.length ?? 0) < RAW_CAP) {
              record.textRaw = capRaw((record.textRaw ?? "") + event.text);
            }
            markPhase(record, now, "content");
            if (record.firstEventAt === undefined) record.firstEventAt = now;
            break;
          case "reasoning_delta":
            record.reasoningChars =
              (record.reasoningChars ?? 0) + event.text.length;
            if ((record.reasoningRaw?.length ?? 0) < RAW_CAP) {
              record.reasoningRaw = capRaw(
                (record.reasoningRaw ?? "") + event.text,
              );
            }
            markPhase(record, now, "reasoning");
            if (record.firstEventAt === undefined) record.firstEventAt = now;
            break;
          case "tool_call_delta":
            if (record.firstEventAt === undefined) record.firstEventAt = now;
            markPhase(record, now, "content");
            break;
          case "tool_call": {
            record.toolCallCount = (record.toolCallCount ?? 0) + 1;
            if (!record.toolNames) record.toolNames = [];
            if (record.toolNames.length < TOOL_NAMES_CAP) {
              record.toolNames.push(event.name);
            }
            break;
          }
          case "usage": {
            if (record.firstEventAt === undefined) record.firstEventAt = now;
            if (typeof event.promptTokens === "number") {
              record.promptTokens = event.promptTokens;
            }
            if (typeof event.completionTokens === "number") {
              record.completionTokens = event.completionTokens;
            }
            if (typeof event.totalTokens === "number") {
              record.totalTokens = event.totalTokens;
            }
            if (typeof event.cachedTokens === "number") {
              record.cachedTokens = event.cachedTokens;
            }
            if (typeof event.cacheWriteTokens === "number") {
              record.cacheWriteTokens = event.cacheWriteTokens;
            }
            break;
          }
          case "error":
            record.error = event.message;
            break;
          case "done":
            record.doneReason = event.reason;
            break;
          default:
            break;
        }
      } catch {
        // Never propagate into the stream loop.
      }
    },
    finish(patch?: LlmTimelineFinishPatch): void {
      if (finished) return;
      finished = true;
      record.endedAt = Date.now();
      record.durationMs = record.endedAt - record.startedAt;
      if (patch) {
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) continue;
          (record as unknown as Record<string, unknown>)[key] =
            typeof value === "string" ? capRaw(value) : value;
        }
      }
      emit(record.sessionId);
    },
  };
}

export function beginToolTimelineEntry(
  input: BeginToolTimelineInput,
): ToolTimelineEntry | null {
  if (!input.sessionId) return null;
  const record: ToolTimelineRecord = {
    id: randomUUID(),
    sessionId: input.sessionId,
    kind: "tool",
    name: input.name,
    ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    ...(input.argsRaw !== undefined
      ? { argsRaw: capRaw(input.argsRaw) }
      : {}),
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
  };
  insertRecord(record);

  let finished = false;
  return {
    recordId: record.id,
    finish(patch?: ToolTimelineFinishPatch): void {
      if (finished) return;
      finished = true;
      record.endedAt = Date.now();
      record.durationMs = record.endedAt - record.startedAt;
      if (patch) {
        if (patch.status !== undefined) record.status = patch.status;
        if (patch.error !== undefined) record.error = patch.error;
        if (patch.returnCode !== undefined) {
          record.returnCode = patch.returnCode;
        }
        if (patch.resultRaw !== undefined) {
          record.resultRaw = capRaw(patch.resultRaw);
        }
      }
      emit(record.sessionId);
    },
  };
}

export function recordUserPrompt(input: RecordUserPromptInput): void {
  if (!input.sessionId) return;
  // A new turn starts with its user prompt: drop the previous turn's data.
  // Steer prompts arrive mid-turn and must not wipe the running turn.
  if (input.clearPrevious !== false) buffers.delete(input.sessionId);
  const startedAt = Date.now();
  const record: UserTimelineRecord = {
    id: randomUUID(),
    sessionId: input.sessionId,
    kind: "user",
    label: input.label,
    ...(input.promptRaw !== undefined
      ? { promptRaw: capRaw(input.promptRaw) }
      : {}),
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
  };
  insertRecord(record);
}
