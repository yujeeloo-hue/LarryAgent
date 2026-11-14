/**
 * Pure resolver for what the composer's submit gesture (Enter / send-button
 * click) should do in the conversation view. Verbatim port of the desktop
 * promptQueueGesture.ts so Mac and web behave identically — kept pure so the
 * queue-vs-send matrix stays unit-testable.
 *
 * The rule set, in words:
 * - Nothing running → Enter sends normally.
 * - Turn running + composer has content → queue it (default: after the turn).
 * - Turn running + empty composer + queue has waiting items → Enter is the
 *   keyboard shortcut for "insert now" on the head item (the same action as
 *   the row's Insert now button).
 * - Turn running + empty composer + nothing waiting → Stop the turn.
 */

export type ComposerSubmitContext = {
  /** Composer has text and/or attachments. */
  hasContent: boolean;
  /** A turn is in flight for this session. */
  running: boolean;
  /** Queue holds at least one item that is not armed yet (mode "deferred"). */
  queueHasDeferred: boolean;
};

export type ComposerSubmitAction =
  /** Start a normal turn from the composer content. */
  | "send"
  /** Append composer content to the queue (deferred). */
  | "enqueue"
  /** Arm the head deferred queue item for mid-turn insertion. */
  | "promote-head"
  /** Cancel the running turn. */
  | "stop"
  /** Ignore the gesture. */
  | "noop";

export function resolveComposerSubmitAction(
  context: ComposerSubmitContext,
): ComposerSubmitAction {
  if (!context.running) {
    return context.hasContent ? "send" : "noop";
  }
  if (context.hasContent) return "enqueue";
  // Empty composer while running: promote first, Stop only when the queue has
  // nothing waiting. Stop stays reachable — it is just one Enter later.
  return context.queueHasDeferred ? "promote-head" : "stop";
}
