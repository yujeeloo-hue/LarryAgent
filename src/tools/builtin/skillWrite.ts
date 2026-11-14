import { skillManager } from "../../skills/manager.js";
import { normalizeSkillProject, skillProjectKey } from "../../skills/projectScope.js";
import {
  createSkillProposal,
  type SkillProposalPayload,
} from "../../skills/proposals.js";
import {
  AUTO_EDITABLE_ORIGINS,
  type SkillMutationContext,
  type SkillRecord,
} from "../../skills/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { textResult } from "../pathUtil.js";
import {
  SKILL_WRITE_RECEIPT_KIND,
  type ToolExecuteContext,
  type ToolExecuteResult,
} from "../types.js";

const REASON_MAX = 300;

export type SkillWriteAction =
  | "create"
  | "update"
  | "patch"
  | "merge"
  | "deprecate"
  | "write_file"
  | "delete";

export const reasonParameter = {
  type: "string",
  description:
    "One sentence on why (cite the concrete fact: failure, correction, overlap). Stored in the skill's version history.",
} as const;

export function parseReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const one = raw.replace(/\s+/g, " ").trim();
  return one ? one.slice(0, REASON_MAX) : undefined;
}

export const projectParameter = {
  type: "string",
  description:
    'Owning project scope: a workspace folder slug (e.g. "jellybot"). Omit to keep the skill in the current project; "*" makes it universal (every project).',
} as const;

/**
 * Project scope for a create_skill write: an explicit argument wins
 * (`"*"` → universal), otherwise the skill belongs to the session's project.
 */
export function resolveNewSkillProject(
  raw: unknown,
  context: ToolExecuteContext,
): string | undefined {
  if (typeof raw === "string") return normalizeSkillProject(raw);
  return skillProjectKey(context.workspacePath) || undefined;
}

export function skillMutationContext(
  context: ToolExecuteContext,
  reason: string | undefined,
): SkillMutationContext {
  return {
    actor: context.skillActor ?? "agent",
    ...(reason ? { reason } : {}),
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  };
}

/** Under `auto_owned_only`, edits of skills the actor does not own become proposals. */
export function mustPropose(context: ToolExecuteContext, targets: SkillRecord[]): boolean {
  if (context.skillWritePolicy !== "auto_owned_only") return false;
  return targets.some((t) => !AUTO_EDITABLE_ORIGINS.includes(t.origin));
}

export function skillWriteResult(
  text: string,
  facts: {
    action: SkillWriteAction;
    skills: Array<Pick<SkillRecord, "id" | "name">>;
    reason?: string | undefined;
    proposalId?: string;
  },
): ToolExecuteResult {
  return {
    ...textResult(text, ToolReturnCode.Success),
    receipt: {
      kind: SKILL_WRITE_RECEIPT_KIND,
      action: facts.action,
      skillIds: facts.skills.map((s) => s.id),
      skillNames: facts.skills.map((s) => s.name),
      ...(facts.reason ? { reason: facts.reason } : {}),
      ...(facts.proposalId ? { proposalId: facts.proposalId } : {}),
    },
  };
}

export async function proposeSkillChange(
  context: ToolExecuteContext,
  input: {
    action: SkillWriteAction;
    payload: SkillProposalPayload;
    targets: SkillRecord[];
    reason: string | undefined;
  },
): Promise<ToolExecuteResult> {
  const proposal = await createSkillProposal({
    payload: input.payload,
    targets: input.targets,
    reason: input.reason ?? "(no reason given)",
    actor: context.skillActor ?? "agent",
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  });
  const owners = [...new Set(input.targets.map((t) => t.origin))].join(", ");
  return skillWriteResult(
    `Saved as a suggestion for user review (skill is ${owners}-owned). Proposal id: ${proposal.id}. Do not retry the edit.`,
    {
      action: input.action,
      skills: input.targets,
      reason: input.reason,
      proposalId: proposal.id,
    },
  );
}

/** Keep runtime state aligned with disk after an agent-side write. */
export async function reloadSkillsAfterWrite(label: string): Promise<void> {
  try {
    await skillManager.reloadFromDisk();
  } catch (err) {
    console.error(`[skills] reloadFromDisk failed after ${label}`, err);
  }
}
