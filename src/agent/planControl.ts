import type { Session } from "../session/types.js";
import { getSessionPhase } from "../session/sessionPhase.js";

/** Prompt persisted on Approve; the executor Turn reuses it (no second copy). */
export const PLAN_APPROVE_PROMPT =
  "Approved. Create the execution checklist with create_plan, then begin executing.";

export type PlanControlGate =
  | { ok: true }
  | { ok: false; error: string };

export type ApproveTurnGateOptions = {
  /** When set, session blackboard phase must equal this value. */
  requirePhase?: string | null;
  /** When true, session.planDoc.path must be non-empty. */
  requirePlanDoc?: boolean;
  requireReviewedRevision?: boolean;
};

export function canStartApproveTurn(
  session: Session,
  options: ApproveTurnGateOptions = {},
): PlanControlGate {
  const requirePhase =
    typeof options.requirePhase === "string" && options.requirePhase.trim()
      ? options.requirePhase.trim()
      : null;
  if (requirePhase && getSessionPhase(session) !== requirePhase) {
    return { ok: false, error: "Plan is not awaiting review." };
  }
  if (options.requirePlanDoc !== false) {
    if (!session.planDoc?.path?.trim()) {
      return { ok: false, error: "Missing plan document." };
    }
  }
  if (options.requireReviewedRevision && session.planDoc?.revision && session.planDoc.reviewedRevision !== session.planDoc.revision) {
    return { ok: false, error: "The current plan document needs review before approval." };
  }
  return { ok: true };
}

export function canStartDiscardTurn(session: Session): PlanControlGate {
  if (!session.planDoc?.path?.trim() && !session.plan) {
    return { ok: false, error: "No plan to discard." };
  }
  return { ok: true };
}
