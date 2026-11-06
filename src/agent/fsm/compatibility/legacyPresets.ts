/** Frozen v1 → v2 migration data. Changes to current templates must not alter it. */
import type { FSMGraphNodeConfig, NodeActionConfig } from "../types.js";

export const NODE_END = "end";
export const NODE_EXECUTION_VALIDATOR = "execution_validator";
export const NODE_SKILL_REFLECT_GATE = "skill_reflect_gate";
export const NODE_SKILL_REFLECTOR = "skill_reflector";
export const ROUTE_TARGET_REFLECT_DONE = "end";
export const SESSION_PHASE_BLACKBOARD_KEY = "phase";
export const ASK_MODE_ALLOW_TOOL_PATTERNS: readonly string[] = [
  "read_file",
  "list_dir",
  "grep",
  "read_skill",
  "search_skills",
  "read_user_memory",
  "read_project_memory",
  "read_image",
  "display_image",
  "display_pdf",
  "search_session_history",
  "get_workspace_path",
  "get_current_time",
  "batch_search",
  "search_tools",
  "tool_describe",
  "tool_call",
  "ask_user",
  "mcp__tavily__*",
  "mcp__jnote__list_*",
  "mcp__jnote__search_*",
  "mcp__jnote__get_*"
];
type LegacyPinFields = {
  selectKeys: readonly string[];
  mapKeys: readonly string[];
  bindingKeys: readonly string[];
};

// Captured Pin slots, independent of future Action schema changes.
export const LEGACY_PIN_FIELDS: Readonly<Record<string, LegacyPinFields>> = {
  NodeActionApplyControlIntent: { selectKeys: ["onDiscarded","onRejected","onApproved"], mapKeys: [], bindingKeys: [] },
  NodeActionApplyToolEffects: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionAwaitSubagents: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionBuildModelWindow: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionCallModel: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionCheckPlan: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionClearPlanDraft: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionCommitStep: { selectKeys: ["onResume","onReflect"], mapKeys: [], bindingKeys: [] },
  NodeActionCompare: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionCompleteActivePlan: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionDetectStepClaim: { selectKeys: ["onStepClaim"], mapKeys: [], bindingKeys: [] },
  NodeActionDisableTools: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionEmitRouteEvent: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionEmitRouteEventWhen: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionFillEmptyAssistant: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionFinishIdle: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionNotifyTaskDone: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionPrepareRole: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionPrepareTools: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionPromptInject: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionReadBlackboard: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionRoleRoundBuilder: { selectKeys: ["onStepClaim"], mapKeys: [], bindingKeys: [] },
  NodeActionRoundGate: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionRouteTo: { selectKeys: ["defaultPin"], mapKeys: [], bindingKeys: ["when","routes"] },
  NodeActionRunShell: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionRunTools: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionSetPlanApprovalPending: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionSetPlanCard: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionStartTurn: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionSyncPlanStep: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionValidateCommitStep: { selectKeys: ["onResume","onReflect"], mapKeys: [], bindingKeys: [] },
  NodeActionVerifyStep: { selectKeys: [], mapKeys: [], bindingKeys: [] },
  NodeActionWriteBlackboard: { selectKeys: [], mapKeys: [], bindingKeys: [] },
};

const ROLE_PRESETS: Readonly<Record<string, Record<string, unknown>>> = {
  "agent": {
    "personaLabel": "AGENT",
    "modelBinding": "agent",
    "promptPlacement": "persona",
    "waitingMessage": "Waiting for model…",
    "promptPreset": "agent"
  },
  "analyser": {
    "personaLabel": "ANALYSER",
    "modelBinding": "agent",
    "promptPlacement": "system",
    "waitingMessage": "Analysing context…",
    "promptPreset": "analyser"
  },
  "planner": {
    "personaLabel": "PLANNER",
    "modelBinding": "planner",
    "promptPlacement": "system",
    "waitingMessage": "Planning…",
    "promptPreset": "planner"
  },
  "plan_writer": {
    "personaLabel": "PLAN_WRITER",
    "modelBinding": "planWriter",
    "promptPlacement": "system",
    "waitingMessage": "Writing plan document…",
    "promptPreset": "plan_writer"
  },
  "plan_reviewer": {
    "personaLabel": "PLAN_REVIEWER",
    "modelBinding": "planWriter",
    "promptPlacement": "system",
    "waitingMessage": "Reviewing plan…",
    "promptPreset": "plan_reviewer"
  },
  "executor": {
    "personaLabel": "EXECUTOR",
    "modelBinding": "executor",
    "promptPlacement": "system",
    "waitingMessage": "Executing…",
    "promptPreset": "executor"
  },
  "replanner": {
    "personaLabel": "REPLANNER",
    "modelBinding": "replanner",
    "promptPlacement": "system",
    "waitingMessage": "Replanning…",
    "promptPreset": "replanner"
  },
  "subagent": {
    "personaLabel": "SUBAGENT",
    "modelBinding": "subagent",
    "promptPlacement": "persona",
    "waitingMessage": "Waiting for model…",
    "promptPreset": "subagent"
  }
};
export function rolePresetParams(preset: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const template = preset === "custom" ? "agent" : preset;
  return { roleKind: preset, personaLabel: "ROLE", modelBinding: "sessionDefault", promptPlacement: "system", waitingMessage: "Waiting for model…", ...(Object.hasOwn(ROLE_PRESETS, template) ? ROLE_PRESETS[template] : {}), ...overrides };
}
export function presetPlanStepAction(preset: string, waitingMessage?: unknown): NodeActionConfig {
  return { type: "NodeActionSyncPlanStep", params: preset === "executor" ? { mode: "current", ...(typeof waitingMessage !== "string" ? { waitingMessage: "Executing {step}…", emptyWaitingMessage: "Executing…" } : {}) } : { mode: "reset" } };
}

const GATE_ACTIONS: NodeActionConfig[] = [
  {
    "type": "NodeActionCompare",
    "params": {
      "source": "autoSkillSummarize",
      "operator": "==",
      "value": "true",
      "asKey": "reflect.auto"
    }
  },
  {
    "type": "NodeActionCompare",
    "params": {
      "source": "fullPermissions",
      "operator": "==",
      "value": "true",
      "asKey": "reflect.fullPerms"
    }
  },
  {
    "type": "NodeActionCompare",
    "params": {
      "source": "modelIterations",
      "type": "int",
      "operator": ">",
      "value": 8,
      "asKey": "reflect.enoughIters"
    }
  },
  {
    "type": "NodeActionCompare",
    "params": {
      "source": "toolFailureCount",
      "type": "int",
      "operator": ">=",
      "value": 1,
      "asKey": "reflect.enoughFails"
    }
  },
  {
    "type": "NodeActionRouteTo",
    "params": {
      "when": [
        {
          "expr": "reflect.auto && reflect.fullPerms && reflect.enoughIters && reflect.enoughFails",
          "to": "skill_reflector"
        }
      ],
      "defaultPin": "end"
    }
  }
];
const REFLECTOR_ACTIONS: NodeActionConfig[] = [
  {
    "type": "NodeActionRoundGate",
    "params": {}
  },
  {
    "type": "NodeActionPrepareRole",
    "params": {
      "roleKind": "skill_reflector",
      "personaLabel": "AGENT",
      "modelBinding": "agent",
      "promptPlacement": "persona",
      "waitingMessage": "Reviewing skills…",
      "promptPreset": "agent",
      "rolePromptInline": "Review the turn and decide whether to save a reusable skill."
    }
  },
  {
    "type": "NodeActionSyncPlanStep",
    "params": {
      "mode": "reset"
    }
  },
  {
    "type": "NodeActionPromptInject",
    "params": {
      "source": "routeGuide",
      "placement": "system",
      "routeGuide": [
        {
          "when": "reflect is complete or nothing qualifies to save",
          "routeTo": "done"
        },
        {
          "when": "another reflect round is needed after tool use",
          "routeTo": "continue"
        }
      ]
    }
  },
  {
    "type": "NodeActionPrepareTools",
    "params": {
      "allowTools": [
        "search_skills",
        "read_skill",
        "create_skill",
        "update_skill",
        "write_skill_file",
        "list_dir",
        "read_file",
        "fsm_route"
      ],
      "useOfferSet": false
    }
  },
  {
    "type": "NodeActionBuildModelWindow",
    "params": {}
  },
  {
    "type": "NodeActionCallModel",
    "params": {
      "waitingMessage": "Reviewing skills…"
    }
  },
  {
    "type": "NodeActionRunTools",
    "params": {}
  },
  {
    "type": "NodeActionApplyToolEffects",
    "params": {}
  },
  {
    "type": "NodeActionEmitRouteEvent",
    "params": {}
  },
  {
    "type": "NodeActionRouteTo",
    "params": {
      "routes": [
        {
          "event": "stay",
          "to": "skill_reflector"
        },
        {
          "event": "leave",
          "to": "end"
        },
        {
          "event": "done",
          "to": "end"
        },
        {
          "event": "continue",
          "to": "skill_reflector"
        }
      ]
    }
  }
];
export function skillReflectGateActions(): NodeActionConfig[] { return structuredClone(GATE_ACTIONS); }
export function skillReflectorActions(): NodeActionConfig[] { return structuredClone(REFLECTOR_ACTIONS); }
export const skillReflectGateNode: FSMGraphNodeConfig = {
  id: NODE_SKILL_REFLECT_GATE,
  name: "Skill reflect gate",
  pins: [{ name: NODE_SKILL_REFLECTOR }, { name: NODE_END }],
  actions: skillReflectGateActions(),
};
