import { detectExecutorStepClaim } from "../../domain/stepFsm.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import { pinSelectProperty, resolvePinSlot } from "../pinRouting.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { asToolCalls, roleContextOf, roleKindFromContext } from "./hostBridge.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";

export const NodeActionDetectStepClaimSchema: FsmParamsSchema = {
  type: "object",
  title: "Detect step claim",
  description:
    "Detect an executor step claim from tool calls, open a cross-visit claim transaction, and route via the step-claim pin.",
  "x-llmDescription": "Executor round: detect step-claim tool calls, open the cross-visit stepClaimTx transaction and route to the onStepClaim pin (required) with stepClaimed=true. No claim -> continue unchanged.",
  additionalProperties: false,
  required: ["onStepClaim"],
  details: `Executor-side step-claim detector. Runs detectExecutorStepClaim over this round's tool calls (nodeContext only — V3 never hoists toolCalls to turnContext) and, when a claim opens, writes the cross-visit transaction turnContext.stepClaimTx: pendingStepIds and verify slots filled later by Verify step. This is the one round-derived key allowed to outlive a visit (RoundGate leaves it alone).

Also records stepPhase and routes to the onStepClaim pin via routeTarget with stepClaimed=true — Route to defers to it. No claim: stepClaimed=false, continue.`,
  properties: {
    onStepClaim: pinSelectProperty(
      "Step-claim pin",
      "When a claim group is opened (built-in: execution_validator).",
    ),
  },
};

/**
 * Group-B step-claim transaction: survives across visits (opened in the
 * executor visit → consumed in the validator visit → closed by CommitStep),
 * hung on the single turnContext key `stepClaimTx`. It is the only
 * round-derived state explicitly allowed to cross visits (RoundGate never
 * touches it).
 */
export type StepClaimTx = {
  /** Step ids awaiting verify in the current group. */
  pendingStepIds: string[];
  /** Filled by VerifyStep, consumed by CommitStep in the same visit. */
  verifyResult: "pass" | "fail" | null;
  verifiedStepIds: string[];
  failedStepId: string | null;
  waitingOn: string[];
};

export function stepClaimTxFrom(
  turnContext: Record<string, unknown>,
): StepClaimTx | null {
  const raw = turnContext.stepClaimTx;
  if (!raw || typeof raw !== "object") return null;
  const tx = raw as Partial<StepClaimTx>;
  if (!Array.isArray(tx.pendingStepIds)) {
    return null;
  }
  return {
    pendingStepIds: tx.pendingStepIds.filter(
      (id): id is string => typeof id === "string" && id.length > 0,
    ),
    verifyResult:
      tx.verifyResult === "pass" || tx.verifyResult === "fail"
        ? tx.verifyResult
        : null,
    verifiedStepIds: Array.isArray(tx.verifiedStepIds)
      ? tx.verifiedStepIds.filter(
          (id): id is string => typeof id === "string" && id.length > 0,
        )
      : [],
    failedStepId: typeof tx.failedStepId === "string" ? tx.failedStepId : null,
    waitingOn: Array.isArray(tx.waitingOn)
      ? tx.waitingOn.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export class NodeActionDetectStepClaim extends NodeActionStubBase {
  readonly type = "NodeActionDetectStepClaim";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const host = args.host;
    if (!host) {
      return {
        status: "continue",
        turnContextPatch: { stepClaimChecked: true },
      };
    }

    // Round container is nodeContext (Stream semantic wrote it this visit);
    // no turnContext fallback — V3 never hoists toolCalls.
    const toolCalls = asToolCalls(args.nodeContext.toolCalls);
    const roleKind = roleKindFromContext(args.nodeContext);
    const claim = detectExecutorStepClaim(
      { activeRole: roleKind },
      roleContextOf(host, args.turnContext),
      toolCalls,
    );

    const pendingIds = claim?.pendingVerifyStepIds ?? [];
    if (!claim || !pendingIds.length) {
      return {
        status: "continue",
        turnContextPatch: { stepClaimChecked: true },
        nodeContextPatch: { stepClaimed: false },
      };
    }

    // Open the transaction on turnContext (the only legal cross-visit
    // channel); round-scoped mirrors go to nodeContext.
    const tx: StepClaimTx = {
      pendingStepIds: pendingIds,
      verifyResult: null,
      verifiedStepIds: [],
      failedStepId: null,
      waitingOn: [],
    };

    const claimPin = resolvePinSlot(this.params, "onStepClaim", this.type);
    if (!claimPin.ok) {
      return { status: "halt", errorMessage: claimPin.errorMessage };
    }

    return {
      status: "continue",
      turnContextPatch: {
        stepClaimChecked: true,
        stepClaimTx: tx,
        stepPhase: claim.stepPhase,
      },
      nodeContextPatch: {
        stepClaimed: true,
        routeTarget: claimPin.pin,
        stepPhase: claim.stepPhase,
        pendingVerifyStepIds: tx.pendingStepIds,
      },
    };
  }
}
