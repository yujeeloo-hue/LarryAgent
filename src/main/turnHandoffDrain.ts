/**
 * Pure drain decision for a queued turn_handoff, evaluated in the turn
 * `finally` (sessionRuntime `drainQueuedHandoff`). Extracted as a pure
 * function so the fail-stop decision table is unit-testable without
 * booting the session runtime.
 *
 * Fail-stop with visibility: every non-null return becomes a persisted
 * system message in the transcript, so a dropped handoff is always
 * explainable after the fact.
 */

import type { SessionStatus } from "../session/types.js";
import { TURN_HANDOFF_CHAIN_DEPTH_CAP } from "../tools/turnHandoffTool.js";

export { TURN_HANDOFF_CHAIN_DEPTH_CAP };

export type HandoffDrainDecisionInput = {
  /** A queued plan approval (user action) was drained first — user wins. */
  planApprovalTookPrecedence: boolean;
  /**
   * A queued user prompt started the follow-up turn instead — same rule as a
   * plan approval: real user input always beats a self-scheduled handoff.
   */
  promptQueueTookPrecedence?: boolean;
  /** Terminal status of the just-finished turn ("idle" = completed). */
  status: SessionStatus;
  /** Session gate at drain time (composer Self Learning toggle). */
  handoffEnabled: boolean | null | undefined;
  /** Consecutive handoff-chained turns so far. */
  chainDepth: number;
};

/**
 * Returns the human-readable drop reason, or null when the drain may
 * proceed to the async graph re-check + follow-up start.
 */
export function handoffDrainDropReason(
  input: HandoffDrainDecisionInput,
): string | null {
  if (input.planApprovalTookPrecedence) {
    return "Turn handoff dropped: a queued plan approval ran instead (user input always wins over a queued handoff).";
  }
  if (input.promptQueueTookPrecedence === true) {
    return "Turn handoff dropped: a queued user message started the next turn instead (user input always wins over a queued handoff).";
  }
  if (input.status !== "idle") {
    return `Turn handoff dropped: the turn did not complete cleanly (status: ${input.status}). Only completed turns hand off.`;
  }
  if (input.handoffEnabled !== true) {
    return "Turn handoff dropped: Turn Handoff was disabled (composer → Self Learning) before this turn ended.";
  }
  if (input.chainDepth >= TURN_HANDOFF_CHAIN_DEPTH_CAP) {
    return `Turn handoff dropped: handoff chain depth cap (${TURN_HANDOFF_CHAIN_DEPTH_CAP}) reached — send a message to take over.`;
  }
  return null;
}
