/**
 * Neutral contracts shared by NodeActions and tools.
 * Must not import fsm, Host, or tool handlers.
 */

import type { Phase } from "../../session/phase.js";
import type { SessionPlan, SessionPlanDoc } from "../../session/types.js";
import type { RoleKind } from "../roles/types.js";

export type ControlIntent = "approve" | "discard";

export type PresentationPolicy = {
  cardVisible?: boolean;
};

export type SessionPatch = {
  plan?: SessionPlan | null;
  planDoc?: SessionPlanDoc | null;
  phase?: Phase | null;
};

/**
 * Control signal from a successful tool for EmitRouteEvent (flush → nodeContext).
 * Event strings only — never a next-node id.
 */
export type RouteEventPatch = {
  event: string;
  source?: "fsm_route" | "tool";
};

export type ResolveResumeRoleInput = {
  /** Opaque session phase string (no built-in phase vocabulary). */
  phase?: string | null;
  /** phase → role id map from graph params. */
  map: Readonly<Record<string, string>>;
  /** Phases that only resume when the plan is still incomplete. */
  requireIncompletePlan: ReadonlySet<string> | readonly string[];
  hasIncompletePlan: boolean;
  fallback: RoleKind;
};

export type ResolveResumeRoleResult = {
  role: RoleKind;
  /**
   * True when phase was in requireIncompletePlan but the plan is complete —
   * caller may clear session.phase when configured to do so.
   */
  skippedIncompletePlan: boolean;
};

