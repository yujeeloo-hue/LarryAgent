import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import {
  boolParamPrefer,
  NodeActionStubBase,
} from "./NodeActionStubBase.js";

export const NodeActionSetPlanCardSchema: FsmParamsSchema = {
  type: "object",
  title: "Set plan card",
  description: "Show or hide the Plan card in the conversation UI for this turn.",
  "x-llmDescription": "Turn-scoped UI switch for the Plan card: visible (default true). No session mutation — ApplyToolEffects re-syncs persistence after plan tools run.",
  details: `Turn-scoped UI switch for the Plan card. Writes turnContext.planCardVisible from the visible param (legacy cardVisible alias; default true). No host call and no session patch — Apply tool effects later re-syncs session.plan.cardVisible to this flag after plan tools run, so the card appears only in turns whose graph opted in.`,
  additionalProperties: false,
  properties: {
    visible: {
      type: "boolean",
      default: true,
      title: "Plan card visible",
      description: "When true, the Plan card can appear after create_plan.",
      "x-ui": "toggle",
    },
  },
};

export class NodeActionSetPlanCard extends NodeActionStubBase {
  readonly type = "NodeActionSetPlanCard";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    void args;
    const visible = boolParamPrefer(this.params, "visible", "cardVisible", true);
    return {
      status: "continue",
      turnContextPatch: { planCardVisible: visible },
    };
  }
}
