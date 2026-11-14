import { skillManager } from "../../skills/manager.js";
import {
  clampSkillDescription,
  formatSkillSummary,
  resolveSkillRef,
} from "../../skills/toolHelpers.js";
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

const MAX_EDITS = 16;

/** Default level: 1 (full-permissions gate). */
export const patchSkillDefinition: ToolDefinition = {
  name: "patch_skill",
  description:
    "Fix part of a skill's SKILL.md body with exact replacements (each old_string must occur exactly once). Optionally replace the catalog description. The previous version is kept in the skill's history.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Skill id (preferred when known)." },
      name: { type: "string", description: "Skill name when id is omitted." },
      edits: {
        type: "array",
        description: `Exact replacements applied in order (max ${MAX_EDITS}).`,
        items: {
          type: "object",
          properties: {
            old_string: {
              type: "string",
              description: "Text that occurs exactly once in the current body.",
            },
            new_string: { type: "string", description: "Replacement text." },
          },
          required: ["old_string", "new_string"],
          additionalProperties: false,
        },
      },
      description: {
        type: "string",
        description: "Optional new catalog description (max 1024).",
      },
      reason: reasonParameter,
    },
    required: ["edits", "reason"],
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

/** Apply exact unique replacements in order; reports the first failing edit. */
export function applySkillBodyEdits(
  body: string,
  edits: Edit[],
): { ok: true; body: string } | { ok: false; message: string } {
  let next = body;
  for (const [i, edit] of edits.entries()) {
    const first = next.indexOf(edit.oldString);
    if (first < 0) {
      return { ok: false, message: `edits[${i}].old_string was not found in the skill body. Read the skill again and copy the text exactly.` };
    }
    if (next.indexOf(edit.oldString, first + 1) >= 0) {
      return { ok: false, message: `edits[${i}].old_string occurs more than once; include more surrounding text to make it unique.` };
    }
    next = next.slice(0, first) + edit.newString + next.slice(first + edit.oldString.length);
  }
  return { ok: true, body: next };
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
  const parsed = parseEdits(args.edits);
  if (!parsed.ok) return failureResult(parsed.message, ToolReturnCode.InvalidArguments);

  const resolved = resolveSkillRef(ref);
  if (!resolved.ok) {
    return failureResult(
      resolved.message,
      resolved.returnCodeHint === "not_found" ? ToolReturnCode.NotFound : ToolReturnCode.InvalidArguments,
    );
  }
  const current = resolved.record;
  const patched = applySkillBodyEdits(current.body, parsed.edits);
  if (!patched.ok) return failureResult(patched.message, ToolReturnCode.InvalidArguments);

  const description =
    typeof args.description === "string" && args.description.trim()
      ? clampSkillDescription(args.description)
      : current.description;
  const reason = parseReason(args.reason);
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
    return skillWriteResult(
      `Patched skill (${parsed.edits.length} edit(s)); now revision ${record.revision}.\n${formatSkillSummary(record)}`,
      { action: "patch", skills: [record], reason },
    );
  } catch (err) {
    return failureResult(
      err instanceof Error ? err.message : "Failed to patch skill.",
      ToolReturnCode.GenericFailure,
    );
  }
};
