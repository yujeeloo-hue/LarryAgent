import { splitMessagesIntoTurns, type MessageLikeForModifiedFiles } from "./turnModifiedFiles.js";

export function recentTurnMessages<T extends MessageLikeForModifiedFiles>(
  messages: T[],
  cutoffMs: number,
  turnStartIds?: ReadonlySet<string>,
): { messages: T[]; trimmed: boolean } {
  const turns = splitMessagesIntoTurns(messages, turnStartIds);
  const first = turns.findIndex((turn) =>
    turn.some((message) => typeof message.createdAt === "number" && message.createdAt >= cutoffMs),
  );
  if (first === 0) return { messages, trimmed: false };
  if (first < 0) return { messages: [], trimmed: messages.length > 0 };
  const start = messages.indexOf(turns[first]![0]!);
  return { messages: messages.slice(start), trimmed: true };
}
