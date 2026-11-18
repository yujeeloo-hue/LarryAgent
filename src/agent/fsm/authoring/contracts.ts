import type { NodeActionConfig } from "../types.js";
export const GRAPH_DESIGN_GUIDE = {
  nodeBoundary: "Create a node for an independently entered stage, role, decision, deterministic operation or retry boundary. Keep actions sharing visit-local messages, tools and results in the same node.",
  scopes: {
    graphContext: "Persistent editing draft. Never supplies runtime data.",
    node: "Fresh on EVERY node visit, including implicit self-loops. Prepared role, tools, messages, tool calls and shell results are visit-local.",
    turn: "Shared across node transitions within one turn. Compare writes its asKey flags here.",
    session: "Persisted session blackboard across turns. ReadBlackboard materializes values into turn context; PromptInject exposes values to the model. EdgeWhen source=session reads the runtime session view, not arbitrary blackboard keys."
  },
  execution: ["Actions run in array order. A halt stops remaining actions and prevents edge evaluation. Terminal-node actions run before the graph finishes.", "All outgoing edge predicates are evaluated: exactly one must match. Edge order is NOT priority. EdgeAlways must be the only outgoing edge.", "With selfLoop=true, ZERO matching edges re-enters this node with fresh node context. Multiple matches still fail. An intentionally unwired stay pin is valid for this pattern.", "Routing chain: event/Compare flag -> RouteTo -> local pin -> connection -> destination node. Pin names and node ids are separate identifiers.", "RouteTo explicit events take precedence over when rows, then stay/leave fallback. Within when[], the first matching expression wins.", "roleKind is identity only. Configure prompt, model and tool policy explicitly. An empty allowTools list does not restrict tools.", "Validation never executes actions. Static validity does not prove all model-driven branches; inspect warnings and use scripted scenarios for behavioral checks."]
};
const round = ["NodeActionRoundGate", "NodeActionPrepareRole", "NodeActionPrepareTools", "NodeActionBuildModelWindow", "NodeActionCallModel", "NodeActionRunTools", "NodeActionApplyToolEffects", "NodeActionEmitRouteEvent", "NodeActionRouteTo"];
export const NODE_PATTERNS = {
  entry: {
    when: "Turn initialization and optional phase/resume routing.",
    recommended: ["NodeActionStartTurn"],
    parameters: "StartTurn {}. Add Compare/RouteTo only when choosing an entry branch."
  },
  model_round: {
    when: "An agent, planner, executor or reviewer performs one model/tool round per visit.",
    recommended: round,
    parameters: "PrepareRole requires roleKind; explicitly choose promptPreset or rolePromptInline/rolePromptFile and modelBinding. PrepareTools defines tool policy. RouteTo needs event-to-local-pin mappings. AwaitSubagents, PromptInject, DisableTools and SyncPlanStep are conditional additions."
  },
  decision: {
    when: "Branch deterministically using state, counters, plan status or approval.",
    recommended: ["NodeActionCompare", "NodeActionRouteTo"],
    parameters: "Compare writes asKey; source=blackboard also requires key and explicit scope where appropriate. RouteTo when [{expr,to}] reads turn flags; defaultPin handles no matching condition."
  },
  shell: {
    when: "Execute a fixed command or script and branch on its result.",
    recommended: ["NodeActionRunShell"],
    parameters: "Exactly one of command/scriptPath. cwd and timeoutMs optional. Set onError=continue if outgoing EdgeWhen predicates should handle failures; results are node-local shellExitCode/shellStdout/shellStderr."
  },
  data: {
    when: "Read/write deterministic turn or persisted session data.",
    recommended: ["NodeActionReadBlackboard", "NodeActionWriteBlackboard"],
    parameters: "key required; scope turn(default) or session. Write set requires value. Reserved runtime keys are forbidden. ReadBlackboard does not expose data to the model; use PromptInject source=blackboard."
  },
  end: {
    when: "Finish this turn after any required cleanup.",
    recommended: ["NodeActionFillEmptyAssistant", "NodeActionFinishIdle"],
    parameters: "Usually {}. NotifyTaskDone is optional for task completion; control/child turns do not require it."
  },
  custom: {
    when: "Specialized sequences, cached tool dispatch, commit validation or compositions.",
    recommended: [],
    parameters: "Describe each action. Composite children execute in order in the SAME visit; dependencies and pin references are validated recursively. No model chain is imposed on deterministic or cached-dispatch nodes."
  }
} as const;
export type NodePattern = keyof typeof NODE_PATTERNS;
export type ActionContract = {
  requires?: string[];
  provides?: string[];
  example: Record<string, unknown>;
  guidance: string;
};
export const ACTION_CONTRACTS: Record<string, ActionContract> = {
  NodeActionPrepareRole: {
    provides: ["iterationSpec"],
    example: {
      roleKind: "reviewer",
      rolePromptInline: "Review the work and report concrete issues.",
      modelBinding: "sessionDefault"
    },
    guidance: "roleKind is required and only labels identity. Prompt priority: inline > file > preset. Model, prompt placement and tools are independent settings."
  },
  NodeActionPrepareTools: {
    provides: ["tools"],
    example: {},
    guidance: "Run before building the model window. allowTools=[] means no whitelist. Choose toolPolicy explicitly for child roles; apply DisableTools before BuildModelWindow."
  },
  NodeActionBuildModelWindow: {
    requires: ["iterationSpec"],
    provides: ["messages"],
    example: {},
    guidance: "Requires PrepareRole in this visit. Standard pattern also runs PrepareTools first. Place PromptInject and tool-policy changes before this action."
  },
  NodeActionCallModel: {
    requires: ["messages", "tools"],
    provides: ["modelRound"],
    example: {},
    guidance: "Requires BuildModelWindow earlier in the same visit. A predecessor node's window is lost on transition. Optional waitingMessage and disableReasoning."
  },
  NodeActionRunTools: {
    example: {},
    guidance: "Consume current tool calls after CallModel or a specialized dispatch producer such as EdgDispatch. Keep ApplyToolEffects after this action when applying tool-driven state changes."
  },
  NodeActionApplyToolEffects: {
    example: {},
    guidance: "Apply tool effects after RunTools, before EmitRouteEvent and RouteTo in the standard model round."
  },
  NodeActionCompare: {
    example: {
      source: "planPresent",
      asKey: "plan.exists"
    },
    guidance: "Writes a boolean turn flag, never routes by itself. source=blackboard requires key; asKey is always required. Feed asKey into a later RouteTo when expression."
  },
  NodeActionRouteTo: {
    provides: ["routeTarget"],
    example: {
      routes: [{
        event: "stay",
        to: "again"
      }, {
        event: "leave",
        to: "done"
      }]
    },
    guidance: "to/defaultPin name LOCAL PINS, not destination nodes. Bind them to connections, or intentionally leave a stay pin unwired on a selfLoop node. when rows are first-match; outgoing edges are not. Describe with contextId/nodeId to see actual pins."
  },
  NodeActionApplyControlIntent: {
    provides: ["routeTarget"],
    example: {
      onApproved: "approved",
      onRejected: "rejected",
      onDiscarded: "discarded"
    },
    guidance: "Consumes UI approval/discard intent on entry. All three local pin slots are required. With no control intent it continues without choosing a route; add ordinary entry routing for that case."
  },
  NodeActionCommitStep: {
    provides: ["routeTarget"],
    example: {
      onResume: "resume",
      onReflect: "reflect"
    },
    guidance: "Commit a previously verified claim transaction. The two required local pins choose resumption or reflection; normally use the ValidateCommitStep composite to run VerifyStep first."
  },
  NodeActionDetectStepClaim: {
    provides: ["routeTarget"],
    example: {
      onStepClaim: "validate"
    },
    guidance: "Read this visit's executor tool calls and open a cross-visit claim transaction. Only a detected claim selects onStepClaim; the standard RouteTo handles the remaining cases."
  },
  NodeActionEdgDispatch: {
    provides: ["toolCalls"],
    example: {},
    guidance: "Specialized cached tool-call dispatch producer for the reuse lane; followed by RunTools without a model call on this node."
  },
  NodeActionRunShell: {
    provides: ["shellResult"],
    example: {
      command: "printf 'ready\\n'",
      onError: "continue"
    },
    guidance: "Exactly one command/scriptPath. timeoutMs defaults to 60000. Branch on node-local shellExitCode; onError=halt stops before edges, so choose continue for explicit failure routing."
  },
  NodeActionReadBlackboard: {
    example: {
      key: "phase",
      scope: "session",
      asKey: "saved.phase"
    },
    guidance: "Copies turn/session data to turnContext. Does not render it to the model. strict=true halts on missing input/capability."
  },
  NodeActionWriteBlackboard: {
    example: {
      key: "phase",
      scope: "session",
      value: "reviewing"
    },
    guidance: "scope=turn is per turn; session persists. mode=set requires value; increment defaults to 1; multiply needs a numeric operand. Runtime-reserved keys are forbidden."
  },
  NodeActionPromptInject: {
    example: {
      source: "blackboard"
    },
    guidance: "Render data into the model input before BuildModelWindow. Reading state and making it visible to the model are distinct operations."
  }
};
export function inferNodePattern(node: {
  id: string;
  actions?: NodeActionConfig[];
}, entry: string, terminal: string): NodePattern {
  if (node.id === entry) return "entry";
  if (node.id === terminal) return "end";
  const types = new Set((node.actions ?? []).map(a => a.type));
  if (types.has("NodeActionCallModel") || types.has("NodeActionRoleRoundBuilder")) return "model_round";
  if (types.has("NodeActionRunShell")) return "shell";
  if (types.has("NodeActionCompare")) return "decision";
  if (types.has("NodeActionReadBlackboard") || types.has("NodeActionWriteBlackboard")) return "data";
  return "custom";
}
