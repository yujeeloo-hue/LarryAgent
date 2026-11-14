/** Historical v1 graph compatibility; independent of current graph presets. */
import type { FSMGraphConfig } from "../types.js";
import {
  NODE_SKILL_REFLECT_GATE,
  skillReflectGateActions,
  retiredSkillReflectGateActions,
  NODE_SKILL_REFLECTOR,
  skillReflectorActions,
  skillReflectGateNode,
  NODE_END,
  ROUTE_TARGET_REFLECT_DONE,
  SESSION_PHASE_BLACKBOARD_KEY,
} from "./legacyPresets.js";
import { resolveActionType, resolvePinName } from "./legacyAliases.js";
import { migrateStartTurnParams } from "./legacyActionParams.js";
import { writeSessionPhaseAction } from "./legacyUtils.js";
import { isLegacyRolePreparation } from "./legacyRoles.js";

export function migrateSkillReflectGateStack(config: FSMGraphConfig): FSMGraphConfig {
  return {
    ...config,
    nodes: config.nodes.map((node) => {
      if (node.id !== NODE_SKILL_REFLECT_GATE ||
        !(node.actions ?? []).some((action) => action.type.trim() === "NodeActionSkillReflectGate")) return node;
      const actions = node.actions ?? [];
      const hasNewStack = actions.some(
        (a) =>
          resolveActionType(a.type) === "NodeActionCompare" &&
          (a.params as { source?: string; asKey?: string } | undefined)
            ?.source === "autoSkillSummarize" &&
          (a.params as { asKey?: string } | undefined)?.asKey === "reflect.auto",
      );
      if (hasNewStack) return node;
      const prefix = actions.filter(
        (a) => resolveActionType(a.type) === "NodeActionCompleteActivePlan",
      );
      return { ...node, actions: [...prefix, ...skillReflectGateActions()] };
    }),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Replace the retired skill_reflect_gate eligibility stack with the current
 * one — only when the node still carries it verbatim (edited gates stay).
 */
export function refreshRetiredSkillReflectGate(config: FSMGraphConfig): {
  config: FSMGraphConfig;
  changed: boolean;
} {
  const retired = retiredSkillReflectGateActions().map(stableJson);
  let changed = false;
  const nodes = config.nodes.map((node) => {
    if (node.id !== NODE_SKILL_REFLECT_GATE) return node;
    const actions = node.actions ?? [];
    const keys = actions.map((a) =>
      stableJson({ type: resolveActionType(a.type), params: a.params ?? {} }),
    );
    const start = keys.findIndex((_, i) =>
      retired.every((key, j) => keys[i + j] === key),
    );
    if (start < 0) return node;
    changed = true;
    return {
      ...node,
      actions: [
        ...actions.slice(0, start),
        ...skillReflectGateActions(),
        ...actions.slice(start + retired.length),
      ],
    };
  });
  return changed ? { config: { ...config, nodes }, changed } : { config, changed };
}

export function migrateSkillReflectTopology(config: FSMGraphConfig): FSMGraphConfig {
  const hasReflector = config.nodes.some((n) => n.id === NODE_SKILL_REFLECTOR &&
    (n.actions ?? []).some((action) => [
      "NodeActionSkillReflectRound", "NodeActionRouteSkillReflect", "NodeActionPrepareSkillReflect",
    ].includes(action.type.trim())),
  );
  if (!hasReflector) return config;

  let nodes = config.nodes.map((node) => {
    if (node.id !== NODE_SKILL_REFLECTOR) return node;
    const rawTypes = (node.actions ?? []).map((a) => a.type.trim());
    const types = rawTypes.map((t) => resolveActionType(t));
    // Check raw names — RouteSkillReflect aliases to RouteTo before resolve.
    const usesLegacy = rawTypes.some(
      (t) =>
        t === "NodeActionSkillReflectRound" ||
        t === "NodeActionRouteSkillReflect" ||
        t === "NodeActionPrepareSkillReflect",
    );
    const usesGeneric =
      types.includes("NodeActionPrepareRole") &&
      types.includes("NodeActionRouteTo");
    if (!usesLegacy || usesGeneric) return node;
    return {
      ...node,
      selfLoop: true,
      actions: skillReflectorActions(),
    };
  });

  const hasGate = nodes.some((n) => n.id === NODE_SKILL_REFLECT_GATE);
  if (hasGate) {
    return { ...config, nodes };
  }

  nodes = [...nodes, structuredClone(skillReflectGateNode)];
  let edges = config.edges.map((edge) => {
    if (
      edge.type !== "EdgeWhen" ||
      edge.to !== NODE_SKILL_REFLECTOR ||
      (edge.params as { turnKey?: string })?.turnKey !== "routeTarget"
    ) {
      return edge;
    }
    const equals = (edge.params as { equals?: unknown })?.equals;
    if (equals === NODE_SKILL_REFLECT_GATE || equals === "reflect") {
      return { ...edge, to: NODE_SKILL_REFLECT_GATE };
    }
    return edge;
  });
  edges = [
    ...edges,
    {
      from: NODE_SKILL_REFLECT_GATE,
      to: NODE_SKILL_REFLECTOR,
      type: "EdgeWhen" as const,
      params: {
        turnKey: "routeTarget",
        equals: NODE_SKILL_REFLECTOR,
        source: "node" as const,
      },
    },
    {
      from: NODE_SKILL_REFLECT_GATE,
      to: NODE_END,
      type: "EdgeWhen" as const,
      params: {
        turnKey: "routeTarget",
        equals: ROUTE_TARGET_REFLECT_DONE,
        source: "node" as const,
      },
    },
  ];
  return { ...config, nodes, edges };
}

/** Hoist legacy StartTurn params onto ApplyControlIntent / RouteTo on the same node. */
export function hoistLegacyStartTurnParams(
  nodes: FSMGraphConfig["nodes"],
): FSMGraphConfig["nodes"] {
  return nodes.map((node) => {
    const actions = node.actions ?? [];
    const startTurn = actions.find(
      (a) => resolveActionType(a.type) === "NodeActionStartTurn",
    );
    if (!startTurn?.params || typeof startTurn.params !== "object") {
      return node;
    }
    const legacy = startTurn.params as Record<string, unknown>;
    const defaultPinFromStart =
      typeof legacy.initialActiveRole === "string"
        ? legacy.initialActiveRole.trim()
        : "";
    const nextActions = actions.map((action) => {
      if (action === startTurn) {
        const cleaned = migrateStartTurnParams(legacy);
        return {
          ...startTurn,
          params: Object.keys(cleaned).length > 0 ? cleaned : {},
        };
      }
      if (
        resolveActionType(action.type) === "NodeActionApplyControlIntent" &&
        typeof legacy.approvedUserText === "string" &&
        legacy.approvedUserText.trim()
      ) {
        const current =
          action.params &&
          typeof action.params === "object" &&
          !Array.isArray(action.params)
            ? (action.params as Record<string, unknown>)
            : {};
        if (
          typeof current.approvedUserText !== "string" ||
          !current.approvedUserText.trim()
        ) {
          return {
            ...action,
            params: {
              ...current,
              approvedUserText: legacy.approvedUserText.trim(),
            },
          };
        }
      }
      if (
        defaultPinFromStart &&
        resolveActionType(action.type) === "NodeActionRouteTo"
      ) {
        const current =
          action.params &&
          typeof action.params === "object" &&
          !Array.isArray(action.params)
            ? (action.params as Record<string, unknown>)
            : {};
        if (
          Array.isArray(current.when) &&
          current.when.length > 0 &&
          (typeof current.defaultPin !== "string" || !current.defaultPin.trim())
        ) {
          return {
            ...action,
            params: { ...current, defaultPin: defaultPinFromStart },
          };
        }
      }
      return action;
    });
    return { ...node, actions: nextActions };
  });
}

export function migrateSetPhaseAction(params: unknown): {
  type: string;
  params: Record<string, unknown>;
} {
  const raw =
    params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>).phase
      : undefined;
  if (raw === null || raw === "clear" || raw === "none") {
    return writeSessionPhaseAction(null);
  }
  if (typeof raw === "string" && raw.trim()) {
    return writeSessionPhaseAction(raw.trim());
  }
  return writeSessionPhaseAction(null);
}

export function stringListFromUnknown(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parsePhaseResumeRows(
  raw: unknown,
): Array<{ phase: string; to: string }> {
  const rows: Array<{ phase: string; to: string }> = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const phase =
        typeof (item as { phase?: unknown }).phase === "string"
          ? (item as { phase: string }).phase.trim()
          : "";
      const to =
        typeof (item as { to?: unknown }).to === "string"
          ? resolvePinName((item as { to: string }).to.trim())
          : typeof (item as { pin?: unknown }).pin === "string"
            ? resolvePinName((item as { pin: string }).pin.trim())
            : "";
      if (phase && to) rows.push({ phase, to });
    }
    return rows;
  }
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(
      raw as Record<string, unknown>,
    )) {
      const phase = key.trim();
      if (!phase || typeof value !== "string" || !value.trim()) continue;
      rows.push({ phase, to: resolvePinName(value.trim()) });
    }
  }
  return rows;
}

/**
 * plan_execute-shaped StartTurn maps (review → plan_reviewer) also need
 * planning → planner so interrupted Approve turns resume correctly.
 */
export function ensurePlanningPhaseResumeRow(
  rows: Array<{ phase: string; to: string }>,
): void {
  if (rows.some((row) => row.phase === "planning")) return;
  const looksLikePlanExecute = rows.some(
    (row) => row.phase === "review" && row.to === "plan_reviewer",
  );
  if (!looksLikePlanExecute) return;
  const row = { phase: "planning", to: "planner" };
  const execIdx = rows.findIndex((r) => r.phase === "executing");
  if (execIdx >= 0) rows.splice(execIdx, 0, row);
  else rows.push(row);
}

export type PhaseResumeLift = {
  fromNodeId: string;
  rows: Array<{ phase: string; to: string }>;
  incompletePhases: Set<string>;
  defaultPin?: string;
};

/** Read legacy StartTurn.phaseResume before params are stripped. */
export function extractPhaseResumeLift(
  config: FSMGraphConfig,
): PhaseResumeLift | null {
  const start = config.nodes.find((n) => n.id === config.entryNodeId);
  const startTurn = (start?.actions ?? []).find(
    (a) => resolveActionType(a.type) === "NodeActionStartTurn",
  );
  if (!startTurn?.params || typeof startTurn.params !== "object") return null;
  const params = startTurn.params as Record<string, unknown>;
  const rows = parsePhaseResumeRows(params.phaseResume);
  ensurePlanningPhaseResumeRow(rows);
  if (rows.length === 0) return null;
  return {
    fromNodeId: config.entryNodeId,
    rows,
    incompletePhases: new Set(
      stringListFromUnknown(params.resumeRequireIncompletePlan),
    ),
    ...(typeof params.initialActiveRole === "string" && params.initialActiveRole.trim()
      ? { defaultPin: resolvePinName(params.initialActiveRole) } : {}),
  };
}

export function sanitizeFlagPart(raw: string): string {
  return raw.replace(/[^\w.-]/g, "_") || "x";
}

/** Builtin / migrated phase resume: Compares + one RouteTo when-table. */
export function phaseResumeCompareRouteActions(
  rows: Array<{ phase: string; to: string }>,
  incomplete: Set<string>,
  defaultPin?: string,
): Array<{ type: string; params: Record<string, unknown> }> {
  const actions: Array<{ type: string; params: Record<string, unknown> }> = [];
  const when: Array<Record<string, unknown>> = [];
  for (const row of rows) {
    const phaseFlag = `resume.phase.${row.phase}`;
    actions.push({
      type: "NodeActionCompare",
      params: {
        source: "blackboard",
        key: SESSION_PHASE_BLACKBOARD_KEY,
        scope: "session",
        type: "string",
        operator: "==",
        value: row.phase,
        asKey: phaseFlag,
      },
    });
    if (incomplete.has(row.phase)) {
      const openFlag = `resume.planOpen.${row.phase}`;
      actions.push({
        type: "NodeActionCompare",
        params: {
          source: "planOpenSteps",
          operator: "==",
          value: "true",
          asKey: openFlag,
        },
      });
      when.push({ expr: `${phaseFlag} && ${openFlag}`, to: row.to });
    } else {
      when.push({ expr: phaseFlag, to: row.to });
    }
  }
  if (when.length > 0) {
    actions.push({
      type: "NodeActionRouteTo",
      params: {
        when,
        onlyIfRouteTargetUnset: true,
        ...(defaultPin ? { defaultPin } : {}),
      },
    });
  }
  return actions;
}

export function isPhaseResumeCompareAction(action: {
  type: string;
  params?: Record<string, unknown>;
}): boolean {
  if (resolveActionType(action.type) !== "NodeActionCompare") return false;
  const asKey =
    typeof action.params?.asKey === "string" ? action.params.asKey : "";
  return (
    asKey.startsWith("resume.phase.") || asKey.startsWith("resume.planOpen.")
  );
}

export function isPhaseResumeRouteToAction(action: {
  type: string;
  params?: Record<string, unknown>;
}): boolean {
  if (resolveActionType(action.type) !== "NodeActionRouteTo") return false;
  const p = action.params ?? {};
  if (p.onlyIfRouteTargetUnset !== true) return false;
  if (Array.isArray(p.when)) {
    return p.when.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const row = item as Record<string, unknown>;
      if (typeof row.key === "string" && row.key.startsWith("resume.phase.")) {
        return true;
      }
      return (
        Array.isArray(row.allOf) &&
        row.allOf.some(
          (k) => typeof k === "string" && k.startsWith("resume.phase."),
        )
      );
    });
  }
  // Legacy single-row pin gate
  if (typeof p.key === "string" && p.key.startsWith("resume.phase.")) {
    return true;
  }
  return (
    Array.isArray(p.allOf) &&
    p.allOf.some((k) => typeof k === "string" && k.startsWith("resume.phase."))
  );
}

/**
 * Expand retired RouteToWhen into Compare (+ optional planOpenSteps) + RouteTo when-table.
 */
export function expandLegacyRouteToWhen(params: Record<string, unknown>): Array<{
  type: string;
  params: Record<string, unknown>;
}> {
  const pin =
    typeof params.pin === "string" ? resolvePinName(params.pin.trim()) : "";
  const key = typeof params.key === "string" ? params.key.trim() : "";
  const scope = params.scope === "session" ? "session" : "turn";
  const valueType =
    params.type === "int" || params.type === "float" || params.type === "string"
      ? params.type
      : "string";
  const operator =
    typeof params.operator === "string" && params.operator.trim()
      ? params.operator.trim()
      : "==";
  const onlyIf = params.onlyIfRouteTargetUnset === true;
  const requireIncomplete = params.requireIncompletePlan === true;
  const strict = params.strict === true;

  // Prefer stable resume.* keys when this was a session-phase RouteToWhen.
  if (
    scope === "session" &&
    key === SESSION_PHASE_BLACKBOARD_KEY &&
    typeof params.value === "string" &&
    params.value.trim()
  ) {
    return phaseResumeCompareRouteActions(
      [{ phase: params.value.trim(), to: pin }],
      requireIncomplete
        ? new Set([params.value.trim()])
        : new Set(),
    );
  }

  const flagKey = `flag.rtw.${sanitizeFlagPart(pin)}.${sanitizeFlagPart(key)}.${sanitizeFlagPart(String(params.value ?? ""))}`;
  const actions: Array<{ type: string; params: Record<string, unknown> }> = [
    {
      type: "NodeActionCompare",
      params: {
        source: "blackboard",
        key,
        scope,
        type: valueType,
        operator,
        value: params.value,
        asKey: flagKey,
        ...(strict ? { strict: true } : {}),
      },
    },
  ];
  if (requireIncomplete) {
    const openFlag = `flag.rtw.planOpen.${sanitizeFlagPart(pin)}`;
    actions.push({
      type: "NodeActionCompare",
      params: {
        source: "planOpenSteps",
        operator: "==",
        value: "true",
        asKey: openFlag,
      },
    });
    actions.push({
      type: "NodeActionRouteTo",
      params: {
        when: [{ expr: `${flagKey} && ${openFlag}`, to: pin }],
        ...(onlyIf ? { onlyIfRouteTargetUnset: true } : {}),
      },
    });
  } else {
    actions.push({
      type: "NodeActionRouteTo",
      params: {
        when: [{ expr: flagKey, to: pin }],
        ...(onlyIf ? { onlyIfRouteTargetUnset: true } : {}),
      },
    });
  }
  return actions;
}

export function isSessionPhaseEdge(edge: FSMGraphConfig["edges"][number]): boolean {
  if (edge.type !== "EdgeWhen") return false;
  const p = edge.params as Record<string, unknown> | undefined;
  return p?.source === "session" && p?.turnKey === "phase";
}

/**
 * Lift legacy StartTurn.phaseResume (and session-phase EdgeWhen) onto
 * Compare + RouteTo when-table on the start node. Strips session phase EdgeWhen edges.
 */
export function applyPhaseResumeCompareRoute(
  config: FSMGraphConfig,
  lift: PhaseResumeLift | null,
): FSMGraphConfig {
  const edges = config.edges.filter((e) => !isSessionPhaseEdge(e));

  // Also harvest phase edges that already existed (pre-Compare migration).
  const fromEdges: PhaseResumeLift["rows"] = [];
  const incompleteFromEdges = new Set<string>();
  for (const edge of config.edges) {
    if (!isSessionPhaseEdge(edge)) continue;
    const p = edge.params as Record<string, unknown>;
    const phase = typeof p.equals === "string" ? p.equals.trim() : "";
    if (!phase || !edge.to) continue;
    fromEdges.push({ phase, to: resolvePinName(edge.to) });
    if (p.requireIncompletePlan === true) incompleteFromEdges.add(phase);
  }

  const rows = [...(lift?.rows ?? [])];
  const incomplete = new Set([
    ...(lift?.incompletePhases ?? []),
    ...incompleteFromEdges,
  ]);
  for (const row of fromEdges) {
    if (!rows.some((r) => r.phase === row.phase)) rows.push(row);
  }
  ensurePlanningPhaseResumeRow(rows);
  if (rows.length === 0) {
    return { ...config, edges };
  }

  const fromNodeId = lift?.fromNodeId ?? config.entryNodeId;
  const nodes = config.nodes.map((node) => {
    if (node.id !== fromNodeId) return node;
    // Replace any prior phase-resume Compare / RouteTo block with one coalesced table.
    const kept = (node.actions ?? []).filter(
      (a) => !isPhaseResumeCompareAction(a) && !isPhaseResumeRouteToAction(a),
    );
    return {
      ...node,
      actions: [
        ...kept,
        ...phaseResumeCompareRouteActions(rows, incomplete, lift?.defaultPin),
      ],
    };
  });
  return { ...config, nodes, edges };
}

/**
 * Action types removed from the registry — drop on load (matched on the
 * **raw** type string before alias resolve). Types that rename via
 * {@link NODE_ACTION_TYPE_ALIASES} must not appear here.
 */
export const REMOVED_ACTION_TYPES: ReadonlySet<string> = new Set([
  "NodeActionPreferSkills",
  "NodeActionPrepareSkillReflect",
  "NodeActionSkillReflectRound",
  "NodeActionSkillReflectGate",
  // Serial update_plan + load-time repairActivePlanInProgress superseded this.
  "NodeActionEnsurePlanInProgress",
  // JellyBot no longer writes to or recalls from JTimeCapsule.
  "NodeActionWriteTurnMemory",
  "NodeActionRecallTurnMemory",
]);

/**
 * Expand legacy ApplyPlanEffects toggles into dedicated Actions.
 * reactToRouteEvent slots are dropped (entry SetPhase / dedicated clears instead).
 */
export function expandLegacyApplyPlanEffects(action: {
  type: string;
  params?: Record<string, unknown>;
}): Array<{ type: string; params?: Record<string, unknown> }> {
  if (action.type !== "NodeActionApplyPlanEffects") {
    return [action];
  }
  const params =
    action.params && typeof action.params === "object" && !Array.isArray(action.params)
      ? action.params
      : {};
  const out: Array<{ type: string; params?: Record<string, unknown> }> = [];
  if (params.completeActivePlan === true) {
    out.push({ type: "NodeActionCompleteActivePlan", params: {} });
  }
  // ensureInProgress: retired — update_plan auto-starts steps; load-time repair handles legacy sessions.
  if (params.bumpReplanCount === true) {
    out.push({
      type: "NodeActionWriteBlackboard",
      params: { key: "replanCount", mode: "increment" },
    });
  }
  // reactToRouteEvent and empty ApplyPlanEffects → drop
  return out;
}

export function ensurePostToolSplitActions(
  actions: NonNullable<FSMGraphConfig["nodes"][number]["actions"]>,
  legacyPlanner = false,
): NonNullable<FSMGraphConfig["nodes"][number]["actions"]> {
  const out: NonNullable<FSMGraphConfig["nodes"][number]["actions"]> = [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i]!;
    out.push(action);
    if (action.type !== "NodeActionApplyToolEffects") continue;
    const next = actions[i + 1];
    if (next?.type !== "NodeActionEmitRouteEvent") {
      out.push({ type: "NodeActionEmitRouteEvent", params: {} });
    }
  }
  if (legacyPlanner) {
    return ensureCheckPlanAfterEmit(out);
  }
  return out;
}

/** planner / replanner: CheckPlan after Emit (plan_idle replacement). */
export function ensureCheckPlanAfterEmit(
  actions: NonNullable<FSMGraphConfig["nodes"][number]["actions"]>,
): NonNullable<FSMGraphConfig["nodes"][number]["actions"]> {
  const out: NonNullable<FSMGraphConfig["nodes"][number]["actions"]> = [];
  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i]!;
    out.push(action);
    if (action.type !== "NodeActionEmitRouteEvent") continue;
    const next = actions[i + 1];
    if (next?.type !== "NodeActionCheckPlan") {
      out.push({
        type: "NodeActionCheckPlan",
        params: { onIncomplete: "plan_resume" },
      });
    }
  }
  return out;
}

/** planner node: ensure WriteBlackboard phase=planning after PrepareRole. */
export function ensurePlannerPlanningPhase(
  actions: NonNullable<FSMGraphConfig["nodes"][number]["actions"]>,
  nodeId: string,
): NonNullable<FSMGraphConfig["nodes"][number]["actions"]> {
  if (
    nodeId !== "planner" ||
    !actions.some((action) =>
      action.type === "NodeActionPrepareRole" &&
      action.params?.roleKind === "planner" &&
      isLegacyRolePreparation(action.params ?? {}),
    )
  ) return actions;
  const hasPlanning = actions.some(
    (a) =>
      a.type === "NodeActionWriteBlackboard" &&
      a.params?.key === SESSION_PHASE_BLACKBOARD_KEY &&
      a.params?.scope === "session" &&
      a.params?.value === "planning",
  );
  if (hasPlanning) return actions;
  const out: NonNullable<FSMGraphConfig["nodes"][number]["actions"]> = [];
  let inserted = false;
  for (const action of actions) {
    out.push(action);
    if (!inserted && action.type === "NodeActionPrepareRole") {
      out.push(writeSessionPhaseAction("planning"));
      inserted = true;
    }
  }
  if (!inserted) {
    // No PrepareRole — leave alone (incomplete / partial migration fixtures).
    return actions;
  }
  return out;
}

