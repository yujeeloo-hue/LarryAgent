import { syncStepFieldsFromPlan } from "../../domain/stepFsm.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type { NodeActionExecArgs, NodeActionExecResult } from "../types.js";
import { scopeOf } from "./hostBridge.js";
import { NodeActionStubBase, stringParam } from "./NodeActionStubBase.js";

export const NodeActionSyncPlanStepSchema: FsmParamsSchema = {
  type: "object",
  title: "Sync plan step",
  description: "Copy the current plan step into the visit, or explicitly reset step fields.",
  "x-llmDescription": "Copy the active execution step into this visit, or reset visit step fields. params: mode 'current' (default) | 'reset'; optional waitingMessage ('{step}' placeholder) and emptyWaitingMessage. Does not mutate the plan.",
  details: `Independent of role identity. mode=current reads the plan's current step; mode=reset clears visit step fields. Neither changes the plan or the cross-visit stepClaimTx. Optional waitingMessage substitutes {step} with the current title; emptyWaitingMessage is used when no step is running. Mount this action where the graph needs step state.`,
  additionalProperties: false,
  properties: {
    mode: {
      type: "string", enum: ["current", "reset"], default: "current",
      title: "Step state", "x-ui": "select",
    },
    waitingMessage: {
      type: "string", title: "Waiting message ({step})", "x-ui": "text",
    },
    emptyWaitingMessage: {
      type: "string", title: "Waiting message without a step", "x-ui": "text",
    },
  },
};

export class NodeActionSyncPlanStep extends NodeActionStubBase {
  readonly type = "NodeActionSyncPlanStep";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const mode = stringParam(this.params, "mode", "current");
    if (mode !== "current" && mode !== "reset") {
      return { status: "halt", errorMessage: "Invalid plan-step sync mode" };
    }
    const scope = args.host && mode === "current" ? scopeOf(args.turnContext) : undefined;
    const step = scope?.plan.currentStep();
    const patch = scope
      ? syncStepFieldsFromPlan(scope.plan)
      : {
          stepPhase: "idle", currentStepId: null,
          pendingVerifyStepIds: [], verifyResult: null,
        };
    const waiting = step
      ? stringParam(this.params, "waitingMessage")?.replaceAll("{step}", step.title)
      : stringParam(this.params, "emptyWaitingMessage");
    if (waiting) args.host?.emitProgress?.(waiting);
    return {
      status: "continue",
      turnContextPatch: { currentStepId: patch.currentStepId, stepPhase: patch.stepPhase },
      nodeContextPatch: { ...patch, ...(waiting !== undefined ? { progressLabel: waiting } : {}) },
    };
  }
}
