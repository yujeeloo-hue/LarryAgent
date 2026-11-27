import { knowledgeBase } from "../../knowledge/store.js";
import { KNOWLEDGE_PATCH_EDITS_MAX } from "../../knowledge/limits.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { JsonObject, ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult } from "../pathUtil.js";
import {
  KNOWLEDGE_KEYWORDS_PROPERTY,
  KNOWLEDGE_REASON_PROPERTY,
  knowledgeMutationResult,
  knowledgeReason,
  knowledgeUnavailable,
  missingReasonResult,
  stringArg,
  stringListArg,
} from "./knowledgeArgs.js";

export const patchKnowledgeDefinition: ToolDefinition = {
  name: "patch_knowledge",
  description:
    "Edit part of a knowledge-base doc: each old_string must appear exactly once in the current body (copy it from read_knowledge). Patching a built-in doc creates an override.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      edits: {
        type: "array",
        minItems: 1,
        maxItems: KNOWLEDGE_PATCH_EDITS_MAX,
        items: {
          type: "object",
          properties: { old_string: { type: "string" }, new_string: { type: "string" } },
          required: ["old_string", "new_string"],
        },
      },
      summary: { type: "string", description: "Optional new summary." },
      keywords: { ...KNOWLEDGE_KEYWORDS_PROPERTY, description: "Optional full replacement keyword list." },
      reason: KNOWLEDGE_REASON_PROPERTY,
    },
    required: ["id", "edits", "reason"],
  },
  defaultPermissionLevel: 0,
};

export const patchKnowledgeHandler: ToolHandler = async (args, context) => {
  const blocked = abortIfSignaled(context.signal) ?? knowledgeUnavailable();
  if (blocked) return blocked;
  const reason = knowledgeReason(args);
  if (!reason) return missingReasonResult();
  const id = stringArg(args, "id")?.trim() ?? "";
  const rawEdits = Array.isArray(args.edits) ? args.edits : [];
  const edits: Array<{ oldString: string; newString: string }> = [];
  for (const [index, raw] of rawEdits.entries()) {
    const edit = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as JsonObject) : null;
    if (!edit || typeof edit.old_string !== "string" || typeof edit.new_string !== "string") {
      return failureResult(
        `Invalid arguments: edits[${index}] needs old_string and new_string strings.`,
        ToolReturnCode.InvalidArguments,
      );
    }
    edits.push({ oldString: edit.old_string, newString: edit.new_string });
  }
  if (!id || edits.length === 0) {
    return failureResult('Invalid arguments: "id" and at least one edit are required.', ToolReturnCode.InvalidArguments);
  }
  const summary = stringArg(args, "summary");
  const keywords = stringListArg(args, "keywords");
  const result = knowledgeBase.patch({
    id,
    edits,
    ...(summary !== undefined ? { summary } : {}),
    ...(keywords ? { keywords } : {}),
  });
  return knowledgeMutationResult("patch_knowledge", reason, context.sessionId, result);
};
