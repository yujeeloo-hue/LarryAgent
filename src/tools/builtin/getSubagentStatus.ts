import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";

export const getSubagentStatusDefinition: ToolDefinition = {
  name: "get_subagent_status",
  description: "Return non-blocking status for subagents on this turn.",
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Optional subset of subagent ids.",
      },
    },
  },
  defaultPermissionLevel: 0,
};

export const getSubagentStatusHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  if (!context.subagents) {
    return failureResult(
      "Subagent status is not available in this turn.",
      ToolReturnCode.GenericFailure,
    );
  }

  let ids: string[] | undefined;
  if (args.ids !== undefined) {
    if (!Array.isArray(args.ids)) {
      return failureResult(
        "ids must be an array of strings when provided.",
        ToolReturnCode.InvalidArguments,
      );
    }
    ids = [];
    for (const item of args.ids) {
      if (typeof item !== "string" || !item.trim()) {
        return failureResult(
          "ids must be an array of non-empty strings.",
          ToolReturnCode.InvalidArguments,
        );
      }
      ids.push(item.trim());
    }
  }

  const snaps = context.subagents.getStatus(ids);
  if (snaps.length === 0) {
    return textResult("No matching subagents.", ToolReturnCode.Success);
  }

  const lines = snaps.map((s) => {
    const progress = s.progressText ? ` progress="${s.progressText}"` : "";
    return `${s.id} "${s.name}" role=${s.role} priority=${s.priority} status=${s.status}${progress}`;
  });
  return textResult(lines.join("\n"), ToolReturnCode.Success);
};
