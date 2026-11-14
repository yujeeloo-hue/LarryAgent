import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { getSessionPhase } from "../../../session/sessionPhase.js";
import { roleContextOf } from "./hostBridge.js";
import { boolParam, NodeActionStubBase } from "./NodeActionStubBase.js";

export const NodeActionCompleteActivePlanSchema: FsmParamsSchema = {
  type: "object",
  title: "Complete active plan",
  description:
    "Mark any active execution checklist completed. Hang on skill_reflect_gate " +
    "(Direct leftover at turn end) or plan_writer entry — not on Agent, whose " +
    "self-loop would close a checklist created in the same turn.",
  "x-llmDescription":
    "Close any active execution checklist as completed. whenPhaseUnset=true skips while the session phase is set (shared reflect-gate variant). Mount on reflect gates or plan_writer entry — never on a self-looping agent node, which would close a plan created in the same turn.",
  details: `Closes any active execution checklist via plan.completeIfActive('completed'). With whenPhaseUnset=true it skips (nodeContext.completeActivePlanSkipped='phase_set') while the session blackboard phase is set — the shared skill-reflect gate variant that still closes Direct-mode leftovers without cancelling a running executor plan.

Typical mounts: the skill-reflect gate (phase-unset variant) or plan_writer entry. Do not mount on the Agent self-loop, which would close a checklist created in the same turn.`,
  additionalProperties: false,
  properties: {
    whenPhaseUnset: {
      type: "boolean",
      default: false,
      title: "Only when phase is unset",
      description:
        "When true, skip if session blackboard phase is set (gathering / drafting / review / executing). " +
        "Use on the shared skill-reflect gate so Direct leftovers close without cancelling an executor plan.",
      "x-ui": "toggle",
    },
  },
};

export class NodeActionCompleteActivePlan extends NodeActionStubBase {
  readonly type = "NodeActionCompleteActivePlan";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const whenPhaseUnset = boolParam(this.params, "whenPhaseUnset", false);
    const host = args.host;
    if (!host) {
      return {
        status: "continue",
        nodeContextPatch: { completeActivePlan: true },
      };
    }
    const phase = getSessionPhase(host.session);
    if (whenPhaseUnset && phase) {
      return {
        status: "continue",
        nodeContextPatch: {
          completeActivePlan: false,
          completeActivePlanSkipped: "phase_set",
        },
      };
    }
    roleContextOf(host, args.turnContext).plan.completeIfActive("completed");
    return {
      status: "continue",
      nodeContextPatch: { completeActivePlan: true },
    };
  }
}
