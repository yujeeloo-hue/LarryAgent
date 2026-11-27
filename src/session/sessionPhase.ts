
import { parsePhase, type Phase } from "./phase.js";

export const SESSION_PHASE_BLACKBOARD_KEY = "phase";

export type SessionPhaseSource = {
  fsmBlackboard?: Record<string, unknown> | null;
  phase?: Phase | null;
};

export function getSessionPhase(session: SessionPhaseSource): Phase | null {
  const fromBb = parsePhase(
    session.fsmBlackboard?.[SESSION_PHASE_BLACKBOARD_KEY],
  );
  if (fromBb) return fromBb;
  return parsePhase(session.phase);
}

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
