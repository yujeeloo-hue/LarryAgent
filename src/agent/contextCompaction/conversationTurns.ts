/**
 * Conversation Turn splitting — shared wire-layer primitive used by every
 * compaction strategy. A Turn is a user message plus everything up to the
 * next user message (steer continuations do not start a Turn; compaction
 * markers never appear inside a Turn slice).
 */
import type { Message } from "../../session/types.js";
import { isSteerContinuation } from "../turnContinuations.js";

export type ConversationTurn = {
  /** 1 = newest user Turn. */
  age: number;
  userMessageId: string;
  /** Inclusive start index in session.messages. */
  startIndex: number;
  /** Exclusive end index in session.messages. */
  endIndex: number;
  messages: Message[];
};

function isCompactionMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.parts.some((p) => p.type === "context_compaction")
  );
}

/**
 * Split transcript into user Turns (user message → next user, exclusive).
 * Compaction markers are skipped and do not start a Turn.
 * Newest Turn is age 1.
 */
export function splitConversationTurns(messages: Message[]): ConversationTurn[] {
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (msg.role === "user" && !isSteerContinuation(msg)) {
      starts.push(i);
    }
  }

  const turnsChronological: Omit<ConversationTurn, "age">[] = [];
  for (let s = 0; s < starts.length; s += 1) {
    const startIndex = starts[s]!;
    const endIndex = s + 1 < starts.length ? starts[s + 1]! : messages.length;
    const slice = messages
      .slice(startIndex, endIndex)
      .filter((m) => !isCompactionMessage(m));
    turnsChronological.push({
      userMessageId: messages[startIndex]!.id,
      startIndex,
      endIndex,
      messages: slice,
    });
  }

  const newestFirst = [...turnsChronological].reverse();
  return newestFirst.map((turn, index) => ({
    ...turn,
    age: index + 1,
  }));
}

/**
 * Messages from the start of the `limit`-th newest user Turn onward, without
 * compaction markers. Fewer Turns than `limit` → the transcript unchanged.
 */
export function recentConversationTurns(messages: Message[], limit: number): Message[] {
  const turns = splitConversationTurns(messages);
  const oldestKept = turns[Math.max(1, Math.floor(limit)) - 1];
  if (!oldestKept || turns.length <= limit) return messages;
  return messages.slice(oldestKept.startIndex).filter((m) => !isCompactionMessage(m));
}

/** One model↔tools iteration inside a user Turn (assistant + following tool results). */
export type ModelIteration = {
  /** 1 = newest iteration within the Turn. */
  age: number;
  messages: Message[];
};

/**
 * Split Turn messages into the leading user prefix + model iterations.
 * An iteration starts at each assistant message and includes following tool messages
 * until the next assistant (or end). Leading user messages are returned separately
 * and always stay raw.
 */
export function splitTurnModelIterations(messages: Message[]): {
  userPrefix: Message[];
  iterations: ModelIteration[];
} {
  const userPrefix: Message[] = [];
  const rest: Message[] = [];
  let seenAssistant = false;
  for (const message of messages) {
    if (!seenAssistant && message.role === "user") {
      userPrefix.push(message);
      continue;
    }
    if (message.role === "assistant") {
      seenAssistant = true;
    }
    // Leading non-user/non-assistant before first assistant (rare) stays in rest.
    if (!seenAssistant && message.role !== "assistant") {
      userPrefix.push(message);
      continue;
    }
    rest.push(message);
  }

  const iterationSlices: Message[][] = [];
  let current: Message[] = [];
  for (const message of rest) {
    if (message.role === "assistant") {
      if (current.length > 0) {
        iterationSlices.push(current);
      }
      current = [message];
      continue;
    }
    if (current.length === 0) {
      // Orphan tool/system before any assistant — keep as its own slice.
      iterationSlices.push([message]);
      continue;
    }
    current.push(message);
  }
  if (current.length > 0) {
    iterationSlices.push(current);
  }

  const newestFirst = [...iterationSlices].reverse();
  const iterations = newestFirst.map((slice, index) => ({
    age: index + 1,
    messages: slice,
  }));
  return { userPrefix, iterations };
}
