import { skillManager } from "../../skills/manager.js";
import {
  formatSkillSummary,
  resolveSkillRef,
} from "../../skills/toolHelpers.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
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
export const writeSkillFileDefinition: ToolDefinition = {
  name: "write_skill_file",
  description: "Create or overwrite a supporting file inside a skill package.",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Skill id (preferred when known).",
      },
      name: {
        type: "string",
        description: "Skill name when id is omitted.",
      },
      path: {
        type: "string",
        description: "Relative path inside the skill directory.",
      },
      content: {
        type: "string",
        description: "UTF-8 file contents.",
      },
      reason: reasonParameter,
    },
    required: ["path", "content"],
  },
  defaultPermissionLevel: 1,
};

export const writeSkillFileHandler: ToolHandler = async (args, context) => {
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

  const relativePath = typeof args.path === "string" ? args.path : "";
  if (!relativePath.trim()) {
    return failureResult(
      'Invalid arguments: "path" is required.',
      ToolReturnCode.InvalidArguments,
    );
  }
  if (typeof args.content !== "string") {
    return failureResult(
      'Invalid arguments: "content" (string) is required.',
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

  const reason = parseReason(args.reason);
  const current = resolved.record;
  try {
    if (mustPropose(context, [current])) {
      return await proposeSkillChange(context, {
        action: "write_file",
        payload: {
          kind: "update",
          targetId: current.id,
          name: current.name,
          description: current.description,
          body: current.body,
          files: [{ path: relativePath, content: args.content }],
        },
        targets: [current],
        reason,
      });
    }
    const record = await skillManager.writeSkillFile(
      current.id,
      relativePath,
      args.content,
      skillMutationContext(context, reason),
    );
    await reloadSkillsAfterWrite("writeSkillFile");
    return skillWriteResult(`Wrote ${relativePath}.\n${formatSkillSummary(record)}`, {
      action: "write_file",
      skills: [record],
      reason,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write skill file.";
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
