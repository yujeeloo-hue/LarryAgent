/** Historical v1 graph compatibility; independent of current graph presets. */
import { NODE_SKILL_REFLECT_GATE, NODE_END, NODE_EXECUTION_VALIDATOR } from "./legacyPresets.js";

export const NODE_ACTION_TYPE_ALIASES: Readonly<Record<string, string>> = {
  NodeActionRoundHead: "NodeActionRoundGate",
  NodeActionAdvanceRole: "NodeActionRouteTo",
  NodeActionRouteAfterRound: "NodeActionRouteTo",
  NodeActionFinalizeEmptyAssistant: "NodeActionFillEmptyAssistant",
  NodeActionPrepareModelWindow: "NodeActionBuildModelWindow",
  NodeActionStreamModelRound: "NodeActionCallModel",
  NodeActionRunToolsPhase: "NodeActionRunTools",
  NodeActionSetPlanPresentation: "NodeActionSetPlanCard",
  NodeActionAwaitSubagentBatches: "NodeActionAwaitSubagents",
  NodeActionSkillReflectAdvance: "NodeActionRouteTo",
  NodeActionRouteSkillReflect: "NodeActionRouteTo",
  NodeActionExecutionValidator: "NodeActionValidateCommitStep",
  NodeActionBumpReplanCount: "NodeActionWriteBlackboard",
  NodeActionRouteToIf: "NodeActionRouteTo",
};

/** Old specialized RouteAfter types → unified RouteTo. */
export const SPECIALIZED_ROUTE_AFTER_TYPES: ReadonlySet<string> = new Set([
  "NodeActionAnalyserRouteAfter",
  "NodeActionPlanReviewerRouteAfter",
  "NodeActionPlanWriterRouteAfter",
  "NodeActionPlanChecklistRouteAfter",
  "NodeActionExecutorRouteAfter",
]);

/**
 * Legacy semantic pin names → target node ids (pin.name === edge.to).
 */
export const PIN_NAME_ALIASES: Readonly<Record<string, string>> = {
  reflect: NODE_SKILL_REFLECT_GATE,
  reflect_done: NODE_END,
  step_claim: NODE_EXECUTION_VALIDATOR,
};

export function resolveActionType(type: string): string {
  const trimmed = type.trim();
  if (SPECIALIZED_ROUTE_AFTER_TYPES.has(trimmed)) {
    return "NodeActionRouteTo";
  }
  return Object.hasOwn(NODE_ACTION_TYPE_ALIASES, trimmed)
    ? NODE_ACTION_TYPE_ALIASES[trimmed]! : trimmed;
}

export function resolvePinName(name: string): string {
  const trimmed = name.trim();
  return Object.hasOwn(PIN_NAME_ALIASES, trimmed) ? PIN_NAME_ALIASES[trimmed]! : trimmed;
}

