import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";

export const listSubagentsDefinition: ToolDefinition = {
  name: "list_subagents",
  description: "List subagents created during this parent turn.",
  parameters: {
    type: "object",
    properties: {
      include_finished: {
        type: "boolean",
        description: "Include completed/error/cancelled runs (default false).",
      },
    },
  },
  defaultPermissionLevel: 0,
};

export const listSubagentsHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  if (!context.subagents) {
    return failureResult(
      "Subagent list is not available in this turn.",
      ToolReturnCode.GenericFailure,
    );
  }

  const includeFinished = args.include_finished === true;
  const snaps = context.subagents.list(includeFinished);
  if (snaps.length === 0) {
    return textResult(
      includeFinished ? "No subagents this turn." : "No active subagents.",
      ToolReturnCode.Success,
    );
  }

  const lines = snaps.map(
    (s) =>
      `${s.id} "${s.name}" role=${s.role} priority=${s.priority} status=${s.status}` +
      (s.progressText ? ` · ${s.progressText}` : ""),
  );
  return textResult(lines.join("\n"), ToolReturnCode.Success);
};
