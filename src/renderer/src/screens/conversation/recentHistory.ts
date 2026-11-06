/** A display window only. Persisted history and model context are untouched. */
export function recentMessages<T extends { createdAt?: number }>(messages: T[], since?: number): T[] {
  return since === undefined ? messages : messages.filter(m => typeof m.createdAt === "number" && m.createdAt >= since);
}

export async function recentSessionTail(bridge: Pick<NonNullable<Window["jellybot"]>, "getSessionTail" | "getMessagesBefore">, sessionId: string, since: number): Promise<SessionTailResult | null> {
  const tail = await bridge.getSessionTail(sessionId);
  if (!tail) return null;
  let messages = tail.session.messages;
  let page = tail.window;
  const seen = new Set<string>();
  // Load every page that overlaps the hour, including assistant-only notices.
  while (page.hasMore && messages.every(m => m.createdAt >= since)) {
    const cursor = page.firstMessageId;
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
    const earlier = await bridge.getMessagesBefore(sessionId, cursor);
    if (!earlier) break;
    messages = [...earlier.messages, ...messages];
    page = earlier;
  }
  messages = recentMessages(messages, since);
  return { session: { ...tail.session, messages }, window: { ...tail.window, firstMessageId: messages[0]?.id ?? null, hasMore: false, remainingTurns: 0 } };
}
