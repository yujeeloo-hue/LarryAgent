import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult } from "../pathUtil.js";

/**
 * Bridge entry for deferred tools. Runtime unwraps this in runTools before
 * permissions/hooks/handler — this handler is a safety net only.
 */
export const toolCallDefinition: ToolDefinition = {
  name: "tool_call",
  description:
    "Invoke a deferred tool by name with a JSON arguments object. Prefer tool_describe first for the schema. Do not use for tools already present in the tools array (call those directly). arguments must be a JSON object matching that tool's schema.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Exact deferred tool name (not an eager tools[] entry).",
      },
      arguments: {
        type: "object",
        description:
          "Arguments object for the underlying tool (must match its schema from tool_describe).",
      },
    },
    required: ["name", "arguments"],
  },
  defaultPermissionLevel: 0,
};

export const toolCallHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;
  void args;
  void context;
  return failureResult(
    "tool_call must be unwrapped by the runtime before execution.",
    ToolReturnCode.GenericFailure,
  );
};
