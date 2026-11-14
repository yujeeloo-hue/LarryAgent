/**
 * Plan-execute Step FSM helpers.
 */

import type { JsonObject, PlanStep, ToolCallPart } from "../../session/types.js";
import type { RoleContext } from "../roles/types.js";
import type { PlanFacade } from "../roles/PlanFacade.js";
import type { StepFsmPatch, StepFsmSnapshot, StepPhase } from "./graphState.js";
import { buildStepClaimGroups } from "./verifyStepCommit.js";

export type { StepClaimGroup } from "./verifyStepCommit.js";

export function syncStepFieldsFromPlan(
  plan: PlanFacade,
): StepFsmPatch {
  const step = plan.currentStep();
  return {
    stepPhase: (step ? "working" : "idle") as StepPhase,
    currentStepId: step?.id ?? null,
    pendingVerifyStepIds: [],
    verifyResult: null,
  };
}

function findCompletedStepIdsClaimedInUpdatePlan(
  toolCalls: ToolCallPart[],
  planSteps: PlanStep[] | null | undefined,
): string[] {
  if (!planSteps?.length) return [];

  const claimed = new Set<string>();
  for (const call of toolCalls) {
    if (call.name !== "update_plan") continue;
    const rawSteps = call.arguments.steps;
    if (!Array.isArray(rawSteps)) continue;
    for (const raw of rawSteps) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const entry = raw as JsonObject;
      if (entry.status !== "completed") continue;
      const id =
        typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : "";
      if (!id) continue;
      const step = planSteps.find((s) => s.id === id);
      if (step?.status === "completed") claimed.add(id);
    }
  }

  return planSteps.filter((s) => claimed.has(s.id)).map((s) => s.id);
}

export function detectExecutorStepClaim(
  state: Pick<StepFsmSnapshot, "activeRole">,
  ctx: RoleContext,
  toolCalls: ToolCallPart[],
): StepFsmPatch | null {
  if (state.activeRole !== "executor") {
    return null;
  }
  if (toolCalls.some((c) => c.name === "complete_plan")) {
    return null;
  }
  if (toolCalls.some((c) => c.name === "report_step_blocked")) {
    return {
      stepPhase: "idle" as StepPhase,
      pendingVerifyStepIds: [],
      verifyResult: null,
    };
  }

  if (!toolCalls.some((c) => c.name === "update_plan")) return null;

  const plan = ctx.plan.get();
  const completedIds = findCompletedStepIdsClaimedInUpdatePlan(
    toolCalls,
    plan?.steps ?? null,
  );
  if (!completedIds.length) return null;

  const groups = buildStepClaimGroups(completedIds, plan?.steps ?? []);
  if (!groups.length) return null;

  const active = groups[0];
  if (!active?.stepIds.length) return null;

  return {
    stepPhase: "awaiting_verify" as StepPhase,
    pendingVerifyStepIds: active.stepIds,
    verifyResult: null,
  };
}
