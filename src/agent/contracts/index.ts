
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

export type RouteEventPatch = {
  event: string;
  source?: "fsm_route" | "tool";
};

export type ResolveResumeRoleInput = {
  phase?: string | null;
  map: Readonly<Record<string, string>>;
  requireIncompletePlan: ReadonlySet<string> | readonly string[];
  hasIncompletePlan: boolean;
  fallback: RoleKind;
};

export type ResolveResumeRoleResult = {
  role: RoleKind;
  skippedIncompletePlan: boolean;
};

