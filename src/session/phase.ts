/**
 * Session workflow phase (opaque string).
 * Primary store: session FSM blackboard key `phase` (see sessionPhase.ts).
 * Vocabulary comes from graph params (Write blackboard / approveSetPhase),
 * not from a fixed enum in code.
 */

/** Opaque workflow phase key (graph-configured). */
export type Phase = string;

/** @deprecated Use {@link Phase}. */
export type PlanPhase = Phase;

/**
 * Normalize a persisted / param phase value.
 * Empty / whitespace → null. Any other non-empty string is kept as-is.
 */
export function parsePhase(raw: unknown): Phase | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value.length > 0 ? value : null;
}

export function isPhase(value: string | null | undefined): value is Phase {
  return typeof value === "string" && value.trim().length > 0;
}

