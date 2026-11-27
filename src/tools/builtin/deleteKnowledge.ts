import { knowledgeBase } from "../../knowledge/store.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult } from "../pathUtil.js";
import {
  KNOWLEDGE_REASON_PROPERTY,
  knowledgeDeleteResult,
  knowledgeReason,
  knowledgeUnavailable,
  missingReasonResult,
  stringArg,
} from "./knowledgeArgs.js";

export const deleteKnowledgeDefinition: ToolDefinition = {
  name: "delete_knowledge",
  description:
    "Delete a user-layer knowledge doc. On an override this restores the built-in version. Built-in docs cannot be deleted.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      reason: KNOWLEDGE_REASON_PROPERTY,
    },
    required: ["id", "reason"],
  },
  defaultPermissionLevel: 0,
};

export const deleteKnowledgeHandler: ToolHandler = async (args, context) => {
  const blocked = abortIfSignaled(context.signal) ?? knowledgeUnavailable();
  if (blocked) return blocked;
  const reason = knowledgeReason(args);
  if (!reason) return missingReasonResult();
  const id = stringArg(args, "id")?.trim() ?? "";
  if (!id) return failureResult('Invalid arguments: "id" is required.', ToolReturnCode.InvalidArguments);
  return knowledgeDeleteResult(reason, context.sessionId, knowledgeBase.delete(id));
};
