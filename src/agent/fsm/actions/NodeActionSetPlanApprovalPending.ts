import { withPlanDocApprovalPending } from "../../../session/planDoc.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { boolParam, NodeActionStubBase } from "./NodeActionStubBase.js";

/**
 * Set or clear planDoc.approvalPending (Approve chrome).
 * Mount clear on plan_writer / planner entry; ready→true comes from fsm_route sessionPatch.
 */
export const NodeActionSetPlanApprovalPendingSchema: FsmParamsSchema = {
  type: "object",
  title: "Set plan approval pending",
  description:
    "Set or clear planDoc.approvalPending for the Approve | Discard bar.",
  "x-llmDescription": "Set or clear planDoc.approvalPending (the Approve | Discard bar): pending default false. Mount the clear on plan_writer / planner entry so a finished review leaves no bar.",
  details: `Sets or clears planDoc.approvalPending (the Approve | Discard chrome) via withPlanDocApprovalPending + host.applySessionPatch; a no-op when the session has no planDoc. pending=true normally arrives through the fsm_route tool effect; graphs mount the clear on plan_writer / planner entry so a finished review doesn't leave the bar up.`,
  additionalProperties: false,
  properties: {
    pending: {
      type: "boolean",
      default: false,
      title: "Pending",
      description: "When true, show Approve chrome; when false, clear it.",
      "x-ui": "toggle",
    },
  },
};

export class NodeActionSetPlanApprovalPending extends NodeActionStubBase {
  readonly type = "NodeActionSetPlanApprovalPending";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const pending = boolParam(this.params, "pending", false);
    const host = args.host;
    if (!host) {
      return {
        status: "continue",
        nodeContextPatch: { approvalPending: pending },
      };
    }
    const next = withPlanDocApprovalPending(host.session.planDoc, pending);
    if (next) {
      host.applySessionPatch({ planDoc: next });
    }
    return {
      status: "continue",
      nodeContextPatch: { approvalPending: pending },
    };
  }
}
