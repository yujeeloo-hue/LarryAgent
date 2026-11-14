import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";

export const stopSubagentDefinition: ToolDefinition = {
  name: "stop_subagent",
  description: "Cancel one or more running subagents by id.",
  parameters: {
    type: "object",
    properties: {
      ids: {
        type: "array",
        items: { type: "string" },
        description: "Subagent ids to stop (≥1).",
      },
    },
    required: ["ids"],
  },
  defaultPermissionLevel: 0,
};

export const stopSubagentHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  if (!context.subagents) {
    return failureResult(
      "Subagent stop is not available in this turn.",
      ToolReturnCode.GenericFailure,
    );
  }

  if (!Array.isArray(args.ids) || args.ids.length === 0) {
    return failureResult(
      "ids must be a non-empty array of strings.",
      ToolReturnCode.InvalidArguments,
    );
  }

  const ids: string[] = [];
  for (const item of args.ids) {
    if (typeof item !== "string" || !item.trim()) {
      return failureResult(
        "ids must be a non-empty array of strings.",
        ToolReturnCode.InvalidArguments,
      );
    }
    ids.push(item.trim());
  }

  const results = context.subagents.stop(ids);
  const lines = results.map(
    (r) =>
      `${r.id} (${r.name}): ${r.stopped ? "stopped" : "not stopped"} (${r.status}) — ${r.message}`,
  );
  const anyUnknown = results.some((r) => r.message.includes("Unknown"));
  return textResult(
    lines.join("\n"),
    anyUnknown ? ToolReturnCode.NotFound : ToolReturnCode.Success,
  );
};
