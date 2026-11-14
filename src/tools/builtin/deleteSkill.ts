import { skillManager } from "../../skills/manager.js";
import { resolveSkillRef } from "../../skills/toolHelpers.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { skillMutationContext } from "./skillWrite.js";

/** Default level: 1 (full-permissions gate). */
export const deleteSkillDefinition: ToolDefinition = {
  name: "delete_skill",
  description: "Delete a skill package by id or name.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Skill id (preferred when known).",
      },
      name: {
        type: "string",
        description: "Skill name when id is unknown.",
      },
    },
    required: [],
  },
  defaultPermissionLevel: 1,
};

export const deleteSkillHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const idArg = typeof args.id === "string" ? args.id.trim() : "";
  const nameArg = typeof args.name === "string" ? args.name.trim() : "";
  const ref = idArg || nameArg;
  if (!ref) {
    return failureResult(
      'Invalid arguments: provide "id" or "name" to identify the skill.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const resolved = resolveSkillRef(ref);
  if (!resolved.ok) {
    const code =
      resolved.returnCodeHint === "not_found"
        ? ToolReturnCode.NotFound
        : ToolReturnCode.InvalidArguments;
    return failureResult(resolved.message, code);
  }

  const { id, name } = resolved.record;
  if (context.skillWritePolicy === "auto_owned_only") {
    return failureResult(
      `Automatic skill maintenance never deletes skills. Use deprecate_skill for "${name}" instead.`,
      ToolReturnCode.PermissionDenied,
    );
  }
  try {
    await skillManager.removeSkill(id, skillMutationContext(context, undefined));
    try {
      await skillManager.reloadFromDisk();
    } catch (err) {
      console.error("[skills] reloadFromDisk failed after delete", err);
    }
    return textResult(
      `Deleted skill "${name}" (${id}).`,
      ToolReturnCode.Success,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to delete skill.";
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
