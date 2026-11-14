import { serializeSkillMarkdown } from "../../skills/parseSkillMd.js";
import { skillManager } from "../../skills/manager.js";
import { resolveSkillRef } from "../../skills/toolHelpers.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import {
  SKILL_READ_RECEIPT_KIND,
  type ToolDefinition,
  type ToolHandler,
} from "../types.js";

/** Default level: 0 (always allowed). */
export const readSkillDefinition: ToolDefinition = {
  name: "read_skill",
  description:
    "Load a skill's SKILL.md (and file list), or one supporting file by path. Call search_skills first if you do not know the name.",
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Skill name (slug).",
      },
      id: {
        type: "string",
        description: "Skill id when name is unknown.",
      },
      path: {
        type: "string",
        description: "Optional relative file path; omit to read SKILL.md.",
      },
    },
    required: [],
  },
  defaultPermissionLevel: 0,
};

export const readSkillHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const idArg = typeof args.id === "string" ? args.id.trim() : "";
  const nameArg = typeof args.name === "string" ? args.name.trim() : "";
  const ref = idArg || nameArg;
  if (!ref) {
    return failureResult(
      'Invalid arguments: provide "name" or "id".',
      ToolReturnCode.InvalidArguments,
    );
  }

  const relativePath =
    typeof args.path === "string" && args.path.trim()
      ? args.path.trim()
      : "";

  const resolved = resolveSkillRef(ref);
  if (!resolved.ok) {
    const code =
      resolved.returnCodeHint === "not_found"
        ? ToolReturnCode.NotFound
        : ToolReturnCode.InvalidArguments;
    return failureResult(resolved.message, code);
  }

  const record = resolved.record;

  if (relativePath) {
    try {
      const { content } = await skillManager.readSkillFile(
        record.id,
        relativePath,
      );
      return textResult(
        `Skill "${record.name}" file: ${relativePath}\nDirectory: ${record.directory}\n\n${content}`,
        ToolReturnCode.Success,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to read skill file.";
      const notFound = /not found/i.test(message);
      return failureResult(
        message,
        notFound ? ToolReturnCode.NotFound : ToolReturnCode.GenericFailure,
      );
    }
  }

  const markdown = serializeSkillMarkdown({
    name: record.name,
    description: record.description,
    body: record.body,
  });
  const filesBlock =
    record.files.length === 0
      ? "Supporting files: none"
      : `Supporting files (${record.files.length}):\n${record.files.map((f) => `- ${f}`).join("\n")}`;
  const statusLine =
    record.status === "deprecated"
      ? `Deprecated${record.supersededByName ? `; superseded by ${record.supersededByName}` : ""}. Prefer the replacement.\n`
      : "";
  const metaLine = `Origin: ${record.origin} · revision ${record.revision} · project ${record.project ?? "universal"}\n`;
  const text = textResult(
    `${statusLine}Directory: ${record.directory}\n${metaLine}${filesBlock}\n\n---\n${markdown}`,
    ToolReturnCode.Success,
  );
  // Skill maintenance reads are not usage.
  if (context.skillActor === "reflector") return text;
  return {
    ...text,
    receipt: {
      kind: SKILL_READ_RECEIPT_KIND,
      skillId: record.id,
      skillName: record.name,
      revision: record.revision,
    },
  };
};
