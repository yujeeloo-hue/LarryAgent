import type { FsmParamsSchema } from "../paramsSchema.js";
import { createDefaultActionRegistry } from "./createDefaultActionRegistry.js";
import type {
  NodeActionConfig,
} from "../types.js";
import { CompositeNodeActionBase } from "../CompositeNodeActionBase.js";
import { FSMConfigError } from "../FSMConfigError.js";
import type { NodeActionBase } from "../NodeActionBase.js";
import { rolePresetParams } from "../configs/rolePresets.js";
import { NodeActionPrepareRoleSchema } from "./NodeActionPrepareRole.js";
import { NodeActionPrepareToolsSchema } from "./NodeActionPrepareTools.js";
import { NodeActionSyncPlanStepSchema } from "./NodeActionSyncPlanStep.js";
import { NodeActionCallModelSchema } from "./NodeActionCallModel.js";

export const NodeActionRoleRoundBuilderSchema: FsmParamsSchema = {
  type: "object",
  title: "Role round builder",
  description:
    "Composite: run a full role round (prepare → tools → model → route) in one visit.",
  "x-llmDescription": "Composite that runs a full react-style round in one visit: RoundGate, PrepareRole, PrepareTools, BuildModelWindow, CallModel, RunTools, ApplyToolEffects, EmitRouteEvent, AwaitSubagents, RouteTo. Omit steps to use that default chain; otherwise steps is an explicit ordered list of NodeAction configs. routeTo mappings are required; detectStepClaim + onStepClaim add executor claim detection.",
  details: `Convenience composite for custom graphs. Runs an ordered list of existing NodeActions sequentially, threading turnContext / nodeContext between children and halting on the first child halt.

When steps is omitted, mounts the default react-style round: RoundGate → PrepareRole → PrepareTools → BuildModelWindow → CallModel → RunTools → ApplyToolEffects → EmitRouteEvent → AwaitSubagents → RouteTo. prepareRole, prepareTools and callModel provide explicit settings. syncPlanStep optionally mounts SyncPlanStep after PrepareRole. routeTo must supply route mappings; detectStepClaim requires an explicit onStepClaim pin. roleKind is an identity label only.`,
  additionalProperties: false,
  properties: {
    steps: {
      type: "array",
      title: "Child steps",
      description:
        "Explicit ordered NodeAction configs. When omitted, the default react-style round is used.",
      items: { type: "object" },
      "x-ui": "collapsible-textarea",
    },
    roleKind: {
      type: "string",
      title: "Role kind",
      description: "Optional identity label only. Model and prompt settings use prepareRole.",
      "x-ui": "text",
    },
    prepareRole: {
      type: "object", title: "Prepare role settings",
      properties: NodeActionPrepareRoleSchema.properties!, "x-ui": "object-fields",
    },
    prepareTools: {
      type: "object", title: "Prepare tools settings",
      properties: NodeActionPrepareToolsSchema.properties!, "x-ui": "object-fields",
    },
    callModel: {
      type: "object", title: "Call model settings",
      description: "Optional settings for the default Call model child.",
      additionalProperties: NodeActionCallModelSchema.additionalProperties ?? true,
      properties: NodeActionCallModelSchema.properties!, "x-ui": "object-fields",
    },
    syncPlanStep: {
      type: "object", title: "Plan step settings",
      description: "When configured, mount Sync plan step after Prepare role.",
      properties: NodeActionSyncPlanStepSchema.properties!, "x-ui": "object-fields",
    },
    disableToolNames: {
      type: "array",
      items: { type: "string" },
      default: [],
      title: "Disable tool names",
      "x-ui": "string-list",
    },
    allowTools: {
      type: "array",
      items: { type: "string" },
      default: [],
      title: "Allow tools",
      "x-ui": "string-list",
    },
    awaitSubagents: {
      type: "boolean",
      default: true,
      title: "Await subagents",
      "x-ui": "toggle",
    },
    detectStepClaim: {
      type: "boolean",
      default: false,
      title: "Detect step claim",
      description: "Append DetectStepClaim before RouteTo (executor-style).",
      "x-ui": "toggle",
    },
    onStepClaim: {
      type: "string",
      title: "Step-claim pin",
      description: "DetectStepClaim.onStepClaim when detectStepClaim is true.",
      "x-ui": "text",
    },
    routeTo: {
      type: "object",
      title: "RouteTo params",
      description: "Explicit route mappings for the trailing NodeActionRouteTo child.",
      "x-ui": "collapsible-textarea",
    },
  },
};

function defaultRoleRoundSteps(
  params: Readonly<Record<string, unknown>>,
): NodeActionConfig[] {
  const prepareRole = {
    ...rolePresetParams("agent"),
    ...(params.prepareRole as Record<string, unknown> | undefined),
    ...(typeof params.roleKind === "string" && params.roleKind.trim()
      ? { roleKind: params.roleKind.trim() }
      : {}),
  };
  const disableToolNames = Array.isArray(params.disableToolNames)
    ? params.disableToolNames.filter(
        (n): n is string => typeof n === "string" && n.length > 0,
      )
    : [];
  const allowTools = Array.isArray(params.allowTools)
    ? params.allowTools.filter(
        (n): n is string => typeof n === "string" && n.length > 0,
      )
    : [];
  const steps: NodeActionConfig[] = [
    { type: "NodeActionRoundGate", params: {} },
    { type: "NodeActionPrepareRole", params: prepareRole },
    ...(params.syncPlanStep && typeof params.syncPlanStep === "object" && !Array.isArray(params.syncPlanStep)
      ? [{ type: "NodeActionSyncPlanStep", params: params.syncPlanStep as Record<string, unknown> }]
      : []),
    {
      type: "NodeActionPrepareTools",
      params: {
        ...(params.prepareTools as Record<string, unknown> | undefined),
        ...(allowTools.length > 0 ? { allowTools } : {}),
      },
    },
  ];
  if (disableToolNames.length > 0) {
    steps.push({
      type: "NodeActionDisableTools",
      params: { toolNames: disableToolNames, merge: true },
    });
  }
  steps.push(
    { type: "NodeActionBuildModelWindow", params: {} },
    {
      type: "NodeActionCallModel",
      params: { ...(params.callModel as Record<string, unknown> | undefined) },
    },
    { type: "NodeActionRunTools", params: {} },
    { type: "NodeActionApplyToolEffects", params: {} },
    { type: "NodeActionEmitRouteEvent", params: {} },
  );
  if (params.awaitSubagents !== false) {
    steps.push({ type: "NodeActionAwaitSubagents", params: {} });
  }
  if (params.detectStepClaim === true) {
    const onStepClaim =
      typeof params.onStepClaim === "string" && params.onStepClaim.trim()
        ? params.onStepClaim.trim()
        : "";
    steps.push({
      type: "NodeActionDetectStepClaim",
      params: { onStepClaim },
    });
  }
  const routeParams =
    params.routeTo && typeof params.routeTo === "object" && !Array.isArray(params.routeTo)
      ? (params.routeTo as Record<string, unknown>)
      : {};
  steps.push({ type: "NodeActionRouteTo", params: routeParams });
  return steps;
}

/** Pure ordered child contract, shared by validation and hydration. */
export function describeNodeActionRoleRoundBuilderChildren(
  params: Readonly<Record<string, unknown>>,
  label: string,
): readonly NodeActionConfig[] {
  if (params.steps !== undefined) {
    if (!Array.isArray(params.steps)) {
      throw new FSMConfigError("INVALID_ACTION_PARAMS", `${label}: steps must be an array`);
    }
    // Child shape, schemas and semantics are validated by the owning registry.
    return params.steps as NodeActionConfig[];
  }
  const routes = params.routeTo;
  if (!routes || typeof routes !== "object" || Array.isArray(routes)) {
    throw new FSMConfigError("INVALID_ACTION_PARAMS", `${label}: requires explicit routeTo settings`);
  }
  if (params.detectStepClaim === true &&
      (typeof params.onStepClaim !== "string" || !params.onStepClaim.trim())) {
    throw new FSMConfigError("INVALID_ACTION_PARAMS", `${label}: requires an explicit onStepClaim pin`);
  }
  return defaultRoleRoundSteps(params);
}

/** Default role-round composition; graph hydration always supplies prepared children. */
export class NodeActionRoleRoundBuilder extends CompositeNodeActionBase {
  readonly type = "NodeActionRoleRoundBuilder";

  constructor(params: Record<string, unknown> = {}, children?: readonly NodeActionBase[]) {
    super(children ?? (() => createDefaultActionRegistry()
      .prepareAction("NodeActionRoleRoundBuilder", params, "NodeActionRoleRoundBuilder")
      .children.map((child) => child.create())));
  }
}
