
export const HEADLESS_ASK_CANCELLED_TEXT =
  "A background Loop run cannot take interactive input; this prompt was auto-cancelled";

export type AskAwaitDecision =
  | { kind: "wait" }
  | { kind: "auto-settle"; answer: null; note: string };

export function resolveAskAwait(input: {
  headless: boolean;
}): AskAwaitDecision {
  return input.headless
    ? { kind: "auto-settle", answer: null, note: HEADLESS_ASK_CANCELLED_TEXT }
    : { kind: "wait" };
}
