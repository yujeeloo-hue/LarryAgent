import type { Message } from "../../session/types.js";
import { isSteerContinuation } from "../turnContinuations.js";

export type ConversationTurn = {
  age: number;
  userMessageId: string;
  startIndex: number;
  endIndex: number;
  messages: Message[];
};

function isCompactionMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.parts.some((p) => p.type === "context_compaction")
  );
}

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

export function recentConversationTurns(
  messages: Message[],
  limit: number,
  turnStartIds?: ReadonlySet<string>,
): Message[] {
  const keep = Math.max(1, Math.floor(limit));
  if (!turnStartIds || turnStartIds.size === 0) {
    const turns = splitConversationTurns(messages);
    const oldestKept = turns[keep - 1];
    if (!oldestKept || turns.length <= keep) return messages;
    return messages.slice(oldestKept.startIndex).filter((m) => !isCompactionMessage(m));
  }
  const starts: number[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (isCompactionMessage(msg)) continue;
    if ((msg.role === "user" && !isSteerContinuation(msg)) || turnStartIds.has(msg.id)) {
      starts.push(i);
    }
  }
  if (starts.length <= keep) return messages;
  return messages.slice(starts[starts.length - keep]).filter((m) => !isCompactionMessage(m));
}

export type ModelIteration = {
  age: number;
  messages: Message[];
};

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
