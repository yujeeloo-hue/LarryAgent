import { randomUUID } from "node:crypto";

import type { StreamEvent } from "../streamEvents.js";
import type { LlmRequestMeta } from "../types.js";

export type LlmTimelineRecordKind = "llm" | "tool" | "user";

type TimelineRecordBase = {
  id: string;
  sessionId: string;
  startedAt: number;
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
  firstEventAt?: number;
  reasoningStartAt?: number;
  reasoningEndAt?: number;
  contentStartAt?: number;
  contentEndAt?: number;
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

export type ToolTimelineEntry = {
  readonly recordId: string;
  finish(patch?: ToolTimelineFinishPatch): void;
};

export type RecordUserPromptInput = {
  sessionId: string;
  label: string;
  promptRaw?: string;
  clearPrevious?: boolean;
};

export type LlmTimelineEntry = {
  readonly recordId: string;
  noteRetry(nextAttempt: number): void;
  noteHttpStatus(status: number): void;
  observe(event: StreamEvent): void;
  finish(patch?: LlmTimelineFinishPatch): void;
};

const DEFAULT_CAPACITY = 5_000;
const TOOL_NAMES_CAP = 24;
const RAW_CAP = 32_768;
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
  const keepFrom = buffer.records.length - RAW_KEEP_RECENT;
  if (keepFrom > 0) {
    for (let i = Math.max(0, keepFrom - 4); i < keepFrom; i++) {
      const old = buffer.records[i];
      if (old) stripRaw(old);
    }
  }
  emit(record.sessionId);
}

function capRaw(value: string): string {
  return value.length <= RAW_CAP ? value : value.slice(0, RAW_CAP);
}

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
