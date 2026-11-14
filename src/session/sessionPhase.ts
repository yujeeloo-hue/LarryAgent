/**
 * Workflow phase lives on the session FSM blackboard (key {@link SESSION_PHASE_BLACKBOARD_KEY}),
 * not as a dedicated Session column primary. Legacy `Session.phase` may still be
 * mirrored for DB load migration / older in-memory fixtures.
 */

import { parsePhase, type Phase } from "./phase.js";

/** Reserved session-blackboard key for plan_execute (and custom) workflow phase. */
export const SESSION_PHASE_BLACKBOARD_KEY = "phase";

export type SessionPhaseSource = {
  fsmBlackboard?: Record<string, unknown> | null;
  /** @deprecated Prefer fsmBlackboard.phase — kept for load migration / fixtures. */
  phase?: Phase | null;
};

/** Read workflow phase: blackboard first, then legacy Session.phase. */
export function getSessionPhase(session: SessionPhaseSource): Phase | null {
  const fromBb = parsePhase(
    session.fsmBlackboard?.[SESSION_PHASE_BLACKBOARD_KEY],
  );
  if (fromBb) return fromBb;
  return parsePhase(session.phase);
}

/**
 * Mutate `session.fsmBlackboard` (and legacy `session.phase` mirror) in place.
 * `null` clears the blackboard key. Does not persist — callers that own the
 * Host blackboardSet path should use that instead (or call this then persist).
 */
export function setSessionPhaseInMemory(
  session: {
    fsmBlackboard?: Record<string, unknown> | null;
    phase?: Phase | null;
  },
  phase: Phase | null,
): void {
  const next: Record<string, unknown> = {
    ...(session.fsmBlackboard ?? {}),
  };
  if (phase === null) {
    delete next[SESSION_PHASE_BLACKBOARD_KEY];
  } else {
    next[SESSION_PHASE_BLACKBOARD_KEY] = phase;
  }
  session.fsmBlackboard = Object.keys(next).length > 0 ? next : null;
  session.phase = phase;
}

/** Merge a legacy `sessions.phase` column value into a blackboard object. */
export function mergeLegacyPhaseColumnIntoBlackboard(
  blackboard: Record<string, unknown> | null,
  legacyPhaseColumn: unknown,
): Record<string, unknown> | null {
  const legacy = parsePhase(legacyPhaseColumn);
  if (!legacy) return blackboard;
  if (parsePhase(blackboard?.[SESSION_PHASE_BLACKBOARD_KEY])) {
    return blackboard;
  }
  return {
    ...(blackboard ?? {}),
    [SESSION_PHASE_BLACKBOARD_KEY]: legacy,
  };
}
