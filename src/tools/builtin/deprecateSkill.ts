import { skillManager } from "../../skills/manager.js";
import { resolveSkillRef } from "../../skills/toolHelpers.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { abortIfSignaled, failureResult } from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import {
  mustPropose,
  parseReason,
  proposeSkillChange,
  reasonParameter,
  reloadSkillsAfterWrite,
  skillMutationContext,
  skillWriteResult,
} from "./skillWrite.js";

/** Default level: 1 (full-permissions gate). */
export const deprecateSkillDefinition: ToolDefinition = {
  name: "deprecate_skill",
  description:
    "Retire a skill whose approach proved wrong or is covered elsewhere: marks it deprecated and disabled (files kept, reversible in Skills). Set superseded_by when another skill replaces it.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Skill id (preferred when known)." },
      name: { type: "string", description: "Skill name when id is omitted." },
      superseded_by: {
        type: "string",
        description: "Optional id or name of the replacement skill.",
      },
      reason: reasonParameter,
    },
    required: ["reason"],
  },
  defaultPermissionLevel: 1,
};

export const deprecateSkillHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const ref =
    (typeof args.id === "string" && args.id.trim()) ||
    (typeof args.name === "string" && args.name.trim()) ||
    "";
  if (!ref) {
    return failureResult(
      'Invalid arguments: provide "id" or "name" to identify the skill.',
      ToolReturnCode.InvalidArguments,
    );
  }
  const resolved = resolveSkillRef(ref);
  if (!resolved.ok) {
    return failureResult(
      resolved.message,
      resolved.returnCodeHint === "not_found" ? ToolReturnCode.NotFound : ToolReturnCode.InvalidArguments,
    );
  }
  const current = resolved.record;
  let successorId: string | undefined;
  const successorRef = typeof args.superseded_by === "string" ? args.superseded_by.trim() : "";
  if (successorRef) {
    const successor = resolveSkillRef(successorRef);
    if (!successor.ok) {
      return failureResult(
        `superseded_by: ${successor.message}`,
        successor.returnCodeHint === "not_found" ? ToolReturnCode.NotFound : ToolReturnCode.InvalidArguments,
      );
    }
    if (successor.record.id === current.id) {
      return failureResult("A skill cannot supersede itself.", ToolReturnCode.InvalidArguments);
    }
    successorId = successor.record.id;
  }

  const reason = parseReason(args.reason);
  try {
    if (mustPropose(context, [current])) {
      return await proposeSkillChange(context, {
        action: "deprecate",
        payload: {
          kind: "deprecate",
          targetId: current.id,
          ...(successorId ? { supersededBy: successorId } : {}),
        },
        targets: [current],
        reason,
      });
    }
    const record = await skillManager.deprecateSkill(
      current.id,
      { supersededBy: successorId },
      skillMutationContext(context, reason),
    );
    await reloadSkillsAfterWrite("deprecate");
    return skillWriteResult(
      `Deprecated skill "${record.name}"${record.supersededByName ? ` (superseded by ${record.supersededByName})` : ""}.`,
      { action: "deprecate", skills: [record], reason },
    );
  } catch (err) {
    return failureResult(
      err instanceof Error ? err.message : "Failed to deprecate skill.",
      ToolReturnCode.GenericFailure,
    );
  }
};
