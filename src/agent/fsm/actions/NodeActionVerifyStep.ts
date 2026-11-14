import { agentLogInfo } from "../../../logging/agentLog.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { verifyStepCommitGroup } from "../../domain/verifyStepCommit.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";
import { roleContextOf } from "./hostBridge.js";
import { stepClaimTxFrom, type StepClaimTx } from "./NodeActionDetectStepClaim.js";
import { titledEmptySchema } from "./schemaHelpers.js";

export const NodeActionVerifyStepSchema: FsmParamsSchema = titledEmptySchema(
  "Verify step",
  "Check dependsOn legality for the open step-claim group. Result is stored on the claim transaction for Commit step.",
  `Fills the verify half of the open turnContext.stepClaimTx (opened by Detect step claim on the executor visit). Checks dependsOn legality of pendingStepIds via verifyStepCommitGroup against the plan; pass / fail plus verifiedStepIds / failedStepId / waitingOn are written back onto the transaction and mirrored to nodeContext.verifyResult with stepPhase 'awaiting_verify'.

Commit step (same validator visit, via Validate & commit step) consumes the result. No open transaction or empty pending list auto-passes. Verification outcomes are logged to the agent log under 'execution.verify'.`,
  "Validate dependsOn legality for the open stepClaimTx (opened by DetectStepClaim): pass / fail plus verifiedStepIds are stored on the transaction for CommitStep on the same validator visit. No params.",
);

/**
 * Fills the verify half of the open stepClaimTx transaction (opened by
 * DetectStepClaim on the executor visit). Result lives on the tx object;
 * CommitStep (same validator visit, via ValidateCommitStep) consumes it.
 */
export class NodeActionVerifyStep extends NodeActionStubBase {
  readonly type = "NodeActionVerifyStep";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const host = args.host;
    const tx = stepClaimTxFrom(args.turnContext);

    if (!tx) {
      return {
        status: "continue",
        turnContextPatch: { verifySkipped: true },
      };
    }

    if (!host || tx.pendingStepIds.length === 0) {
      tx.verifyResult = "pass";
      tx.verifiedStepIds = [];
      return {
        status: "continue",
        turnContextPatch: { stepClaimTx: tx, stepPhase: "awaiting_verify" },
        nodeContextPatch: { verifyResult: "pass", stepPhase: "awaiting_verify" },
      };
    }

    const plan = roleContextOf(host, args.turnContext).plan.get();
    if (!plan?.steps?.length) {
      tx.verifyResult = "pass";
      tx.verifiedStepIds = [];
      return {
        status: "continue",
        turnContextPatch: { stepClaimTx: tx, stepPhase: "awaiting_verify" },
        nodeContextPatch: { verifyResult: "pass", stepPhase: "awaiting_verify" },
      };
    }

    const outcome = verifyStepCommitGroup(tx.pendingStepIds, plan.steps);

    if (!outcome.ok) {
      agentLogInfo("execution.verify", {
        sessionId: host.session.id,
        stepIds: tx.pendingStepIds,
        result: "fail",
        failedStepId: outcome.failedStepId,
        waitingOn: outcome.waitingOn,
      });
      tx.verifyResult = "fail";
      tx.failedStepId = outcome.failedStepId ?? null;
      tx.waitingOn = outcome.waitingOn ?? [];
      return {
        status: "continue",
        turnContextPatch: { stepClaimTx: tx, stepPhase: "awaiting_verify" },
        nodeContextPatch: { verifyResult: "fail", stepPhase: "awaiting_verify" },
      };
    }

    agentLogInfo("execution.verify", {
      sessionId: host.session.id,
      stepIds: outcome.verifiedStepIds,
      result: "pass",
      impl: "deps",
    });
    tx.verifyResult = "pass";
    tx.verifiedStepIds = outcome.verifiedStepIds;
    tx.failedStepId = null;
    tx.waitingOn = [];
    return {
      status: "continue",
      turnContextPatch: { stepClaimTx: tx, stepPhase: "awaiting_verify" },
      nodeContextPatch: { verifyResult: "pass", stepPhase: "awaiting_verify" },
    };
  }
}

export type { StepClaimTx };
