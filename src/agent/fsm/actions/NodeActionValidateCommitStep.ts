import type { FsmParamsSchema } from "../paramsSchema.js";
import type { NodeActionConfig } from "../types.js";
import type { NodeActionBase } from "../NodeActionBase.js";
import { CompositeNodeActionBase } from "../CompositeNodeActionBase.js";
import { NodeActionCommitStepSchema } from "./NodeActionCommitStep.js";
import { createDefaultActionRegistry } from "./createDefaultActionRegistry.js";

/** Pin slots match Commit step — forwarded to the commit child. */
export const NodeActionValidateCommitStepSchema: FsmParamsSchema = {
  ...NodeActionCommitStepSchema,
  title: "Validate & commit step",
  description:
    "Composite: verify step dependsOn, then commit the claim group in one visit. Pin slots are forwarded to Commit step.",
  "x-llmDescription": "Composite validator visit: runs VerifyStep then CommitStep in one node visit, threading contexts between them. Forwards its two required pin slots onResume / onReflect verbatim to CommitStep.",
  details: `Composite used by execution_validator: runs Verify step then Commit step sequentially inside one visit, threading a private turnContext / nodeContext copy between the two children and merging both patch sets into the final result. A halt from either child aborts immediately.

The two pin slots (onResume / onReflect) are forwarded verbatim to the inner Commit step — there are no extra params.`,
};


/** Pure child description; the owning registry supplies both child implementations. */
export function describeNodeActionValidateCommitStepChildren(
  params: Readonly<Record<string, unknown>>,
): readonly NodeActionConfig[] {
  return [
    { type: "NodeActionVerifyStep", params: {} },
    { type: "NodeActionCommitStep", params: { ...params } },
  ];
}

export class NodeActionValidateCommitStep extends CompositeNodeActionBase {
  readonly type = "NodeActionValidateCommitStep";

  constructor(params: Record<string, unknown> = {}, children?: readonly NodeActionBase[]) {
    super(children ?? (() => createDefaultActionRegistry()
      .prepareAction("NodeActionValidateCommitStep", params, "NodeActionValidateCommitStep")
      .children.map((child) => child.create())));
  }
}
