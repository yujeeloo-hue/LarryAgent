import { skillManager } from "../../skills/manager.js";
import {
  clampSkillDescription,
  formatSkillSummary,
  isValidSkillName,
  normalizeSkillName,
  resolveSkillRef,
} from "../../skills/toolHelpers.js";
import type { SkillRecord } from "../../skills/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { abortIfSignaled, failureResult } from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { parseSkillFilesArg } from "./skillArgs.js";
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
export const mergeSkillsDefinition: ToolDefinition = {
  name: "merge_skills",
  description:
    "Merge overlapping skills into one. The target (an existing source by id, or a new skill name) gets the merged SKILL.md; every other source is deprecated and points to it. Nothing is deleted; previous versions stay in history.",
  parameters: {
    type: "object",
    properties: {
      source_ids: {
        type: "array",
        description: "Ids or names of the skills being merged (at least 2).",
        items: { type: "string" },
      },
      target: {
        type: "object",
        description:
          "Merged skill. Set id to keep one of the sources; otherwise name creates a new skill.",
        properties: {
          id: { type: "string", description: "Existing skill id to receive the merge." },
          name: { type: "string", description: "Slug for a new merged skill (when id is omitted)." },
          description: { type: "string", description: "Catalog description (max 1024)." },
          body: { type: "string", description: "Full merged markdown body." },
          files: {
            type: "array",
            description: "Optional supporting files to create/overwrite on the target.",
            items: {
              type: "object",
              properties: {
                path: { type: "string" },
                content: { type: "string" },
              },
              required: ["path", "content"],
              additionalProperties: false,
            },
          },
        },
        required: ["description", "body"],
        additionalProperties: false,
      },
      reason: reasonParameter,
    },
    required: ["source_ids", "target", "reason"],
  },
  defaultPermissionLevel: 1,
};

export const mergeSkillsHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const refs = Array.isArray(args.source_ids)
    ? args.source_ids.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    : [];
  if (refs.length < 2) {
    return failureResult(
      'Invalid arguments: "source_ids" needs at least 2 skills.',
      ToolReturnCode.InvalidArguments,
    );
  }
  const sources: SkillRecord[] = [];
  for (const ref of refs) {
    const resolved = resolveSkillRef(ref.trim());
    if (!resolved.ok) {
      return failureResult(
        resolved.message,
        resolved.returnCodeHint === "not_found" ? ToolReturnCode.NotFound : ToolReturnCode.InvalidArguments,
      );
    }
    if (!sources.some((s) => s.id === resolved.record.id)) sources.push(resolved.record);
  }
  if (sources.length < 2) {
    return failureResult(
      'Invalid arguments: "source_ids" must name at least 2 different skills.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const target = (args.target ?? {}) as Record<string, unknown>;
  const description =
    typeof target.description === "string" ? clampSkillDescription(target.description) : "";
  const body = typeof target.body === "string" ? target.body : "";
  if (!description || !body.trim()) {
    return failureResult(
      'Invalid arguments: target.description and target.body are required.',
      ToolReturnCode.InvalidArguments,
    );
  }
  const filesParsed = parseSkillFilesArg(target.files);
  if (!filesParsed.ok) return failureResult(filesParsed.message, ToolReturnCode.InvalidArguments);

  let targetRecord: SkillRecord | null = null;
  let targetName: string;
  const targetId = typeof target.id === "string" ? target.id.trim() : "";
  if (targetId) {
    targetRecord = sources.find((s) => s.id === targetId || s.name === targetId) ?? null;
    if (!targetRecord) {
      return failureResult(
        "Invalid arguments: target.id must be one of source_ids (or omit it and give target.name for a new skill).",
        ToolReturnCode.InvalidArguments,
      );
    }
    targetName = targetRecord.name;
  } else {
    targetName = normalizeSkillName(typeof target.name === "string" ? target.name : "");
    if (!isValidSkillName(targetName)) {
      return failureResult(
        "Invalid arguments: give target.id (a source) or a valid new target.name slug.",
        ToolReturnCode.InvalidArguments,
      );
    }
    const clash = skillManager.findSkill(targetName);
    if (clash.record || clash.ambiguous) {
      return failureResult(
        `A skill named "${targetName}" already exists. Use its id as target.id (and include it in source_ids) or pick another name.`,
        ToolReturnCode.InvalidArguments,
      );
    }
  }

  const reason = parseReason(args.reason);
  const sourceIds = sources.map((s) => s.id);
  try {
    if (mustPropose(context, sources)) {
      return await proposeSkillChange(context, {
        action: "merge",
        payload: {
          kind: "merge",
          ...(targetRecord ? { targetId: targetRecord.id } : {}),
          sourceIds,
          name: targetName,
          description,
          body,
          ...(filesParsed.files ? { files: filesParsed.files } : {}),
        },
        targets: sources,
        reason,
      });
    }
    const result = await skillManager.mergeSkills(
      {
        target: targetRecord ? targetRecord.id : targetName,
        sources: sourceIds,
        description,
        body,
        files: filesParsed.files,
      },
      skillMutationContext(context, reason),
    );
    await reloadSkillsAfterWrite("merge");
    const deprecatedNames = result.deprecated.map((d) => d.name).join(", ");
    return skillWriteResult(
      `${result.created ? "Created" : "Updated"} merged skill; deprecated: ${deprecatedNames}.\n${formatSkillSummary(result.target)}`,
      { action: "merge", skills: [result.target, ...result.deprecated], reason },
    );
  } catch (err) {
    return failureResult(
      err instanceof Error ? err.message : "Failed to merge skills.",
      ToolReturnCode.GenericFailure,
    );
  }
};
