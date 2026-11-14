/**
 * Retry consumes the turn error message.
 *
 * Clicking Retry on an error card means "continue the task": the follow-up
 * turn submits a hidden continuation prompt (RETRY_CONTINUATION_PROMPT), so
 * the failed turn's user prompt and partial work must STAY in the transcript
 * — the model picks up from the recorded state instead of redoing the task
 * from a resent prompt. Only the error row itself is removed (it must not
 * resurface on the next transcript render).
 *
 * Pure transcript surgery — no IPC, no broadcast; the caller persists and
 * notifies.
 */
import { isTurnErrorMessage } from "../session/turnErrorText.js";
import type { Session } from "../session/types.js";

/**
 * Remove the error system message with `messageId` (idempotent: an already
 * missing id removes nothing). Mutates `session.messages` in place.
 */
export function consumeTurnErrorMessage(
  session: Session,
  messageId: string,
): { removed: boolean } {
  const errorIndex = session.messages.findIndex(
    (message) => message.id === messageId && isTurnErrorMessage(message),
  );
  if (errorIndex < 0) return { removed: false };
  session.messages.splice(errorIndex, 1);
  return { removed: true };
}
