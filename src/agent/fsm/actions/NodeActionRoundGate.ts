import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import { haltFromTurnResult } from "../FsmHostCapabilities.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { boolParam, NodeActionStubBase } from "./NodeActionStubBase.js";

export const NodeActionRoundGateSchema: FsmParamsSchema = {
  type: "object",
  title: "Round gate",
  description:
    "Per-round entry checks before preparing the model: abort, turn budget Continue/Stop, and drain a pending steer.",
  "x-llmDescription": "Entry guard for self-looping role nodes: abort when the user stopped the turn, pause on the turn budget (Continue/Stop card), drain queued steer messages into the transcript. params: checkAbort / checkBudget / drainSteer, all default true. Mount first on any node that loops to itself.",
  details: `Fixed-order guards for self-looping role nodes, each individually toggleable. Abort: host.checkAbort finishes the turn as cancelled. Budget: host.enforceBudget pauses with a Continue / Stop card when the model-iteration or token budget is hit. Steer: host.drainPendingSteer appends a queued steer message into the transcript at this round boundary. Passing all three returns continue with no patches.

Round-scoped signals (routeTarget, toolsRan, stepClaimed, subagentInjected, hasPendingToolCalls) are fresh per node visit by engine contract, so nothing is cleared here; the one exempt cross-visit key is turnContext.stepClaimTx.`,
  additionalProperties: false,
  properties: {
    checkAbort: {
      type: "boolean",
      default: true,
      title: "Check abort",
      description: "End the turn as cancelled when the user has stopped it.",
      "x-ui": "toggle",
    },
    checkBudget: {
      type: "boolean",
      default: true,
      title: "Enforce turn budget",
      description:
        "Pause with Continue/Stop when model-iteration or token budgets are hit.",
      "x-ui": "toggle",
    },
    drainSteer: {
      type: "boolean",
      default: true,
      title: "Drain pending steer",
      description:
        "Append a pending steer message into the transcript at this round boundary.",
      "x-ui": "toggle",
    },
  },
};

/** Shared turn-entry gates: abort → budget → drain steer. Null = keep going. */
async function runTurnGates(
  host: FsmHostCapabilities,
  options: { checkAbort: boolean; checkBudget: boolean; drainSteer: boolean },
): Promise<NodeActionExecResult | null> {
  if (options.checkAbort && host.checkAbort()) {
    const result = await host.finish("cancelled", "Cancelled", "cancelled");
    return haltFromTurnResult(result, "Cancelled");
  }
  if (options.checkBudget) {
    const budget = await host.enforceBudget();
    if (budget !== "resume") {
      return haltFromTurnResult(budget);
    }
  }
  if (options.drainSteer) {
    await host.drainPendingSteer();
  }
  return null;
}

/**
 * V3 self-looping role nodes: per-round entry gate — abort → budget → steer.
 *
 * Scope contract (docs/fsm-lifecycle.md): the round lifecycle is owned by the
 * engine (nodeContext is fresh per visit, and visit == round for role nodes),
 * so round signals (routeTarget / toolsRan / stepClaimed / subagentInjected /
 * hasPendingToolCalls) need no manual clearing here. The one exempt turnContext
 * key is `stepClaimTx` — a cross-visit transaction (executor opens, validator
 * consumes, CommitStep closes) that intentionally outlives single visits.
 */
export class NodeActionRoundGate extends NodeActionStubBase {
  readonly type = "NodeActionRoundGate";

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const checkAbort = boolParam(this.params, "checkAbort", true);
    const checkBudget = boolParam(this.params, "checkBudget", true);
    const drainSteer = boolParam(this.params, "drainSteer", true);

    const host = args.host;
    if (!host) {
      return { status: "continue" };
    }

    const gated = await runTurnGates(host, {
      checkAbort,
      checkBudget,
      drainSteer,
    });
    if (gated) return gated;

    return { status: "continue" };
  }
}
