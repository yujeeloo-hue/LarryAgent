import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";

/** Permission 0 — Executor signals block → orchestrator hand_off to Replanner. */
export const reportStepBlockedDefinition: ToolDefinition = {
  name: "report_step_blocked",
  description:
    "Report that the current plan step is blocked and needs replanning.",
  parameters: {
    type: "object",
    properties: {
      step_id: {
        type: "string",
        description: "Id of the blocked step (e.g. s2).",
      },
      error: {
        type: "string",
        description: "Short error summary.",
      },
      observed: {
        type: "string",
        description: "Optional details about what was tried or seen.",
      },
    },
    required: ["step_id", "error"],
  },
  defaultPermissionLevel: 0,
};

export const reportStepBlockedHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const stepId =
    typeof args.step_id === "string" ? args.step_id.trim() : "";
  const error = typeof args.error === "string" ? args.error.trim() : "";
  const observed =
    typeof args.observed === "string" ? args.observed.trim() : "";
  if (!stepId || !error) {
    return failureResult(
      'Invalid arguments: "step_id" and "error" are required.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const reason = observed
    ? `step ${stepId}: ${error} (${observed})`
    : `step ${stepId}: ${error}`;

  return {
    ...textResult(
      `Blocked: ${reason}\nblock_reason:${reason}`,
      ToolReturnCode.Success,
    ),
    routeEvent: { event: "step_blocked", source: "tool" },
  };
};
