
import {
  areStepDepsSatisfied,
  stepByIdMap,
  unsatisfiedDepIds,
} from "../../session/plan.js";
import type { PlanStep } from "../../session/types.js";

export type StepClaimGroup = {
  stepIds: string[];
};

export type StepCommitVerifyOutcome =
  | { ok: true; verifiedStepIds: string[] }
  | { ok: false; failedStepId: string; waitingOn: string[] };

export function verifyStepCommitGroup(
  stepIds: string[],
  planSteps: PlanStep[],
): StepCommitVerifyOutcome {
  if (!stepIds.length) {
    return { ok: false, failedStepId: "", waitingOn: [] };
  }

  for (const id of stepIds) {
    const step = stepByIdMap(planSteps).get(id);
    if (!step || step.status !== "completed") {
      return { ok: false, failedStepId: id, waitingOn: [] };
    }
    if (!areStepDepsSatisfied(step, planSteps)) {
      return {
        ok: false,
        failedStepId: id,
        waitingOn: unsatisfiedDepIds(step, planSteps),
      };
    }
  }

  return { ok: true, verifiedStepIds: [...stepIds] };
}

export function buildStepClaimGroups(
  completedIds: string[],
  planSteps: PlanStep[],
): StepClaimGroup[] {
  if (!completedIds.length || !planSteps.length) return [];
  const wanted = new Set(completedIds);
  const ids = planSteps
    .filter((step) => wanted.has(step.id) && step.status === "completed")
    .map((step) => step.id);
  if (!ids.length) return [];
  return [{ stepIds: ids }];
}
