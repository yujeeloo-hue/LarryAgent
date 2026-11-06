/**
 * Headless (background Loops daemon) turns have no renderer to answer
 * ask_user prompts. Policy: never wait — settle the pending ask immediately
 * with a cancel-equivalent answer (the exact settle path respondUserAsk uses
 * for a user cancel) so the turn keeps running to completion instead of
 * hanging forever.
 */

/** Canonical note surfaced in tool results when an ask is auto-cancelled. */
export const HEADLESS_ASK_CANCELLED_TEXT =
  "A background Loop run cannot take interactive input; this prompt was auto-cancelled";

export type AskAwaitDecision =
  | { kind: "wait" }
  | { kind: "auto-settle"; answer: null; note: string };

/**
 * Pure policy for a pending ask_user: interactive turns wait for the
 * renderer; headless turns auto-settle as cancelled (`answer: null`).
 */
export function resolveAskAwait(input: {
  headless: boolean;
}): AskAwaitDecision {
  return input.headless
    ? { kind: "auto-settle", answer: null, note: HEADLESS_ASK_CANCELLED_TEXT }
    : { kind: "wait" };
}
