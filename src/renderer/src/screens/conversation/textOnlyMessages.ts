/** Display automatic remarks as speech; keep native records intact for replay. */
export function textOnlyMessages<T extends { id?: string; role: string; parts: Array<Record<string, unknown>> }>(messages: T[], ids: ReadonlySet<string>): T[] {
  if (!ids.size) return messages;
  const toolIds = new Set(messages.filter(m => m.id && ids.has(m.id)).flatMap(m => m.parts.filter(p => p.type === "tool_call").map(p => p.id)));
  return messages.flatMap(message => {
    if (message.role === "tool" && message.parts.some(p => toolIds.has(p.toolCallId))) return [];
    if (message.role !== "assistant" || !message.id || !ids.has(message.id)) return [message];
    const parts = message.parts.filter(p => p.type === "text");
    return parts.length ? [{ ...message, parts }] : [];
  });
}

/**
 * Turn-start ids after a display filter. When the filter hid a turn's first
 * message (a reasoning-only automatic round), the turn starts at its first
 * shown message instead. A user prompt reached first means the turn showed nothing.
 */
export function shownTurnStarts<T extends { id?: string; role: string }>(original: T[], shown: T[], starts: ReadonlySet<string>): Set<string> {
  if (!starts.size) return new Set();
  const visible = new Set(shown.flatMap(m => m.id ? [m.id] : []));
  const out = new Set<string>();
  original.forEach((message, index) => {
    if (!message.id || !starts.has(message.id)) return;
    for (let i = index; i < original.length; i += 1) {
      const candidate = original[i]!;
      if (candidate.role === "user") return;
      if (candidate.id && visible.has(candidate.id)) { out.add(candidate.id); return; }
    }
  });
  return out;
}
