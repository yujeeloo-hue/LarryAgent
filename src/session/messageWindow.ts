import type { Message, Session } from "./types.js";
import {
  RETRY_CONTINUATION_PART_ID,
  STEER_CONTINUATION_PART_ID,
} from "./types.js";

/** Default number of turns the conversation screen renders on first load. */
export const DEFAULT_TAIL_TURNS = 5;

/** Upper bound for the `turns` request parameter (guard against junk input). */
export const MAX_TAIL_TURNS = 50;

export type SessionMessageWindowInfo = {
  /** First message id of the window — cursor for the next older page. */
  firstMessageId: string | null;
  /** Visible messages exist above this window (offer "load earlier"). */
  hasMore: boolean;
  /** Turn starts remaining above the window (sentinel label). */
  remainingTurns: number;
};

export type SessionMessageWindow = SessionMessageWindowInfo & {
  messages: Message[];
};

/** getSessionTail IPC result: session metadata + windowed messages. */
export type SessionTailResult = {
  session: Session;
  window: SessionMessageWindowInfo;
};

/** /clear marker: everything before it is dead history. */
export function isContextClearMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.parts.some((part) => part.type === "context_clear")
  );
}

/**
 * A turn starts at each non-continuation user message (mirrors the
 * renderer's splitMessagesIntoTurns boundary). Steer inserts and hidden
 * retry continuations keep the turn open.
 */
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

/** Last index of a /clear marker within [0, endExclusive). */
function findLastClearIndex(
  messages: Message[],
  endExclusive: number,
): number {
  for (let i = endExclusive - 1; i >= 0; i -= 1) {
    if (isContextClearMessage(messages[i]!)) return i;
  }
  return -1;
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

/**
 * Window containing the last `turns` turns of the visible range (everything
 * after the last /clear marker). When the visible range fits, the marker
 * itself is included so the "Conversation cleared" divider renders — parity
 * with the old full-transcript render.
 */
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

/**
 * Older page ending just before `beforeMessageId`. Returns null when the
 * cursor message no longer exists (stale window → caller reloads from tail).
 */
export function sliceSessionWindowBefore(
  messages: Message[],
  beforeMessageId: string,
  turns: number | undefined,
): SessionMessageWindow | null {
  const cursor = messages.findIndex((message) => message.id === beforeMessageId);
  if (cursor < 0) return null;
  // Nothing visible above the cursor: either it is the first message, or it
  // is the /clear marker — pre-clear history is dead and must never page in.
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
    // Whole visible range above the cursor fits in one page; include the
    // /clear marker (divider) exactly once — it is the hard floor.
    pageStart = floor;
    hasMore = false;
    remainingTurns = 0;
  }

  const page = messages.slice(pageStart, cursor);
  return {
    messages: page,
    firstMessageId: page[0]?.id ?? null,
    hasMore,
    remainingTurns,
  };
}
