import { agentLogInfo } from "../../../logging/agentLog.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import { pinSelectProperty, resolvePinSlot } from "../pinRouting.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";
import { roleContextOf } from "./hostBridge.js";
import { stepClaimTxFrom } from "./NodeActionDetectStepClaim.js";

export const NodeActionCommitStepSchema: FsmParamsSchema = {
  type: "object",
  title: "Commit step",
  description:
    "After verify: sync graph pointers / commit the claim group. Routes via configured pins only.",
  "x-llmDescription": "Consume the verified stepClaimTx: commit the claim group, revert failed steps, complete the plan when the last step lands. Routes onResume (required) after fail / skip / partial commit, onReflect (required) when the plan completes.",
  additionalProperties: false,
  required: ["onResume", "onReflect"],
  details: `Consumes the verified turnContext.stepClaimTx after Verify step. verifyResult fail: reverts the failed step to in-progress, emits a progress line naming what it waits on, clears the transaction and routes onResume. pass: commits verifiedStepIds; completes the plan when fully done (clearing planDoc + phase) and routes onReflect, else onResume. No transaction: stepCommitSkipped, routes onResume.

All exits resolve through the configured pin slots — halt with a named error if a needed slot is unwired. Outcomes are logged under 'execution.step_commit'.`,
  properties: {
    onResume: pinSelectProperty(
      "Resume pin",
      "After fail/skip/commit when returning to the claiming role (built-in: executor).",
    ),
    onReflect: pinSelectProperty(
      "Leave pin",
      "When the plan is fully committed (built-in: skill_reflector).",
    ),
  },
};

/**
 * After verify: sync graph pointers. Routes via configured pin slots only.
 */
export class NodeActionCommitStep extends NodeActionStubBase {
  readonly type = "NodeActionCommitStep";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const label = this.type;
    const host = args.host;

    const pinResume = () => resolvePinSlot(this.params, "onResume", label);
    const pinReflect = () => resolvePinSlot(this.params, "onReflect", label);

    if (!host) {
      const reflect = pinReflect();
      if (!reflect.ok) {
        return { status: "halt", errorMessage: reflect.errorMessage };
      }
      return {
        status: "continue",
        turnContextPatch: { stepCommitted: true },
        nodeContextPatch: { routeTarget: reflect.pin },
      };
    }

    const ctx = roleContextOf(host, args.turnContext);
    const tx = stepClaimTxFrom(args.turnContext);

    if (!tx) {
      const resume = pinResume();
      if (!resume.ok) {
        return { status: "halt", errorMessage: resume.errorMessage };
      }
      return {
        status: "continue",
        turnContextPatch: { stepCommitSkipped: true },
        nodeContextPatch: { routeTarget: resume.pin },
      };
    }

    if (tx.verifyResult === "fail") {
      const failedId = tx.failedStepId ?? tx.pendingStepIds[0] ?? null;
      const waitingOn = tx.waitingOn;

      if (failedId) {
        ctx.plan.revertStepToInProgress(failedId);
        const progressLabel = waitingOn.length
          ? `Plan step "${failedId}" cannot commit yet — waiting on ${waitingOn.join(", ")}.`
          : `Plan step "${failedId}" commit rejected — finish dependencies first.`;
        host.emitProgress(progressLabel);
      }

      agentLogInfo("execution.step_commit", {
        sessionId: host.session.id,
        result: "fail",
        stepId: failedId,
        waitingOn,
      });

      const resume = pinResume();
      if (!resume.ok) {
        return { status: "halt", errorMessage: resume.errorMessage };
      }
      return {
        status: "continue",
        turnContextPatch: {
          stepPhase: "working",
          currentStepId: ctx.plan.currentStep()?.id ?? null,
          stepClaimTx: null,
        },
        nodeContextPatch: {
          routeTarget: resume.pin,
          stepPhase: "working",
          currentStepId: ctx.plan.currentStep()?.id ?? null,
        },
      };
    }

    if (tx.verifyResult !== "pass") {
      const resume = pinResume();
      if (!resume.ok) {
        return { status: "halt", errorMessage: resume.errorMessage };
      }
      return {
        status: "continue",
        turnContextPatch: { stepCommitSkipped: true, stepClaimTx: null },
        nodeContextPatch: { routeTarget: resume.pin },
      };
    }

    const verifiedIds = tx.verifiedStepIds.length
      ? tx.verifiedStepIds
      : tx.pendingStepIds;

    const step = ctx.plan.currentStep();
    agentLogInfo("execution.step_commit", {
      sessionId: host.session.id,
      result: "pass",
      completedStepIds: verifiedIds,
      nextStepId: step?.id ?? null,
    });

    if (step) {
      host.emitProgress(`Executing ${step.title}…`);
    } else if (ctx.plan.readySteps().length > 0) {
      host.emitProgress(
        "Plan step committed — start the next step with update_plan…",
      );
    }

    const planDone = !ctx.plan.isActiveIncomplete();
    if (planDone) {
      ctx.plan.completeIfActive("completed");
      host.applySessionPatch({ planDoc: null, phase: null });
    }

    const donePin = planDone ? pinReflect() : pinResume();
    if (!donePin.ok) {
      return { status: "halt", errorMessage: donePin.errorMessage };
    }

    return {
      status: "continue",
      turnContextPatch: {
        stepCommitted: true,
        stepPhase: step ? "working" : "idle",
        currentStepId: step?.id ?? null,
        stepClaimTx: null,
      },
      nodeContextPatch: {
        routeTarget: donePin.pin,
        stepPhase: step ? "working" : "idle",
        currentStepId: step?.id ?? null,
      },
    };
  }
}
