
type ToolCallAbortEntry = {
  sessionId: string;
  controller: AbortController;
};

const active = new Map<string, ToolCallAbortEntry>();

export function registerToolCallAbort(
  sessionId: string,
  toolCallId: string,
  controller: AbortController,
): void {
  active.set(toolCallId, { sessionId, controller });
}

export function unregisterToolCallAbort(toolCallId: string): void {
  active.delete(toolCallId);
}

export function abortToolCall(sessionId: string, toolCallId: string): boolean {
  const entry = active.get(toolCallId);
  if (!entry || entry.sessionId !== sessionId) return false;
  if (entry.controller.signal.aborted) return false;
  entry.controller.abort();
  return true;
}
