import { ToolReturnCode } from "../../session/returnCodes.js";
import { getTool } from "../registry.js";
import {
  deferredNameSet,
  isBridgeInScope,
  type ToolBridgeScope,
} from "../toolBridge.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";

/** Default level: 0 — discovery meta-tool; always offered. */
export const toolDescribeDefinition: ToolDefinition = {
  name: "tool_describe",
  description:
    "Load the full JSON schema for one deferred tool (not in the current tools array). Then call it via tool_call.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Exact tool name from search_tools (or known deferred name).",
      },
    },
    required: ["name"],
  },
  defaultPermissionLevel: 0,
};

export const toolDescribeHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    return failureResult(
      'Invalid arguments: "name" (non-empty string) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const scope = context.bridgeScope as ToolBridgeScope | undefined;
  const deferred = deferredNameSet(scope ? { scope } : undefined);
  if (!deferred.has(name)) {
    if (!isBridgeInScope(name, scope)) {
      return failureResult(
        `Tool ${JSON.stringify(name)} is not allowed in this turn's bridge scope.`,
        ToolReturnCode.PermissionDenied,
      );
    }
    return failureResult(
      `Tool ${JSON.stringify(name)} is not deferred (already in tools[], unknown, or not registered). Use it directly if offered, or search_tools for deferred tools.`,
      ToolReturnCode.NotFound,
    );
  }

  const registered = getTool(name);
  if (!registered) {
    return failureResult(
      `Unknown tool: ${name}`,
      ToolReturnCode.NotFound,
    );
  }

  const def = registered.definition;
  const payload = {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
  };

  return textResult(
    [
      `Schema for ${def.name}. Invoke with tool_call({ name: ${JSON.stringify(def.name)}, arguments: { … } }).`,
      "",
      JSON.stringify(payload, null, 2),
    ].join("\n"),
    ToolReturnCode.Success,
  );
};
