/**
 * Per-tool-call abort registry.
 *
 * `runTools` forks a child AbortController from the turn signal for each tool
 * call and registers it here, so the renderer can stop a single running tool
 * (e.g. a hanging `run_shell`) without cancelling the whole turn. The turn
 * signal still cascades into the child: cancelling the turn aborts any
 * in-flight tool.
 */

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

/**
 * Abort one running tool call by id. Returns true only when the call was
 * registered for the given session and was not already aborted (idempotent).
 */
export function abortToolCall(sessionId: string, toolCallId: string): boolean {
  const entry = active.get(toolCallId);
  if (!entry || entry.sessionId !== sessionId) return false;
  if (entry.controller.signal.aborted) return false;
  entry.controller.abort();
  return true;
}
