const WIRE_ONLY_PART_TYPES: ReadonlySet<unknown> = new Set(["model_response", "turn_context"]);

function stripReplayParts(messages: unknown): void {
  if (!Array.isArray(messages)) return;
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as { parts?: unknown[] };
    if (!Array.isArray(message.parts)) continue;
    message.parts = message.parts.filter((part: unknown) =>
      !part || typeof part !== "object" || !WIRE_ONLY_PART_TYPES.has((part as { type?: unknown }).type));
  }
}

export function messagesForPresentation<T>(messages: readonly T[]): T[] {
  const copy = structuredClone(messages) as T[];
  stripReplayParts(copy);
  return copy;
}

export function sessionForPresentation<T extends { messages: readonly unknown[] }>(session: T | null): T | null {
  if (session === null) return null;
  const copy = structuredClone(session);
  stripReplayParts(copy.messages);
  return copy;
}

export function messageWindowForPresentation<T extends { messages: readonly unknown[] }>(window: T | null): T | null {
  return sessionForPresentation(window);
}

export function sessionTailForPresentation<T extends { session: { messages: readonly unknown[] } }>(tail: T | null): T | null {
  if (tail === null) return null;
  const copy = structuredClone(tail);
  stripReplayParts(copy.session.messages);
  return copy;
}

export function subagentDetailForPresentation<T extends { messages: readonly unknown[] }>(detail: T | null): T | null {
  return sessionForPresentation(detail);
}
