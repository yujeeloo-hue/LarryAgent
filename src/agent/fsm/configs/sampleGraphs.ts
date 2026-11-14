import { SUBAGENT_TOOL_DENYLIST } from "../../subagents/constants.js";
import { getDefaultSkillReflectPrompt } from "../../../settings/promptDefaults.js";
import {
  NODE_END,
  NODE_SKILL_REFLECT_GATE,
  NODE_SKILL_REFLECTOR,
  NODE_EXECUTION_VALIDATOR,
  NODE_START,
} from "../constants.js";
import {
  ROUTE_TARGET_REFLECT,
  ROUTE_TARGET_REFLECT_DONE,
  ROUTE_TARGET_STEP_CLAIM,
} from "../actions/NodeActionRouteTo.js";
import { EDG_REUSE_EVENT } from "../actions/edgBank.js";
import {
  SKILL_REFLECT_FLAG_AUTO,
  SKILL_REFLECT_FLAG_ENOUGH_ITERS,
  SKILL_REFLECT_FLAG_FULL_PERMS,
  SKILL_REFLECT_FLAG_LONG_RUN,
  SKILL_REFLECT_FLAG_RECOVERED,
  SKILL_REFLECT_FLAG_USED_SKILL,
  SKILL_REFLECT_GATE_EXPR,
  SKILL_REFLECT_LONG_RUN_ITERATIONS,
  SKILL_REFLECT_MIN_MODEL_ITERATIONS,
  SKILL_REFLECT_MIN_RECOVERIES,
  SKILL_REFLECT_MIN_SKILLS_READ,
  SKILL_REFLECT_TOOL_ALLOWLIST,
} from "../skillReflectConstants.js";
import { pinsFromNames } from "../pinRouting.js";
import {
  createFSMGraphConfig,
  type FSMGraphConfig,
  type FSMGraphNodeConfig,
  type NodeActionConfig,
} from "../types.js";
import { ASK_MODE_ALLOW_TOOL_PATTERNS, ASK_MODE_DENYLIST } from "../../policy/askMode.js";
import {
  ANALYSER_DENYLIST,
  FSM_ROUTE_TOOL_NAME,
  PLAN_DIRECT_DENYLIST,
} from "../../policy/planExecute.js";
import { SESSION_PHASE_BLACKBOARD_KEY } from "../../../session/sessionPhase.js";
import { presetPlanStepAction, rolePresetParams } from "./rolePresets.js";

/** Write workflow phase onto the session blackboard (replaces SetPhase). */
function writeSessionPhase(phase: string | null): NodeActionConfig {
  return {
    type: "NodeActionWriteBlackboard",
    params: {
      key: SESSION_PHASE_BLACKBOARD_KEY,
      scope: "session",
      value: phase,
    },
  };
}

/** Phase flags are separate from the entry routing priority table. */
function phaseResumeCompareActions(phases: readonly string[]): NodeActionConfig[] {
  return phases.map((phase) => ({
    type: "NodeActionCompare",
    params: {
      source: "blackboard",
      key: SESSION_PHASE_BLACKBOARD_KEY,
      scope: "session",
      type: "string",
      operator: "==",
      value: phase,
      asKey: `resume.phase.${phase}`,
    },
  }));
}

export type SubagentGraphConfigOptions = {
  /**
   * Explicit PrepareTools policy variant.
   * Default `general`. Explore/worker still share this loop topology;
   * Host-side allowlist for explore lands with PrepareTools.
   */
  subagentRole?: "general" | "explore" | "worker";
};

type RoleKindName = string;

/** Shared RouteTo: event → pin bindings (stay/leave always). */
function routeAfterParams(
  stayPin: string,
  extra: Record<string, string> = {},
): Record<string, unknown> {
  return {
    routes: [
      { event: "stay", to: stayPin },
      { event: "leave", to: ROUTE_TARGET_REFLECT },
      ...Object.entries(extra).map(([event, to]) => ({ event, to })),
    ],
  };
}

function routeAfterActionForV3Role(roleId: string): NodeActionConfig {
  const stay = roleId;
  switch (roleId) {
    case "analyser":
      return {
        type: "NodeActionRouteTo",
        params: routeAfterParams(stay, {
          direct: "agent",
          plan: "plan_writer",
          doc_adopted: "plan_reviewer",
          gather: stay,
        }),
      };
    case "plan_reviewer":
      return {
        type: "NodeActionRouteTo",
        params: routeAfterParams(stay, {
          ready: ROUTE_TARGET_REFLECT,
          rewrite: "plan_writer",
          plan_approved: "planner",
        }),
      };
    case "plan_writer":
      return {
        type: "NodeActionRouteTo",
        params: routeAfterParams(stay, {
          doc_written: "plan_reviewer",
        }),
      };
    case "planner":
      return {
        type: "NodeActionRouteTo",
        params: routeAfterParams(stay, {
          plan_resume: "executor",
        }),
      };
    case "replanner":
      return {
        type: "NodeActionRouteTo",
        params: routeAfterParams(stay, {
          plan_resume: "executor",
        }),
      };
    case "executor":
      return {
        type: "NodeActionRouteTo",
        params: routeAfterParams(stay, {
          step_blocked: "replanner",
        }),
      };
    case "agent":
    default:
      return {
        type: "NodeActionRouteTo",
        params: routeAfterParams(stay),
      };
  }
}

function routeGuideForRole(
  roleId: string,
): Array<{ when: string; routeTo: string }> | undefined {
  switch (roleId) {
    case "analyser":
      return [
        {
          when: "the task is read-only Q&A or a lookup, with no implementation or data changes",
          routeTo: "direct",
        },
        {
          when: "the task requires implementation or data changes and no current-task plan document exists",
          routeTo: "plan",
        },
        {
          when: "more context is required; adopt an existing current-task plan with adopt_plan_doc when found",
          routeTo: "gather",
        },
      ];
    case "plan_reviewer":
      return [
        {
          when: "the plan document is ready for user Approve",
          routeTo: "ready",
        },
        {
          when: "the plan premise is wrong and must be rewritten",
          routeTo: "rewrite",
        },
      ];
    case "plan_writer":
      // No guide on purpose: fsm_route is denied on this role and
      // write_plan_doc already emits the route itself. Asking the model to
      // route by hand only made it call fsm_route on the *next* role.
      return undefined;
    case "executor":
      return [
        {
          when: "a step is blocked and needs replanning (prefer report_step_blocked)",
          routeTo: "step_blocked",
        },
      ];
    default:
      return undefined;
  }
}

/**
 * Prompt injects: routeGuide + phase → Bucket0 system (stable orientation every
 * round); live plan / planDoc / pending → trailing overlay (cache-friendly).
 * Role behaviour text belongs on Prepare role's explicit prompt source and
 * placement — do not duplicate it on the overlay tail.
 * Action order = system (routeGuide, phase) then overlay (plan, planDoc,
 * pending).
 */
function promptInjectActionsForRole(roleId: string): NodeActionConfig[] {
  const actions: NodeActionConfig[] = [];
  const routeGuide = routeGuideForRole(roleId);
  if (routeGuide) {
    actions.push({
      type: "NodeActionPromptInject",
      params: { source: "routeGuide", placement: "system", routeGuide },
    });
  }
  const liveSources: string[] = [];
  let includePhase = false;
  switch (roleId) {
    case "planner":
    case "plan_reviewer":
    case "replanner":
      liveSources.push("planDoc");
      includePhase = true;
      break;
    case "executor":
      liveSources.push("plan", "planDoc");
      includePhase = true;
      break;
    case "plan_writer":
      liveSources.push("pendingPlanDraft");
      includePhase = true;
      break;
    case "analyser":
      includePhase = true;
      break;
    default:
      break;
  }
  if (includePhase) {
    actions.push({
      type: "NodeActionPromptInject",
      params: { source: "phase", placement: "system" },
    });
  }
  for (const source of liveSources) {
    actions.push({ type: "NodeActionPromptInject", params: { source } });
  }
  return actions;
}

/** Actions that used to live on PrepareRole.onEnter (phase + plan bookkeeping). */
function roleEntryActions(roleId: string): NodeActionConfig[] {
  switch (roleId) {
    case "analyser":
      return [writeSessionPhase("gathering")];
    case "plan_writer":
      return [
        writeSessionPhase("drafting"),
        { type: "NodeActionCompleteActivePlan", params: {} },
        {
          type: "NodeActionSetPlanApprovalPending",
          params: { pending: false },
        },
      ];
    case "plan_reviewer":
      return [
        writeSessionPhase("review"),
        { type: "NodeActionClearPlanDraft", params: {} },
      ];
    case "planner":
      return [
        writeSessionPhase("planning"),
        {
          type: "NodeActionSetPlanApprovalPending",
          params: { pending: false },
        },
      ];
    case "executor":
      return [writeSessionPhase("executing")];
    case "replanner":
      // Turn-scoped replan counter (replanCount) — read it back with typed
      // EdgeWhen / condition Actions for budget gating.
      return [
        {
          type: "NodeActionWriteBlackboard",
          params: { key: "replanCount", mode: "increment" },
        },
      ];
    case "agent":
      // Do not CompleteActivePlan here: agent self-loops, and that would
      // close a Direct create_plan checklist on the next model round.
      // Leftover Direct plans close on skill_reflect_gate (whenPhaseUnset).
      return [writeSessionPhase(null)];
    default:
      return [];
  }
}

const SKILL_REFLECT_ALLOW_TOOLS = [
  ...SKILL_REFLECT_TOOL_ALLOWLIST,
  FSM_ROUTE_TOOL_NAME,
];

export function skillReflectGateActions(): NodeActionConfig[] {
  return [
    {
      type: "NodeActionCompare",
      params: {
        source: "autoSkillSummarize",
        operator: "==",
        value: "true",
        asKey: SKILL_REFLECT_FLAG_AUTO,
      },
    },
    {
      type: "NodeActionCompare",
      params: {
        source: "fullPermissions",
        operator: "==",
        value: "true",
        asKey: SKILL_REFLECT_FLAG_FULL_PERMS,
      },
    },
    {
      type: "NodeActionCompare",
      params: {
        source: "turnModelIterations",
        type: "int",
        operator: ">",
        value: SKILL_REFLECT_MIN_MODEL_ITERATIONS,
        asKey: SKILL_REFLECT_FLAG_ENOUGH_ITERS,
      },
    },
    {
      type: "NodeActionCompare",
      params: {
        source: "toolRecoveryCount",
        type: "int",
        operator: ">=",
        value: SKILL_REFLECT_MIN_RECOVERIES,
        asKey: SKILL_REFLECT_FLAG_RECOVERED,
      },
    },
    {
      type: "NodeActionCompare",
      params: {
        source: "turnModelIterations",
        type: "int",
        operator: ">=",
        value: SKILL_REFLECT_LONG_RUN_ITERATIONS,
        asKey: SKILL_REFLECT_FLAG_LONG_RUN,
      },
    },
    {
      type: "NodeActionCompare",
      params: {
        source: "skillsReadCount",
        type: "int",
        operator: ">=",
        value: SKILL_REFLECT_MIN_SKILLS_READ,
        asKey: SKILL_REFLECT_FLAG_USED_SKILL,
      },
    },
    {
      type: "NodeActionRouteTo",
      params: {
        when: [
          {
            expr: SKILL_REFLECT_GATE_EXPR,
            to: NODE_SKILL_REFLECTOR,
          },
        ],
        defaultPin: ROUTE_TARGET_REFLECT_DONE,
      },
    },
  ];
}

function skillReflectRouteAfterParams(): Record<string, unknown> {
  return {
    routes: [
      { event: "stay", to: NODE_SKILL_REFLECTOR },
      { event: "leave", to: ROUTE_TARGET_REFLECT_DONE },
      { event: "done", to: ROUTE_TARGET_REFLECT_DONE },
      { event: "continue", to: NODE_SKILL_REFLECTOR },
    ],
  };
}

export function skillReflectorActions(): NodeActionConfig[] {
  // Reflect body rides Bucket0 via Prepare role Custom (rolePromptInline,
  // pure replacement of the agent slot) — the trailing overlay would
  // re-append the same body on every reflect round of the self-loop.
  const reflectBody =
    getDefaultSkillReflectPrompt().trim() ||
    "Review the turn and decide whether to save a reusable skill.";
  return [
    { type: "NodeActionRoundGate", params: {} },
    {
      type: "NodeActionPrepareRole",
      params: rolePresetParams("custom", {
        roleKind: NODE_SKILL_REFLECTOR,
        rolePromptInline: reflectBody,
        waitingMessage: "Reviewing skills…",
      }),
    },
    presetPlanStepAction("custom"),
    {
      type: "NodeActionPromptInject",
      params: {
        source: "routeGuide",
        placement: "system",
        routeGuide: [
          {
            when: "reflect is complete or nothing qualifies to save",
            routeTo: "done",
          },
          {
            when: "another reflect round is needed after tool use",
            routeTo: "continue",
          },
        ],
      },
    },
    {
      type: "NodeActionPromptInject",
      params: { source: "skillReflectDigest", placement: "overlay" },
    },
    {
      type: "NodeActionPrepareTools",
      params: {
        allowTools: [...SKILL_REFLECT_ALLOW_TOOLS],
        useOfferSet: false,
        skillActor: "reflector",
        skillWritePolicy: "auto_owned_only",
      },
    },
    { type: "NodeActionBuildModelWindow", params: {} },
    {
      type: "NodeActionCallModel",
      params: { waitingMessage: "Reviewing skills…" },
    },
    { type: "NodeActionRunTools", params: {} },
    { type: "NodeActionApplyToolEffects", params: {} },
    { type: "NodeActionEmitRouteEvent", params: {} },
    {
      type: "NodeActionRouteTo",
      params: skillReflectRouteAfterParams(),
    },
  ];
}

export const skillReflectGateNode: FSMGraphNodeConfig = {
  id: NODE_SKILL_REFLECT_GATE,
  name: "Skill reflect gate",
  pins: pinsFromNames([NODE_SKILL_REFLECTOR, ROUTE_TARGET_REFLECT_DONE]),
  actions: skillReflectGateActions(),
};

/** Plan mode: close leftover Direct checklists after Agent leaves, not on Agent itself. */
function planExecuteSkillReflectGateNode(): FSMGraphNodeConfig {
  return {
    ...skillReflectGateNode,
    actions: [
      {
        type: "NodeActionCompleteActivePlan",
        params: { whenPhaseUnset: true },
      },
      ...(skillReflectGateNode.actions ?? []),
    ],
  };
}

const skillReflectorNode: FSMGraphNodeConfig = {
  id: NODE_SKILL_REFLECTOR,
  name: "Skill reflector",
  selfLoop: true,
  pins: pinsFromNames([NODE_SKILL_REFLECTOR, ROUTE_TARGET_REFLECT_DONE]),
  actions: skillReflectorActions(),
};

/** Role body: prepare tools → (optional disable) → model window → stream. */
function rolePrepareStreamActions(
  roleKind: RoleKindName,
  options: {
    includeSkills?: boolean;
    subagentRole?: string;
    waitingMessage?: string;
    disableToolNames?: string[];
    hardFilterTools?: boolean;
    /** Configuration preset to expand; independent of the role identity. */
    roleTemplate?: string;
    /** Prompt inject actions mounted between PrepareRole and PrepareTools. */
    promptInjects?: NodeActionConfig[];
    rolePromptFile?: string;
    rolePromptInline?: string;
    extraBeforeStream?: NodeActionConfig[];
    requirePlanDocForCreatePlan?: boolean;
    /** PrepareTools allowTools patterns (exact or * globs); RunTools reads them from nodeContext. */
    allowTools?: string[];
    /** Call model: turn off reasoning for this role. */
    disableReasoning?: boolean;
    /** Inserted after PrepareRole (Set phase / Apply plan effects). */
    afterPrepareRole?: NodeActionConfig[];
    /** Inserted after PrepareTools / DisableTools, before BuildModelWindow (tools[] edits). */
    afterPrepareTools?: NodeActionConfig[];
  } = {},
): NodeActionConfig[] {
  const includeSkills = options.includeSkills === true;
  const prepareRoleKind = options.roleTemplate ?? roleKind;
  const disableToolNames = (options.disableToolNames ?? []).filter(
    (n) => typeof n === "string" && n.length > 0,
  );
  const prepareToolsParams: Record<string, unknown> =
    options.allowTools && options.allowTools.length > 0
      ? { allowTools: options.allowTools }
      : {};
  if (roleKind === "subagent") {
    prepareToolsParams.toolPolicy = `subagent_${options.subagentRole ?? "general"}`;
    prepareToolsParams.useOfferSet = false;
  }
  return [
    {
      type: "NodeActionPrepareRole",
      params: rolePresetParams(prepareRoleKind, {
        roleKind,
        includeSkills,
        ...(options.waitingMessage
          ? { waitingMessage: options.waitingMessage }
          : {}),
        ...(options.rolePromptFile
          ? { rolePromptFile: options.rolePromptFile }
          : {}),
        ...(options.rolePromptInline
          ? { rolePromptInline: options.rolePromptInline }
          : {}),
        ...(options.requirePlanDocForCreatePlan
          ? { requirePlanDocForCreatePlan: true }
          : {}),
      }),
    },
    presetPlanStepAction(prepareRoleKind, options.waitingMessage),
    ...(options.afterPrepareRole ?? []),
    ...(options.promptInjects ?? []),
    { type: "NodeActionPrepareTools", params: prepareToolsParams },
    ...(disableToolNames.length > 0
      ? [
          {
            type: "NodeActionDisableTools",
            params: {
              toolNames: disableToolNames,
              merge: true,
              ...(options.hardFilterTools ? { hardFilter: true } : {}),
            },
          },
        ]
      : []),
    ...(options.afterPrepareTools ?? []),
    { type: "NodeActionBuildModelWindow", params: {} },
    ...(options.extraBeforeStream ?? []),
    {
      type: "NodeActionCallModel",
      params: {
        ...(options.disableReasoning ? { disableReasoning: true } : {}),
      },
    },
  ];
}

function selfContainedRoleActions(
  roleKind: RoleKindName,
  options: Parameters<typeof rolePrepareStreamActions>[1] & {
    /** Mount Await subagents (omit on Ask / child subagent — they cannot dispatch). */
    awaitSubagents?: boolean;
    runToolsParams?: Record<string, unknown>;
    /** Mounted right before RouteTo (route-event producers). */
    beforeRouteTo?: NodeActionConfig[];
    /** Extra RouteTo event → pin bindings. */
    routeExtra?: Record<string, string>;
  } = {},
): NodeActionConfig[] {
  const awaitSubagents = options.awaitSubagents !== false;
  return [
    { type: "NodeActionRoundGate", params: {} },
    ...rolePrepareStreamActions(roleKind, options),
    {
      type: "NodeActionRunTools",
      params: { ...(options.runToolsParams ?? {}) },
    },
    { type: "NodeActionApplyToolEffects", params: {} },
    { type: "NodeActionEmitRouteEvent", params: {} },
    ...(awaitSubagents
      ? [{ type: "NodeActionAwaitSubagents", params: {} }]
      : []),
    ...(options.beforeRouteTo ?? []),
    {
      type: "NodeActionRouteTo",
      params: routeAfterParams(roleKind, options.routeExtra),
    },
  ];
}

const controlEnd: FSMGraphNodeConfig = {
  id: NODE_END,
  name: "End",
  actions: [
    { type: "NodeActionFillEmptyAssistant", params: {} },
    { type: "NodeActionFinishIdle", params: {} },
  ],
};

const taskEnd: FSMGraphNodeConfig = {
  id: NODE_END,
  name: "End",
  actions: [
    { type: "NodeActionFillEmptyAssistant", params: {} },
    { type: "NodeActionFinishIdle", params: {} },
    { type: "NodeActionNotifyTaskDone", params: {} },
  ],
};

export function createReactGraphConfig(): FSMGraphConfig {
  return createFSMGraphConfig({
    entryNodeId: NODE_START,
    terminalNodeId: NODE_END,
    nodes: [
      {
        id: NODE_START,
        name: "Start",
        actions: [{ type: "NodeActionStartTurn", params: {} }],
      },
      {
        id: "agent",
        name: "Agent",
        selfLoop: true,
        pins: pinsFromNames(["agent", ROUTE_TARGET_REFLECT]),
        actions: selfContainedRoleActions("agent", {
          disableToolNames: [FSM_ROUTE_TOOL_NAME],
        }),
      },
      skillReflectGateNode,
      skillReflectorNode,
      taskEnd,
    ],
    edges: [
      { from: NODE_START, to: "agent", type: "EdgeAlways" },
      {
        from: "agent",
        to: NODE_SKILL_REFLECT_GATE,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: ROUTE_TARGET_REFLECT,
          source: "node",
        },
      },
      {
        from: NODE_SKILL_REFLECT_GATE,
        to: NODE_SKILL_REFLECTOR,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: NODE_SKILL_REFLECTOR,
          source: "node",
        },
      },
      {
        from: NODE_SKILL_REFLECT_GATE,
        to: NODE_END,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: ROUTE_TARGET_REFLECT_DONE,
          source: "node",
        },
      },
      {
        from: NODE_SKILL_REFLECTOR,
        to: NODE_END,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: ROUTE_TARGET_REFLECT_DONE,
          source: "node",
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Auto V2 (react_v2) — demo-first workflow
// ---------------------------------------------------------------------------

/** V2-only node ids (graph-local; V1 stays untouched). */
const NODE_V2_TRIAGE = "triage";
const NODE_V2_DEMO_BUILDER = "demo_builder";
const NODE_V2_AGENT = "agent";
const NODE_V2_DEMO_CLEANUP_GATE = "demo_cleanup_gate";
const NODE_V2_DEMO_CLEANUP = "demo_cleanup";
/** Replays the agent's pre-committed shell chain (`then`) without model rounds. */
const NODE_V2_AGENT_REUSE = "agent_reuse";

/** Demo review phase on the session blackboard (opaque graph vocabulary). */
const DEMO_REVIEW_PHASE = "demo_review";

const V2_DEMO_TOOL_NAME = "present_demo";

const V2_TRIAGE_PROMPT = [
  "Auto V2 triage — one lightweight round: classify the user's latest message, then route.",
  "You see the conversation history; judge only whether this message asks for a UI change",
  "large enough that the user should review and sign off on a mockup before implementation.",
  "Route via the fsm_route tool:",
  "- ui: substantial UI/layout work where design choices matter and getting the direction",
  "  wrong would cost a rewrite — new screens or major sections, significant layout",
  "  restructuring, a new visual structure for a page/component, redesigns, or anything",
  "  with multiple reasonable visual directions.",
  "- direct: everything else — backend / logic / data work, refactoring, docs, pure Q&A,",
  "  tooling, and SMALL UI tweaks (spacing, colors, sizing, labels/copy, minor component",
  "  adjustments, bug-fix-level visual corrections) that are cheap to verify after",
  "  implementation and do not need a design decision.",
  "When unsure, prefer direct: a demo is for layout-scale decisions the user would want",
  "to confirm, not for every visual touch.",
  "Call fsm_route exactly once with 'ui' or 'direct'. Do not chat, do not read or write",
  "files, do not implement anything — routing is this round's only job.",
].join("\n");

const V2_DEMO_BUILDER_PROMPT = [
  "Auto V2 demo builder — mockup-first loop for UI changes (demo review).",
  "Your deliverable this stage is the demo: a self-contained single-file HTML mockup of the",
  "requested UI at demos/<feature>/index.html in the workspace (inline every asset, no",
  "relative files, no CDN / external resources — offline networks are not guaranteed),",
  "presented with present_demo(path, params[]). Declare as params ONLY the options that",
  "need the user's decision before implementation (string / number / boolean / select /",
  "color; numbers with a natural range get min/max so they render as drag sliders);",
  "switches that merely demonstrate different states or scenarios (loading / empty /",
  "error / success …) stay inside the page as its own controls, never as params. The",
  "card returns immediately — finish your turn after presenting and wait for the user's",
  "feedback.",
  "Tools are not restricted — read whatever you need (files, search, quick read-only",
  "checks) to make the demo faithful to the real UI. But do not implement the real change",
  "yet: application source stays untouched until the demo is confirmed; this stage's file",
  "edits belong under demos/ only.",
  "Each new message in demo review is feedback: revise the demo file and re-present it.",
  "Route via fsm_route when the review is over:",
  "- confirmed: the user approved — a \"Demo confirmed [demo:<toolCallId>]:\" message or",
  "  an explicit text confirmation. Close with a short handoff note (demo path + the",
  "  confirmed option values) so the execution stage can implement exactly what was",
  "  approved.",
  "- direct: the user explicitly asked to skip or abandon the demo and just implement.",
  "- stay: default while review continues.",
].join("\n");

const V2_DEMO_CLEANUP_PROMPT = [
  "Auto V2 demo cleanup — final housekeeping after a confirmed demo was implemented.",
  "This turn started from a demo confirmation and the execution stage has finished.",
  "Find the demo artifacts created for this task — the builder's handoff note and the",
  "\"Demo confirmed\" message in the conversation carry the path (demos/<feature>/) — and",
  "delete that directory with run_shell. If the directory does not exist or is already",
  "gone, do nothing.",
  "Keep it to one short round: clean up (or confirm nothing to clean), then finish.",
  "Do not continue the task itself.",
].join("\n");

function routeGuideInject(
  guide: Array<{ when: string; routeTo: string }>,
): NodeActionConfig {
  return {
    type: "NodeActionPromptInject",
    params: { source: "routeGuide", placement: "system", routeGuide: guide },
  };
}

function reactV2StartActions(): NodeActionConfig[] {
  return [
    { type: "NodeActionStartTurn", params: {} },
    // Deterministic demo-confirm interception: a D7 marker message goes
    // straight to execution — no triage / builder model round spent.
    {
      type: "NodeActionCompare",
      params: { source: "demoConfirm", asKey: "turn.demoConfirm" },
    },
    ...phaseResumeCompareActions([DEMO_REVIEW_PHASE]),
    {
      type: "NodeActionRouteTo",
      params: {
        when: [
          { expr: "turn.demoConfirm", to: NODE_V2_AGENT },
          { expr: `resume.phase.${DEMO_REVIEW_PHASE}`, to: NODE_V2_DEMO_BUILDER },
        ],
        defaultPin: NODE_V2_TRIAGE,
      },
    },
  ];
}

function reactV2TriageActions(): NodeActionConfig[] {
  return [
    { type: "NodeActionRoundGate", params: {} },
    ...rolePrepareStreamActions(NODE_V2_TRIAGE, {
      roleTemplate: "custom",
      rolePromptInline: V2_TRIAGE_PROMPT,
      waitingMessage: "Evaluating task…",
      allowTools: [FSM_ROUTE_TOOL_NAME],
      disableReasoning: true,
      promptInjects: [
        routeGuideInject([
          {
            when:
              "substantial UI/layout work where design choices matter (new screens or major sections, significant layout restructuring, redesigns, multiple visual directions) and the user should sign off on a mockup first",
            routeTo: "ui",
          },
          {
            when:
              "everything else — backend / logic / data, refactoring, docs, Q&A, tooling, and small UI tweaks (spacing/colors/sizing/labels/minor adjustments) that are cheap to verify after implementation",
            routeTo: "direct",
          },
        ]),
      ],
    }),
    { type: "NodeActionRunTools", params: {} },
    { type: "NodeActionApplyToolEffects", params: {} },
    { type: "NodeActionEmitRouteEvent", params: {} },
    {
      type: "NodeActionRouteTo",
      params: {
        routes: [
          { event: "ui", to: NODE_V2_DEMO_BUILDER },
          { event: "direct", to: NODE_V2_AGENT },
          { event: "stay", to: NODE_V2_TRIAGE },
          // No fsm_route / plain text answer → degrade to V1 behavior.
          { event: "leave", to: NODE_V2_AGENT },
        ],
      },
    },
  ];
}

function reactV2DemoBuilderActions(): NodeActionConfig[] {
  return [
    { type: "NodeActionRoundGate", params: {} },
    ...rolePrepareStreamActions(NODE_V2_DEMO_BUILDER, {
      roleTemplate: "custom",
      rolePromptInline: V2_DEMO_BUILDER_PROMPT,
      waitingMessage: "Preparing demo…",
      // Tools deliberately unrestricted — the demo-first contract lives in
      // the role prompt, not a tool gate.
      afterPrepareRole: [writeSessionPhase(DEMO_REVIEW_PHASE)],
      promptInjects: [
        routeGuideInject([
          {
            when:
              "demo review continues (revise and re-present the demo, or answer questions about it)",
            routeTo: "stay",
          },
          {
            when:
              "the user approved the demo (a \"Demo confirmed [demo:...]\" message or explicit text confirmation) — hand off to execution with a short summary of the demo path and confirmed options",
            routeTo: "confirmed",
          },
          {
            when: "the user explicitly asked to skip or abandon the demo and implement directly",
            routeTo: "direct",
          },
        ]),
      ],
    }),
    { type: "NodeActionRunTools", params: {} },
    { type: "NodeActionApplyToolEffects", params: {} },
    { type: "NodeActionEmitRouteEvent", params: {} },
    {
      type: "NodeActionRouteTo",
      params: {
        routes: [
          { event: "stay", to: NODE_V2_DEMO_BUILDER },
          { event: "confirmed", to: NODE_V2_AGENT },
          { event: "direct", to: NODE_V2_AGENT },
          { event: "leave", to: ROUTE_TARGET_REFLECT },
        ],
      },
    },
  ];
}

const V2_EDG_NOTE = [
  "Shell command chains: when you already know the next shell commands and would run them",
  "regardless of what the output says (e.g. build → test → git diff --stat), put them in the",
  "shell tool's `then` argument instead of calling the tool again after each step. They run",
  "one by one only while each exits 0 — on any failure the rest are skipped and you get every",
  "result back. `then` is for next steps after success, never for fallbacks, retries or `||`",
  "alternatives in case this command fails. Leave `then` out whenever the next step depends",
  "on reading the output.",
].join("\n");

function reactV2AgentActions(): NodeActionConfig[] {
  return selfContainedRoleActions(NODE_V2_AGENT, {
    // Execution stage: no routing tool, no demo cards (demo review is over).
    disableToolNames: [FSM_ROUTE_TOOL_NAME, V2_DEMO_TOOL_NAME],
    // Confirm / escape both land here — clear the demo review phase.
    afterPrepareRole: [writeSessionPhase(null)],
    promptInjects: [
      {
        type: "NodeActionPromptInject",
        params: { source: "note", placement: "system", note: V2_EDG_NOTE },
      },
    ],
    // EDG reuse: `then` on the shell tool → agent_reuse replays the chain.
    afterPrepareTools: [{ type: "NodeActionEdgPlanSchema", params: { enabled: true } }],
    runToolsParams: { shellReceipt: "structured" },
    beforeRouteTo: [{ type: "NodeActionEdgAdmit", params: {} }],
    routeExtra: { [EDG_REUSE_EVENT]: NODE_V2_AGENT_REUSE },
  });
}

/**
 * Zero-model-round replay of the agent's `then` chain: one banked command per
 * visit through the normal RunTools path; any failed guard, exhaustion or
 * pending steer falls back to the agent node. Steer is left for the agent's
 * Round gate to drain (drainSteer=false here).
 */
function reactV2AgentReuseActions(): NodeActionConfig[] {
  return [
    { type: "NodeActionRoundGate", params: { drainSteer: false } },
    { type: "NodeActionEdgDispatch", params: {} },
    { type: "NodeActionRunTools", params: { shellReceipt: "structured" } },
    { type: "NodeActionApplyToolEffects", params: {} },
    { type: "NodeActionEdgAdmit", params: {} },
    {
      type: "NodeActionRouteTo",
      params: {
        routes: [
          { event: EDG_REUSE_EVENT, to: NODE_V2_AGENT_REUSE },
          { event: "stay", to: NODE_V2_AGENT },
          { event: "leave", to: NODE_V2_AGENT },
        ],
      },
    },
  ];
}

/**
 * Zero-model-round splitter before End: only turns that opened with a demo
 * confirm marker (Start's turn-level `turn.demoConfirm` flag) pay the
 * cleanup round; every other turn — including demo review turns — goes
 * straight to End.
 */
function reactV2DemoCleanupGateActions(): NodeActionConfig[] {
  return [
    {
      type: "NodeActionCompare",
      params: {
        source: "blackboard",
        key: "turn.demoConfirm",
        scope: "turn",
        type: "string",
        operator: "==",
        value: "true",
        asKey: "turn.demoCleanupNow",
      },
    },
    {
      type: "NodeActionRouteTo",
      params: {
        when: [{ expr: "turn.demoCleanupNow", to: NODE_V2_DEMO_CLEANUP }],
        defaultPin: NODE_END,
      },
    },
  ];
}

function reactV2DemoCleanupActions(): NodeActionConfig[] {
  return [
    { type: "NodeActionRoundGate", params: {} },
    ...rolePrepareStreamActions(NODE_V2_DEMO_CLEANUP, {
      roleTemplate: "custom",
      rolePromptInline: V2_DEMO_CLEANUP_PROMPT,
      waitingMessage: "Cleaning up demo…",
      disableReasoning: true,
    }),
    { type: "NodeActionRunTools", params: {} },
    { type: "NodeActionApplyToolEffects", params: {} },
    { type: "NodeActionEmitRouteEvent", params: {} },
    {
      type: "NodeActionRouteTo",
      params: {
        routes: [
          { event: "stay", to: NODE_V2_DEMO_CLEANUP },
          { event: "leave", to: NODE_END },
          { event: "done", to: NODE_END },
        ],
      },
    },
  ];
}

/**
 * Auto V2 — demo-first react: deterministic Start routing (demo confirm
 * marker → execution; demo review phase → builder), triage round for UI
 * change detection, builder self-loop (write demo → present_demo → iterate),
 * then the V1-style agent execution loop. Pure config over stock Actions.
 */
export function createReactV2GraphConfig(): FSMGraphConfig {
  return createFSMGraphConfig({
    entryNodeId: NODE_START,
    terminalNodeId: NODE_END,
    nodes: [
      {
        id: NODE_START,
        name: "Start",
        pins: pinsFromNames([
          NODE_V2_TRIAGE,
          NODE_V2_DEMO_BUILDER,
          NODE_V2_AGENT,
        ]),
        actions: reactV2StartActions(),
      },
      {
        id: NODE_V2_TRIAGE,
        name: "Triage",
        selfLoop: true,
        pins: pinsFromNames([
          NODE_V2_TRIAGE,
          NODE_V2_DEMO_BUILDER,
          NODE_V2_AGENT,
        ]),
        actions: reactV2TriageActions(),
      },
      {
        id: NODE_V2_DEMO_BUILDER,
        name: "Demo builder",
        selfLoop: true,
        pins: pinsFromNames([
          NODE_V2_DEMO_BUILDER,
          NODE_V2_AGENT,
          ROUTE_TARGET_REFLECT,
        ]),
        actions: reactV2DemoBuilderActions(),
      },
      {
        id: NODE_V2_AGENT,
        name: "Agent",
        selfLoop: true,
        pins: pinsFromNames([
          NODE_V2_AGENT,
          NODE_V2_AGENT_REUSE,
          ROUTE_TARGET_REFLECT,
        ]),
        actions: reactV2AgentActions(),
      },
      {
        id: NODE_V2_AGENT_REUSE,
        name: "Agent reuse",
        selfLoop: true,
        pins: pinsFromNames([NODE_V2_AGENT_REUSE, NODE_V2_AGENT]),
        actions: reactV2AgentReuseActions(),
      },
      {
        id: NODE_V2_DEMO_CLEANUP_GATE,
        name: "Demo cleanup gate",
        pins: pinsFromNames([NODE_V2_DEMO_CLEANUP, NODE_END]),
        actions: reactV2DemoCleanupGateActions(),
      },
      {
        id: NODE_V2_DEMO_CLEANUP,
        name: "Demo cleanup",
        selfLoop: true,
        pins: pinsFromNames([NODE_V2_DEMO_CLEANUP, NODE_END]),
        actions: reactV2DemoCleanupActions(),
      },
      skillReflectGateNode,
      skillReflectorNode,
      taskEnd,
    ],
    edges: [
      {
        from: NODE_START,
        to: NODE_V2_AGENT,
        type: "EdgeWhen",
        params: { turnKey: "routeTarget", equals: NODE_V2_AGENT, source: "node" },
      },
      {
        from: NODE_START,
        to: NODE_V2_DEMO_BUILDER,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: NODE_V2_DEMO_BUILDER,
          source: "node",
        },
      },
      {
        from: NODE_START,
        to: NODE_V2_TRIAGE,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: NODE_V2_TRIAGE,
          source: "node",
        },
      },
      {
        from: NODE_V2_TRIAGE,
        to: NODE_V2_DEMO_BUILDER,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: NODE_V2_DEMO_BUILDER,
          source: "node",
        },
      },
      {
        from: NODE_V2_TRIAGE,
        to: NODE_V2_AGENT,
        type: "EdgeWhen",
        params: { turnKey: "routeTarget", equals: NODE_V2_AGENT, source: "node" },
      },
      {
        from: NODE_V2_DEMO_BUILDER,
        to: NODE_V2_AGENT,
        type: "EdgeWhen",
        params: { turnKey: "routeTarget", equals: NODE_V2_AGENT, source: "node" },
      },
      {
        from: NODE_V2_DEMO_BUILDER,
        to: NODE_SKILL_REFLECT_GATE,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: ROUTE_TARGET_REFLECT,
          source: "node",
        },
      },
      {
        from: NODE_V2_AGENT,
        to: NODE_SKILL_REFLECT_GATE,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: ROUTE_TARGET_REFLECT,
          source: "node",
        },
      },
      {
        from: NODE_V2_AGENT,
        to: NODE_V2_AGENT_REUSE,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: NODE_V2_AGENT_REUSE,
          source: "node",
        },
      },
      {
        from: NODE_V2_AGENT_REUSE,
        to: NODE_V2_AGENT,
        type: "EdgeWhen",
        params: { turnKey: "routeTarget", equals: NODE_V2_AGENT, source: "node" },
      },
      {
        from: NODE_SKILL_REFLECT_GATE,
        to: NODE_SKILL_REFLECTOR,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: NODE_SKILL_REFLECTOR,
          source: "node",
        },
      },
      {
        from: NODE_SKILL_REFLECT_GATE,
        to: NODE_V2_DEMO_CLEANUP_GATE,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: ROUTE_TARGET_REFLECT_DONE,
          source: "node",
        },
      },
      {
        from: NODE_SKILL_REFLECTOR,
        to: NODE_V2_DEMO_CLEANUP_GATE,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: ROUTE_TARGET_REFLECT_DONE,
          source: "node",
        },
      },
      {
        from: NODE_V2_DEMO_CLEANUP_GATE,
        to: NODE_V2_DEMO_CLEANUP,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: NODE_V2_DEMO_CLEANUP,
          source: "node",
        },
      },
      {
        from: NODE_V2_DEMO_CLEANUP_GATE,
        to: NODE_END,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: NODE_END,
          source: "node",
        },
      },
      {
        from: NODE_V2_DEMO_CLEANUP,
        to: NODE_END,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: NODE_END,
          source: "node",
        },
      },
    ],
  });
}

export function createSubagentGraphConfig(
  options: SubagentGraphConfigOptions = {},
): FSMGraphConfig {
  const subagentRole = options.subagentRole ?? "general";
  const disabledTools = [...SUBAGENT_TOOL_DENYLIST].sort();

  return createFSMGraphConfig({
    entryNodeId: NODE_START,
    terminalNodeId: NODE_END,
    nodes: [
      {
        id: NODE_START,
        name: "Start",
        actions: [
          { type: "NodeActionStartTurn", params: {} },
        ],
      },
      {
        id: "subagent",
        name: "Subagent",
        selfLoop: true,
        pins: pinsFromNames(["subagent", ROUTE_TARGET_REFLECT]),
        actions: selfContainedRoleActions("subagent", {
          subagentRole,
          waitingMessage: `Subagent (${subagentRole})…`,
          disableToolNames: disabledTools,
          // Children cannot dispatch — no Await subagents.
          awaitSubagents: false,
        }),
      },
      controlEnd,
    ],
    edges: [
      { from: NODE_START, to: "subagent", type: "EdgeAlways" },
      {
        from: "subagent",
        to: NODE_END,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: ROUTE_TARGET_REFLECT,
          source: "node",
        },
      },
    ],
  });
}

export function createAskGraphConfig(): FSMGraphConfig {
  return createFSMGraphConfig({
    entryNodeId: NODE_START,
    terminalNodeId: NODE_END,
    nodes: [
      {
        id: NODE_START,
        name: "Start",
        actions: [{ type: "NodeActionStartTurn", params: {} }],
      },
      {
        id: "agent",
        name: "Ask agent",
        selfLoop: true,
        pins: pinsFromNames(["agent", ROUTE_TARGET_REFLECT]),
        actions: selfContainedRoleActions("agent", {
          includeSkills: false,
          disableToolNames: [...ASK_MODE_DENYLIST].sort(),
          hardFilterTools: true,
          allowTools: [...ASK_MODE_ALLOW_TOOL_PATTERNS],
          disableReasoning: true,
          roleTemplate: "custom",
          // Read-only Q&A contract is the Ask role body (Custom template on
          // Prepare role, Bucket0) — not a per-round trailing overlay.
          rolePromptInline: [
            "Ask mode — read-only Q&A assistant in the user's local workspace.",
            "Answer the user's questions directly and concisely; work via tools. You may read local files,",
            "search the web (Tavily MCP / batch_search), and look up notes /",
            "data — but you must NEVER write, edit, delete, create, execute,",
            "or otherwise change any data. Only read-only tools are available;",
            "if the user asks for an action, explain that Ask mode is read-only.",
            "",
            "Conventions:",
            "- Paths are absolute; get_workspace_path / get_current_time when needed.",
            "- Questions to the user: ask_user only.",
            "- Prefer authoritative local data sources over web search when both exist.",
            "- Never expose the graph to the user (role names, routers, JSON routing, phase handoffs).",
          ].join("\n"),
          // Ask cannot dispatch — no Await subagents / no Set phase / plan effects.
          awaitSubagents: false,
        }),
      },
      controlEnd,
    ],
    edges: [
      { from: NODE_START, to: "agent", type: "EdgeAlways" },
      {
        from: "agent",
        to: NODE_END,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: ROUTE_TARGET_REFLECT,
          source: "node",
        },
      },
    ],
  });
}

type V3RoleSpec = {
  id: RoleKindName;
  transitions: RoleKindName[];
  disableToolNames?: string[];
  requirePlanDocForCreatePlan?: boolean;
  extraBeforeStream?: NodeActionConfig[];
  allowTools?: string[];
  rolePromptInline?: string;
  requirePlanDocApprovalForCreatePlan?: boolean;
};

const V3_ROLES: V3RoleSpec[] = [
  {
    id: "analyser",
    transitions: ["agent", "plan_writer", "plan_reviewer"],
    disableToolNames: [...ANALYSER_DENYLIST],
  },
  {
    id: "planner",
    transitions: ["executor"],
    disableToolNames: [FSM_ROUTE_TOOL_NAME, "write_plan_doc"],
    requirePlanDocForCreatePlan: true,
    requirePlanDocApprovalForCreatePlan: true,
    allowTools: [...ASK_MODE_ALLOW_TOOL_PATTERNS, "create_plan"],
    extraBeforeStream: [
      { type: "NodeActionSetPlanCard", params: { visible: true } },
    ],
  },
  {
    id: "plan_writer",
    transitions: ["plan_reviewer"],
    disableToolNames: [FSM_ROUTE_TOOL_NAME, "create_plan"],
    allowTools: [...ASK_MODE_ALLOW_TOOL_PATTERNS, "write_plan_doc"],
  },
  {
    id: "plan_reviewer",
    transitions: ["plan_writer", "planner"],
    allowTools: [...ASK_MODE_ALLOW_TOOL_PATTERNS, "write_plan_doc", FSM_ROUTE_TOOL_NAME],
    disableToolNames: [
      "create_plan",
      "update_plan",
      "complete_plan",
      "report_step_blocked",
    ],
  },
  {
    id: "executor",
    transitions: ["replanner"],
    disableToolNames: [FSM_ROUTE_TOOL_NAME],
    requirePlanDocForCreatePlan: true,
  },
  {
    id: "replanner",
    transitions: ["executor"],
    disableToolNames: [FSM_ROUTE_TOOL_NAME],
  },
  {
    id: "agent",
    transitions: [],
    disableToolNames: [...PLAN_DIRECT_DENYLIST],
    allowTools: [...ASK_MODE_ALLOW_TOOL_PATTERNS],
    rolePromptInline: "Plan mode — read-only Q&A. Answer the question using read/search tools. Do not implement, write files, run commands, dispatch workers, or create an execution checklist. Implementation requests belong to the plan-document workflow.",
  },
];

function v3RoleActions(spec: V3RoleSpec): NodeActionConfig[] {
  const stepClaim = spec.id === "executor";
  const entryActions = roleEntryActions(spec.id);
  const promptInjects = promptInjectActionsForRole(spec.id);
  const disableToolNames = (spec.disableToolNames ?? []).filter(
    (n) => typeof n === "string" && n.length > 0,
  );
  return [
    { type: "NodeActionRoundGate", params: {} },
    {
      type: "NodeActionPrepareRole",
      params: rolePresetParams(spec.id, {
        ...(spec.rolePromptInline ? { promptPreset: "none", rolePromptInline: spec.rolePromptInline } : {}),
        ...(spec.requirePlanDocApprovalForCreatePlan ? { requirePlanDocApprovalForCreatePlan: true } : {}),
        ...(spec.requirePlanDocForCreatePlan
          ? { requirePlanDocForCreatePlan: true }
          : {}),
      }),
    },
    presetPlanStepAction(spec.id),
    ...entryActions,
    ...promptInjects,
    { type: "NodeActionPrepareTools", params: spec.allowTools ? { allowTools: spec.allowTools } : {} },
    ...(disableToolNames.length > 0
      ? [
          {
            type: "NodeActionDisableTools",
            params: { toolNames: disableToolNames, merge: true },
          },
        ]
      : []),
    { type: "NodeActionBuildModelWindow", params: {} },
    ...(spec.extraBeforeStream ?? []),
    { type: "NodeActionCallModel", params: {} },
    { type: "NodeActionRunTools", params: {} },
    { type: "NodeActionApplyToolEffects", params: {} },
    { type: "NodeActionEmitRouteEvent", params: {} },
    ...(spec.id === "planner" || spec.id === "replanner"
      ? [
          {
            type: "NodeActionCheckPlan",
            params: { onIncomplete: "plan_resume" },
          },
        ]
      : []),
    // Plan roles may dispatch; keep Await on every role loop.
    { type: "NodeActionAwaitSubagents", params: {} },
    // Executor-only: when this round's complete_plan succeeded (status
    // "completed"), request the composer switch back to Agent — the host
    // applies it at turn end unless queued user intent outranks it. Plan
    // semantics live entirely in these two config lines; the Actions are
    // generic primitives.
    ...(spec.id === "executor"
      ? [
          {
            type: "NodeActionWhenToolCall",
            params: {
              toolName: "complete_plan",
              argKey: "status",
              argEquals: "completed",
              requireSuccess: true,
              flagKey: "planCompletedThisRound",
            },
          },
          {
            type: "NodeActionSetComposerRunMode",
            params: { mode: "agent", whenNodeFlag: "planCompletedThisRound" },
          },
        ]
      : []),
    ...(stepClaim
      ? [
          {
            type: "NodeActionDetectStepClaim",
            params: { onStepClaim: ROUTE_TARGET_STEP_CLAIM },
          },
        ]
      : []),
    routeAfterActionForV3Role(spec.id),
  ];
}

  const START_CONTROL_PINS = {
  onDiscarded: "discarded",
  onRejected: "rejected",
  onApproved: "planner",
} as const;

/** Graph-local: validator exit taken only when the last step commits the plan. */
const NODE_PLAN_DONE = "plan_done";

/**
 * Zero-model hop after the plan fully commits: the normal finish closes the
 * plan in CommitStep (no complete_plan call), so the executor's complete_plan
 * flag never fires — request the composer switch back to Agent here.
 */
function planDoneActions(): NodeActionConfig[] {
  return [
    { type: "NodeActionSetComposerRunMode", params: { mode: "agent" } },
    {
      type: "NodeActionRouteTo",
      params: {
        routes: [
          { event: "stay", to: ROUTE_TARGET_REFLECT },
          { event: "leave", to: ROUTE_TARGET_REFLECT },
        ],
      },
    },
  ];
}

export function createPlanExecuteV3GraphConfig(): FSMGraphConfig {
  const roleNodes: FSMGraphNodeConfig[] = V3_ROLES.map((spec) => {
    const pinNames = [
      spec.id,
      ...spec.transitions,
      ROUTE_TARGET_REFLECT,
      ...(spec.id === "executor" ? [ROUTE_TARGET_STEP_CLAIM] : []),
    ];
    return {
      id: spec.id,
      name: spec.id,
      selfLoop: true,
      pins: pinsFromNames(pinNames),
      actions: v3RoleActions(spec),
    };
  });

  const roleEdges: FSMGraphConfig["edges"] = V3_ROLES.flatMap((spec) => [
    ...spec.transitions.map((target) => ({
      from: spec.id,
      to: target,
      type: "EdgeWhen" as const,
      params: {
        turnKey: "routeTarget",
        equals: target,
        source: "node" as const,
      },
    })),
    ...(spec.id === "executor"
      ? [
          {
            from: spec.id,
            to: NODE_EXECUTION_VALIDATOR,
            type: "EdgeWhen" as const,
            params: {
              turnKey: "routeTarget",
              equals: ROUTE_TARGET_STEP_CLAIM,
              source: "node" as const,
            },
          },
        ]
      : []),
    {
      from: spec.id,
      to: NODE_SKILL_REFLECT_GATE,
      type: "EdgeWhen" as const,
      params: {
        turnKey: "routeTarget",
        equals: ROUTE_TARGET_REFLECT,
        source: "node" as const,
      },
    },
  ]);

  return createFSMGraphConfig({
    entryNodeId: NODE_START,
    terminalNodeId: NODE_END,
    nodes: [
      {
        id: NODE_START,
        pins: pinsFromNames([
          START_CONTROL_PINS.onDiscarded,
          START_CONTROL_PINS.onRejected,
          ...V3_ROLES.map((s) => s.id),
        ]),
        actions: [
          {
            type: "NodeActionSyncPlanDoc",
            params: {
              changedPhase: "review",
              legacyApprovedPhases: ["planning", "executing"],
              adoptReferencedDoc: true,
              captureExecutionRequest: true,
            },
          },
          {
            type: "NodeActionApplyControlIntent",
            params: {
              ...START_CONTROL_PINS,
              approveRequirePhase: "review",
              approveRequirePlanDoc: true,
              approveRequireReviewedRevision: true,
              approveSetPhase: "planning",
              approvedUserText:
                "Approved. Create the execution checklist with create_plan, then begin executing.",
            },
          },
          { type: "NodeActionStartTurn", params: {} },
          ...phaseResumeCompareActions(["executing", "planning", "drafting"]),
          { type: "NodeActionCompare", params: { source: "planOpenSteps", value: true, asKey: "resume.planOpen.executing" } },
          { type: "NodeActionCompare", params: { source: "planDocPresent", value: true, asKey: "entry.docPresent" } },
          { type: "NodeActionCompare", params: { source: "planDocApproved", value: true, asKey: "entry.docApproved" } },
          {
            type: "NodeActionRouteTo",
            params: {
              onlyIfRouteTargetUnset: true,
              defaultPin: "analyser",
              when: [
                { expr: "resume.phase.executing && resume.planOpen.executing", to: "executor" },
                { expr: "resume.phase.planning && entry.docPresent", to: "planner" },
                { expr: "resume.phase.drafting", to: "plan_writer" },
                { expr: "entry.docApproved", to: "planner" },
                { expr: "entry.docPresent", to: "plan_reviewer" },
              ],
            },
          },
        ],
      },
      ...roleNodes,
      {
        id: NODE_EXECUTION_VALIDATOR,
        name: "Execution validator",
        pins: pinsFromNames([
          "executor",
          NODE_PLAN_DONE,
        ]),
        actions: [
          {
            type: "NodeActionValidateCommitStep",
            params: {
              onResume: "executor",
              onReflect: NODE_PLAN_DONE,
            },
          },
        ],
      },
      {
        id: NODE_PLAN_DONE,
        name: "Plan done",
        pins: pinsFromNames([ROUTE_TARGET_REFLECT]),
        actions: planDoneActions(),
      },
      planExecuteSkillReflectGateNode(),
      skillReflectorNode,
      taskEnd,
    ],
    edges: [
      {
        from: NODE_START,
        to: NODE_END,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: START_CONTROL_PINS.onDiscarded,
          source: "node",
        },
      },
      {
        from: NODE_START,
        to: NODE_END,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: START_CONTROL_PINS.onRejected,
          source: "node",
        },
      },
      ...V3_ROLES.map((spec) => ({
        from: NODE_START,
        to: spec.id,
        type: "EdgeWhen" as const,
        params: {
          turnKey: "routeTarget",
          equals: spec.id,
          source: "node" as const,
        },
      })),
      ...roleEdges,
      {
        from: NODE_EXECUTION_VALIDATOR,
        to: "executor",
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: "executor",
          source: "node",
        },
      },
      {
        from: NODE_EXECUTION_VALIDATOR,
        to: NODE_PLAN_DONE,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: NODE_PLAN_DONE,
          source: "node",
        },
      },
      {
        from: NODE_PLAN_DONE,
        to: NODE_SKILL_REFLECT_GATE,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: ROUTE_TARGET_REFLECT,
          source: "node",
        },
      },
      {
        from: NODE_SKILL_REFLECT_GATE,
        to: NODE_SKILL_REFLECTOR,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: NODE_SKILL_REFLECTOR,
          source: "node",
        },
      },
      {
        from: NODE_SKILL_REFLECT_GATE,
        to: NODE_END,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: ROUTE_TARGET_REFLECT_DONE,
          source: "node",
        },
      },
      {
        from: NODE_SKILL_REFLECTOR,
        to: NODE_END,
        type: "EdgeWhen",
        params: {
          turnKey: "routeTarget",
          equals: ROUTE_TARGET_REFLECT_DONE,
          source: "node",
        },
      },
    ],
  });
}
