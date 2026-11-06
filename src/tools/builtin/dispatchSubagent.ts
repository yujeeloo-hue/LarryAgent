import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";
import {
  normalizeSubagentPriority,
  normalizeSubagentRole,
} from "../../agent/subagents/constants.js";

export const dispatchSubagentDefinition: ToolDefinition = {
  name: "dispatch_subagent",
  description:
    "Start a background subagent; returns id immediately. Same batch_id groups parallel work.",
  parameters: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "Full task instructions for the subagent.",
      },
      batch_id: {
        type: "string",
        description: "Join group id; same batch finishes together.",
      },
      name: {
        type: "string",
        description: "Optional short nickname for UI/logs.",
      },
      role: {
        type: "string",
        description: 'Optional: "general" (default), "explore", or "worker".',
      },
      priority: {
        type: "number",
        description: "Queue priority 0–100 (default 50); higher starts sooner.",
      },
    },
    required: ["prompt", "batch_id"],
  },
  defaultPermissionLevel: 0,
};

export const dispatchSubagentHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  if (!context.subagents) {
    return failureResult(
      "Subagent dispatch is not available in this turn.",
      ToolReturnCode.GenericFailure,
    );
  }

  const prompt = typeof args.prompt === "string" ? args.prompt : "";
  const batchId = typeof args.batch_id === "string" ? args.batch_id : "";
  const nameRaw = typeof args.name === "string" ? args.name : undefined;
  const role = normalizeSubagentRole(args.role);
  const priority = normalizeSubagentPriority(args.priority);
  const toolCallId = context.toolCallId?.trim() ?? "";

  const result = context.subagents.dispatch({
    prompt,
    batchId,
    ...(nameRaw !== undefined ? { name: nameRaw } : {}),
    role,
    priority,
    parentToolCallId: toolCallId,
  });

  if (!result.ok) {
    return failureResult(result.message, result.returnCode);
  }

  return textResult(
    `Dispatched subagent "${result.name}" (id=${result.id}, batch_id=${result.batchId}, priority=${result.priority}). status=${result.status}.`,
    ToolReturnCode.Success,
  );
};
