import type { Message, Session } from "./types.js";
import {
  RETRY_CONTINUATION_PART_ID,
  STEER_CONTINUATION_PART_ID,
} from "./types.js";

export const DEFAULT_TAIL_TURNS = 5;

export const MAX_TAIL_TURNS = 50;

export type SessionMessageWindowInfo = {
  firstMessageId: string | null;
  hasMore: boolean;
  remainingTurns: number;
};

export type SessionMessageWindow = SessionMessageWindowInfo & {
  messages: Message[];
};

export type SessionTailResult = {
  session: Session;
  window: SessionMessageWindowInfo;
};

export function isContextClearMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.parts.some((part) => part.type === "context_clear")
  );
}

export function isTurnStartUserMessage(message: Message): boolean {
  if (message.role !== "user") return false;
  return !message.parts.some(
    (part) =>
      part.type === "text" &&
      (part.id === STEER_CONTINUATION_PART_ID ||
        part.id === RETRY_CONTINUATION_PART_ID),
  );
}

export function clampTailTurns(turns: number | undefined): number {
  if (typeof turns !== "number" || !Number.isFinite(turns)) {
    return DEFAULT_TAIL_TURNS;
  }
  const rounded = Math.floor(turns);
  if (rounded < 1) return 1;
  return Math.min(rounded, MAX_TAIL_TURNS);
}

function findLastClearIndex(
  messages: Message[],
  endExclusive: number,
): number {
  for (let i = endExclusive - 1; i >= 0; i -= 1) {
    if (isContextClearMessage(messages[i]!)) return i;
  }
  return -1;
}

export function isContextNewTaskMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.parts.some((part) => part.type === "context_new_task")
  );
}

function includeLeadingNewTaskMarker(
  messages: Message[],
  windowStart: number,
): number {
  let start = windowStart;
  while (start > 0 && isContextNewTaskMessage(messages[start - 1]!)) {
    start -= 1;
  }
  return start;
}

function turnStartIndices(
  messages: Message[],
  begin: number,
  endExclusive: number,
): number[] {
  const starts: number[] = [];
  for (let i = begin; i < endExclusive; i += 1) {
    if (isTurnStartUserMessage(messages[i]!)) starts.push(i);
  }
  return starts;
}

export function sliceSessionTailWindow(
  messages: Message[],
  turns: number | undefined,
): SessionMessageWindow {
  const count = clampTailTurns(turns);
  const clearIndex = findLastClearIndex(messages, messages.length);
  const floor = clearIndex >= 0 ? clearIndex : 0;
  const starts = turnStartIndices(messages, floor, messages.length);

  let windowStart: number;
  let hasMore: boolean;
  if (starts.length > count) {
    windowStart = starts[starts.length - count]!;
    hasMore = true;
  } else {
    windowStart = floor;
    hasMore = false;
  }
  windowStart = includeLeadingNewTaskMarker(messages, windowStart);

  const window = messages.slice(windowStart);
  return {
    messages: window,
    firstMessageId: window[0]?.id ?? null,
    hasMore,
    remainingTurns: hasMore
      ? starts.filter((start) => start < windowStart).length
      : 0,
  };
}

export function sliceSessionWindowBefore(
  messages: Message[],
  beforeMessageId: string,
  turns: number | undefined,
): SessionMessageWindow | null {
  const cursor = messages.findIndex((message) => message.id === beforeMessageId);
  if (cursor < 0) return null;
  if (
    cursor === 0 ||
    isContextClearMessage(messages[cursor]!)
  ) {
    return {
      messages: [],
      firstMessageId: null,
      hasMore: false,
      remainingTurns: 0,
    };
  }

  const count = clampTailTurns(turns);
  const clearIndex = findLastClearIndex(messages, cursor);
  const floor = clearIndex >= 0 ? clearIndex : 0;
  const starts = turnStartIndices(messages, floor, cursor);

  let pageStart: number;
  let hasMore: boolean;
  let remainingTurns: number;
  if (starts.length > count) {
    pageStart = starts[starts.length - count]!;
    hasMore = true;
    remainingTurns = starts.filter((start) => start < pageStart).length;
  } else {
    pageStart = floor;
    hasMore = false;
    remainingTurns = 0;
  }
  pageStart = includeLeadingNewTaskMarker(messages, pageStart);

  const page = messages.slice(pageStart, cursor);
  return {
    messages: page,
    firstMessageId: page[0]?.id ?? null,
    hasMore,
    remainingTurns,
  };
}
