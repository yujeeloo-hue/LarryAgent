import { skillManager } from "../../skills/manager.js";
import { serializeSkillMarkdown } from "../../skills/parseSkillMd.js";
import {
  clampSkillDescription,
  formatSkillSummary,
  resolveSkillRef,
} from "../../skills/toolHelpers.js";
import type { SkillRecord } from "../../skills/types.js";
import type { JsonObject } from "../../session/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";
import {
  findClosestLines,
  formatNoMatchHint,
  fuzzyFindAndReplace,
  isAlreadyApplied,
} from "../patch/fuzzyMatch.js";
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

const MAX_EDITS = 16;
const MAX_REPORT_CHARS = 2200;

const EDIT_ITEM_SCHEMA: JsonObject = {
  type: "object",
  properties: {
    old_string: {
      type: "string",
      description:
        "Text that occurs exactly once in the current body; whitespace/indentation differences are tolerated.",
    },
    new_string: { type: "string", description: "Replacement text." },
  },
  required: ["old_string", "new_string"],
  additionalProperties: false,
};

export const patchSkillDefinition: ToolDefinition = {
  name: "patch_skill",
  description:
    "Fix part of a skill's SKILL.md body with replacements (unique old_string; whitespace-insensitive). Copy anchors from read_skill and keep them short. Pass description alone to update only the catalog description. The previous version is kept in the skill's history.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Skill id (preferred when known)." },
      name: { type: "string", description: "Skill name when id is omitted." },
      edits: {
        type: "array",
        description: `Replacements applied in order (max ${MAX_EDITS}). Omit to change only the description.`,
        items: EDIT_ITEM_SCHEMA,
      },
      description: {
        type: "string",
        description: "Optional new catalog description (max 1024).",
      },
      reason: reasonParameter,
    },
    required: ["reason"],
  },
  validationParameters: {
    type: "object",
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      edits: {
        anyOf: [
          { type: "array", items: EDIT_ITEM_SCHEMA },
          { type: "string" },
        ],
      },
      description: { type: "string" },
      reason: { type: "string" },
    },
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

type Edit = { oldString: string; newString: string };

function parseEdits(raw: unknown): { ok: true; edits: Edit[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: 'Invalid arguments: "edits" must be a non-empty array.' };
  }
  if (raw.length > MAX_EDITS) {
    return { ok: false, message: `Invalid arguments: at most ${MAX_EDITS} edits per call.` };
  }
  const edits: Edit[] = [];
  for (const [i, item] of raw.entries()) {
    const e = item as Record<string, unknown> | null;
    if (!e || typeof e.old_string !== "string" || typeof e.new_string !== "string") {
      return { ok: false, message: `Invalid arguments: edits[${i}] needs old_string and new_string strings.` };
    }
    if (!e.old_string) {
      return { ok: false, message: `Invalid arguments: edits[${i}].old_string is empty.` };
    }
    edits.push({ oldString: e.old_string, newString: e.new_string });
  }
  return { ok: true, edits };
}

function readEditsArg(raw: unknown): { present: boolean; value: unknown } {
  if (raw === undefined || raw === null) return { present: false, value: raw };
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { present: false, value: undefined };
    try {
      return { present: true, value: JSON.parse(trimmed) };
    } catch {
      return { present: true, value: raw };
    }
  }
  if (Array.isArray(raw) && raw.length === 0) return { present: false, value: raw };
  return { present: true, value: raw };
}

function clip(text: string): string {
  return text.length > MAX_REPORT_CHARS
    ? `${text.slice(0, MAX_REPORT_CHARS)}\n… (report clipped)`
    : text;
}

function describeMatchStrategies(): string {
  return "Anchors that differ only in whitespace, indentation, escapes or unicode punctuation are matched automatically.";
}

export function applySkillBodyEdits(
  body: string,
  edits: Edit[],
): { ok: true; body: string; fuzzyEdits: number } | { ok: false; message: string } {
  let next = body;
  let fuzzyEdits = 0;
  for (const [i, edit] of edits.entries()) {
    if (edit.oldString === edit.newString) continue;
    const result = fuzzyFindAndReplace(next, edit.oldString, edit.newString);
    if (result.error || result.matchCount === 0) {
      if (isAlreadyApplied(next, edit.oldString, edit.newString)) continue;
      const error = result.error ?? "";
      if (/^Found \d+ matches/.test(error)) {
        return {
          ok: false,
          message: `edits[${i}].old_string occurs more than once; include more surrounding text to make it unique.\n${clip(error)}`,
        };
      }
      const hint = formatNoMatchHint(error, 0, edit.oldString, next);
      const reason = error && !error.startsWith("Could not find") ? `${error}\n` : "";
      return {
        ok: false,
        message: clip(
          `edits[${i}].old_string was not found in the skill body of the current revision.\n${reason}${hint || findClosestLines(edit.oldString, next)}`.trimEnd() +
            `\n${describeMatchStrategies()}`,
        ),
      };
    }
    if (result.strategy && result.strategy !== "exact") fuzzyEdits += 1;
    next = result.content;
  }
  return { ok: true, body: next, fuzzyEdits };
}

function frontmatterBlock(record: SkillRecord): string {
  return serializeSkillMarkdown({
    name: record.name,
    description: record.description,
    body: "",
    project: record.project,
  }).trim();
}

function frontmatterNote(record: SkillRecord, edits: Edit[]): string {
  const header = frontmatterBlock(record);
  const touched = edits.some((edit) => {
    const anchor = edit.oldString.trim();
    return anchor.length > 0 && header.includes(anchor);
  });
  if (!touched) return "";
  return (
    "\n\nNote: SKILL.md frontmatter (`name:` / `description:` / `project:`) is not part of the editable body — edits only apply to the markdown after it. To change the catalog description, pass the `description` argument; renames go through update_skill."
  );
}

export const patchSkillHandler: ToolHandler = async (args, context) => {
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

  const editsArg = readEditsArg(args.edits);
  const descriptionArg =
    typeof args.description === "string" && args.description.trim()
      ? clampSkillDescription(args.description)
      : undefined;
  if (!editsArg.present && descriptionArg === undefined) {
    return failureResult(
      'Invalid arguments: provide "edits" (body fix) or "description" (catalog description).',
      ToolReturnCode.InvalidArguments,
    );
  }
  let edits: Edit[] = [];
  if (editsArg.present) {
    const parsed = parseEdits(editsArg.value);
    if (!parsed.ok) {
      const shape =
        typeof args.edits === "string"
          ? ' "edits" arrived as a string; send the array of {old_string, new_string} objects directly.'
          : "";
      return failureResult(`${parsed.message}${shape}`, ToolReturnCode.InvalidArguments);
    }
    edits = parsed.edits;
  }

  const resolved = resolveSkillRef(ref);
  if (!resolved.ok) {
    return failureResult(
      resolved.message,
      resolved.returnCodeHint === "not_found" ? ToolReturnCode.NotFound : ToolReturnCode.InvalidArguments,
    );
  }
  const current = resolved.record;
  const patched = applySkillBodyEdits(current.body, edits);
  if (!patched.ok) {
    return failureResult(
      `${patched.message}${frontmatterNote(current, edits)}`,
      ToolReturnCode.InvalidArguments,
    );
  }

  const description = descriptionArg ?? current.description;
  const reason = parseReason(args.reason);
  const bodyChanged = patched.body !== current.body;
  const descriptionChanged = description !== current.description;
  if (!bodyChanged && !descriptionChanged) {
    return textResult(
      `No change: skill "${current.name}" is already at the requested state (revision ${current.revision}). Nothing was written.${
        edits.length > 0 ? " Your old_string/new_string pairs were identical or already applied." : ""
      }`,
      ToolReturnCode.Success,
    );
  }

  try {
    if (mustPropose(context, [current])) {
      return await proposeSkillChange(context, {
        action: "patch",
        payload: {
          kind: "patch",
          targetId: current.id,
          name: current.name,
          description,
          body: patched.body,
        },
        targets: [current],
        reason,
      });
    }
    const record = await skillManager.upsertSkill(
      {
        id: current.id,
        name: current.name,
        description,
        body: patched.body,
        enabled: current.enabled,
      },
      skillMutationContext(context, reason),
    );
    await reloadSkillsAfterWrite("patch");
    const what = bodyChanged
      ? `Patched skill (${edits.length} edit(s))`
      : "Updated the catalog description (body unchanged)";
    const fuzzyNote =
      patched.fuzzyEdits > 0
        ? `\n${patched.fuzzyEdits} edit(s) matched with whitespace/format tolerance — re-read the skill if the surrounding text looks off.`
        : "";
    return skillWriteResult(
      `${what}; now revision ${record.revision}.${fuzzyNote}\n${formatSkillSummary(record)}`,
      { action: "patch", skills: [record], reason },
    );
  } catch (err) {
    return failureResult(
      err instanceof Error ? err.message : "Failed to patch skill.",
      ToolReturnCode.GenericFailure,
    );
  }
};
