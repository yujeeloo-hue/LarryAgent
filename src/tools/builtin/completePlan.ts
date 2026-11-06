import {
  PLAN_TITLE_MAX,
  clipTitle,
  finalizeIncompleteSteps,
  formatPlanSummary,
  isActivePlan,
} from "../../session/plan.js";
import type { SessionPlan } from "../../session/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";

/** Default level: 0 — finish the active multi-step plan. */
export const completePlanDefinition: ToolDefinition = {
  name: "complete_plan",
  description:
    "Mark the active plan completed or cancelled.",
  parameters: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["completed", "cancelled"],
        description: "Final plan status.",
      },
      summary: {
        type: "string",
        description: "Optional one-line wrap-up for the plan card.",
      },
    },
    required: ["status"],
  },
  defaultPermissionLevel: 0,
};

export const completePlanHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const current = context.planSnapshot ?? null;
  if (!isActivePlan(current) || !current) {
    return failureResult(
      "No active plan to complete.",
      ToolReturnCode.NotFound,
    );
  }

  if (args.status !== "completed" && args.status !== "cancelled") {
    return failureResult(
      'Invalid arguments: "status" must be completed or cancelled.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const summary =
    typeof args.summary === "string" && args.summary.trim().length > 0
      ? clipTitle(args.summary, PLAN_TITLE_MAX)
      : undefined;

  const plan: SessionPlan = {
    ...current,
    status: args.status,
    steps: finalizeIncompleteSteps(current.steps, args.status),
    updatedAt: Date.now(),
    ...(summary ? { summary } : {}),
  };

  return {
    ...textResult(formatPlanSummary(plan), ToolReturnCode.Success),
    sessionPatch: { plan, phase: null, planDoc: null },
  };
};
