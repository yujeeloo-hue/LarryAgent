import { skillManager } from "../../skills/manager.js";
import {
  clampSkillDescription,
  formatSkillSummary,
  isValidSkillName,
  normalizeSkillName,
} from "../../skills/toolHelpers.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import {
  parseReason,
  projectParameter,
  reasonParameter,
  reloadSkillsAfterWrite,
  resolveNewSkillProject,
  skillMutationContext,
  skillWriteResult,
} from "./skillWrite.js";
import { parseSkillFilesArg } from "./skillArgs.js";

/** Default level: 1 (full-permissions gate). */
export const createSkillDefinition: ToolDefinition = {
  name: "create_skill",
  description: "Create a skill package with SKILL.md and optional files.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Unique skill slug (lowercase, digits, hyphens; max 64).",
      },
      description: {
        type: "string",
        description: "Catalog summary of what the skill does (max 1024).",
      },
      body: {
        type: "string",
        description: "Markdown skill instructions (after YAML frontmatter).",
      },
      enabled: {
        type: "boolean",
        description: "Whether the skill is listed in the catalog. Default true.",
      },
      project: projectParameter,
      files: {
        type: "array",
        description: "Optional supporting files (relative paths; not SKILL.md).",
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
      reason: reasonParameter,
    },
    required: ["name", "description", "body"],
  },
  defaultPermissionLevel: 1,
};

export const createSkillHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const nameRaw = typeof args.name === "string" ? args.name : "";
  const name = normalizeSkillName(nameRaw);
  if (!isValidSkillName(name)) {
    return failureResult(
      'Invalid arguments: "name" must be a lowercase slug (letters, numbers, hyphens; max 64).',
      ToolReturnCode.InvalidArguments,
    );
  }

  const description = clampSkillDescription(
    typeof args.description === "string" ? args.description : "",
  );
  if (!description) {
    return failureResult(
      'Invalid arguments: "description" (non-empty string) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const body = typeof args.body === "string" ? args.body : "";
  const enabled =
    typeof args.enabled === "boolean" ? args.enabled : true;

  const filesParsed = parseSkillFilesArg(args.files);
  if (!filesParsed.ok) {
    return failureResult(filesParsed.message, ToolReturnCode.InvalidArguments);
  }

  const existing = skillManager.findSkill(name);
  if (existing.record || existing.ambiguous) {
    return failureResult(
      `A skill named "${name}" already exists.`,
      ToolReturnCode.InvalidArguments,
    );
  }

  const reason = parseReason(args.reason);
  const project = resolveNewSkillProject(args.project, context);
  try {
    const record = await skillManager.upsertSkill(
      {
        name,
        description,
        body,
        enabled,
        ...(project ? { project } : { project: "*" }),
        files: filesParsed.files,
      },
      skillMutationContext(context, reason),
    );
    await reloadSkillsAfterWrite("create");
    return skillWriteResult(`Created skill.\n${formatSkillSummary(record)}`, {
      action: "create",
      skills: [record],
      reason,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to create skill.";
    return failureResult(message, ToolReturnCode.GenericFailure);
  }
};
