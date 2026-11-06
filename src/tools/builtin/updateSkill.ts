import { skillManager } from "../../skills/manager.js";
import {
  clampSkillDescription,
  formatSkillSummary,
  isValidSkillName,
  normalizeSkillName,
  resolveSkillRef,
} from "../../skills/toolHelpers.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { parseRemoveFilesArg, parseSkillFilesArg } from "./skillArgs.js";

/** Default level: 1 (full-permissions gate). */
export const updateSkillDefinition: ToolDefinition = {
  name: "update_skill",
  description: "Update a skill package (metadata, body, or supporting files).",
  parameters: {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Skill id (preferred when known).",
      },
      name: {
        type: "string",
        description: "Skill name lookup when id is omitted (or new name).",
      },
      new_name: {
        type: "string",
        description: "Optional new skill slug.",
      },
      description: {
        type: "string",
        description: "Optional new catalog description (max 1024).",
      },
      body: {
        type: "string",
        description: "Optional new markdown body (replaces existing body).",
      },
      enabled: {
        type: "boolean",
        description: "Optional enable/disable for the catalog.",
      },
      files: {
        type: "array",
        description: "Optional files to create/overwrite (not SKILL.md).",
        items: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative path inside the skill directory.",
            },
            content: {
              type: "string",
              description: "UTF-8 file contents.",
            },
          },
          required: ["path", "content"],
          additionalProperties: false,
        },
      },
      remove_files: {
        type: "array",
        description: "Optional relative paths to delete from the package.",
        items: { type: "string" },
      },
    },
    required: [],
  },
  defaultPermissionLevel: 1,
};

export const updateSkillHandler: ToolHandler = async (args, context) => {
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

  const current = resolved.record;
  const newNameRaw =
    typeof args.new_name === "string" && args.new_name.trim()
      ? args.new_name.trim()
      : idArg && nameArg
        ? nameArg
        : current.name;
  const newName = normalizeSkillName(newNameRaw);
  if (!isValidSkillName(newName)) {
    return failureResult(
      'Invalid arguments: skill name must be a lowercase slug (letters, numbers, hyphens; max 64).',
      ToolReturnCode.InvalidArguments,
    );
  }

  const description =
    typeof args.description === "string"
      ? clampSkillDescription(args.description)
      : current.description;
  if (!description) {
    return failureResult(
      'Invalid arguments: "description" cannot be empty.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const body =
    typeof args.body === "string" ? args.body : current.body;
  const enabled =
    typeof args.enabled === "boolean" ? args.enabled : current.enabled;

  const filesParsed = parseSkillFilesArg(args.files);
  if (!filesParsed.ok) {
    return failureResult(filesParsed.message, ToolReturnCode.InvalidArguments);
  }
  const removeParsed = parseRemoveFilesArg(args.remove_files);
  if (!removeParsed.ok) {
    return failureResult(removeParsed.message, ToolReturnCode.InvalidArguments);
  }

  try {
    const record = await skillManager.upsertSkill({
      id: current.id,
      name: newName,
      description,
      body,
      enabled,
      files: filesParsed.files,
      removeFiles: removeParsed.paths,
    });
    try {
      await skillManager.reloadFromDisk();
    } catch (err) {
      console.error("[skills] reloadFromDisk failed after update", err);
    }
    return textResult(
      `Updated skill.\n${formatSkillSummary(record)}`,
      ToolReturnCode.Success,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to update skill.";
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
