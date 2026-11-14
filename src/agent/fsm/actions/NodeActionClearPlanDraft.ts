import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { roleContextOf } from "./hostBridge.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";

/**
 * Clear turn-scoped pending plan draft (and any leftover checklist pointer).
 * Mount on plan_reviewer entry after write_plan_doc hands off.
 */
export const NodeActionClearPlanDraftSchema: FsmParamsSchema = {
  type: "object",
  title: "Clear plan draft",
  description:
    "Clear pendingPlanDraft and any leftover Session.plan pointer (typically on plan_reviewer entry).",
  "x-llmDescription": "Drop pendingPlanDraft and any stale Session.plan pointer on entry to the reviewing role. No params, no routing.",
  details: `Clears turnState.pendingPlanDraft and nulls the session plan pointer (plan.set(null)). Mounted on plan_reviewer entry after write_plan_doc handed the draft off, so no stale checklist pointer or draft survives into execution. No routing side effects.`,
  additionalProperties: false,
  properties: {},
};

export class NodeActionClearPlanDraft extends NodeActionStubBase {
  readonly type = "NodeActionClearPlanDraft";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const host = args.host;
    if (!host) {
      return {
        status: "continue",
        nodeContextPatch: { clearPlanDraft: true },
      };
    }
    const ctx = roleContextOf(host, args.turnContext);
    delete ctx.state.pendingPlanDraft;
    ctx.plan.set(null);
    return {
      status: "continue",
      nodeContextPatch: { clearPlanDraft: true },
    };
  }
}
