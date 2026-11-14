import { ToolReturnCode } from "../../session/returnCodes.js";
import { SKILL_READ_RECEIPT_KIND } from "../../tools/types.js";
import type { ToolCallReceipt } from "../runTools.js";

/** Handler outcomes that mean the call itself went wrong (not deny / cancel / not-found). */
const ERROR_RETURN_CODES: ReadonlySet<number> = new Set([
  ToolReturnCode.GenericFailure,
  ToolReturnCode.Timeout,
  ToolReturnCode.InvalidArguments,
]);

/** Turn-scoped tool outcome tally; never reset by turn budgets. */
export type ToolOutcomeTally = {
  errors: number;
  recoveries: number;
  /** Unpaired errors per underlying tool name. */
  openErrors: Map<string, number>;
  skillsRead: Set<string>;
  /** User denials / cancellations of a tool call (returnCode 6). */
  denials: number;
};

/** First read of a skill in this turn. */
export type SkillReadFact = { skillId: string; skillName: string; revision?: number };

export function createToolOutcomeTally(): ToolOutcomeTally {
  return { errors: 0, recoveries: 0, openErrors: new Map(), skillsRead: new Set(), denials: 0 };
}

/**
 * Fold one executed batch (call order) into the tally. A success pairs with at
 * most one earlier unpaired error of the same tool and counts as a recovery.
 * Returns skills read for the first time this turn.
 */
export function tallyToolReceipts(
  tally: ToolOutcomeTally,
  receipts: readonly ToolCallReceipt[] | undefined,
): SkillReadFact[] {
  const firstReads: SkillReadFact[] = [];
  for (const receipt of receipts ?? []) {
    if (receipt.returnCode === ToolReturnCode.Cancelled) tally.denials += 1;
    const open = tally.openErrors.get(receipt.name) ?? 0;
    if (ERROR_RETURN_CODES.has(receipt.returnCode)) {
      tally.errors += 1;
      tally.openErrors.set(receipt.name, open + 1);
      continue;
    }
    if (receipt.returnCode !== ToolReturnCode.Success) continue;
    if (open > 0) {
      tally.recoveries += 1;
      tally.openErrors.set(receipt.name, open - 1);
    }
    const facts = receipt.receipt;
    if (
      facts?.kind === SKILL_READ_RECEIPT_KIND &&
      typeof facts.skillId === "string" &&
      facts.skillId &&
      !tally.skillsRead.has(facts.skillId)
    ) {
      tally.skillsRead.add(facts.skillId);
      firstReads.push({
        skillId: facts.skillId,
        skillName: typeof facts.skillName === "string" ? facts.skillName : facts.skillId,
        ...(typeof facts.revision === "number" ? { revision: facts.revision } : {}),
      });
    }
  }
  return firstReads;
}
