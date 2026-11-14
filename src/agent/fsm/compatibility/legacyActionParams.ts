/** Historical v1 graph compatibility; independent of current graph presets. */
import { ASK_MODE_ALLOW_TOOL_PATTERNS, LEGACY_PIN_FIELDS, ROUTE_TARGET_REFLECT_DONE } from "./legacyPresets.js";
import { SPECIALIZED_ROUTE_AFTER_TYPES } from "./legacyAliases.js";
import { FSMConfigError } from "../FSMConfigError.js";
import { normalizeRouteBindings, legacyWhenRowToExpr } from "./legacyRouteHelpers.js";
import { resolvePinName } from "./legacyAliases.js";
import { isPlainObject } from "./legacyUtils.js";

/** Param key renames keyed by canonical action type. */
export const PARAM_KEY_ALIASES: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  NodeActionCallModel: { progressLabel: "waitingMessage" },
  NodeActionBuildModelWindow: { progressLabel: "waitingMessage" },
  NodeActionPrepareRole: { progressLabel: "waitingMessage" },
  NodeActionSetPlanCard: { cardVisible: "visible" },
  NodeActionAwaitSubagents: { wait: "waitForBatches" },
  NodeActionRouteTo: { onReflect: "onLeave" },
  NodeActionBuildNodeOverlay: { includePlanPhase: "includePhase" },
};

/** Lift Ask-style agent+overlay into the Custom template option; strip overlay onto PromptInject(note). */
export function migratePrepareRoleTemplate(
  params: Record<string, unknown>,
): Record<string, unknown> {
  let next = { ...params };
  const roleKind = next.roleKind;
  const overlay = next.phaseOverlay;
  delete next.overlayPreset;
  delete next.phaseOverlay;
  // Split into NodeActionSetPhase / dedicated plan Actions in migrateFSMGraphConfig.
  delete next.onEnter;

  if (
    roleKind === "agent" &&
    next.askMode === true &&
    typeof overlay === "string" &&
    overlay.trim()
  ) {
    next = { ...next, roleKind: "custom" };
  }
  // askMode no longer lives on PrepareRole — tool allowlist is on Prepare/Run tools.
  delete next.askMode;

  return next;
}

/**
 * Legacy askMode on PrepareTools → allowTools patterns.
 * denyTools on PrepareTools is removed (use Disable tools).
 * RunTools.allowTools is stripped (runtime allowlist comes from PrepareTools → nodeContext).
 */
export function migrateAskModeToToolLists(
  params: Record<string, unknown>,
  canonicalType: string,
): Record<string, unknown> {
  const next = { ...params };
  if (canonicalType === "NodeActionRunTools") {
    delete next.askMode;
    delete next.denyTools;
    delete next.allowTools;
    return next;
  }
  if (next.askMode === true) {
    const existing = next.allowTools;
    const hasAllow =
      Array.isArray(existing) &&
      existing.some((x) => typeof x === "string" && x.length > 0);
    if (!hasAllow) {
      next.allowTools = [...ASK_MODE_ALLOW_TOOL_PATTERNS];
    }
  }
  delete next.askMode;
  delete next.denyTools;
  // Retired PrepareTools toggles — always-on role predicate + forced metas in offer.
  delete next.useRoleToolPredicate;
  delete next.includeForcedMetas;
  return next;
}

/**
 * Collapse legacy onStay/onDirect/… (and Record routes) into routes[] bindings.
 * Does not invent Role-specific events from node id — only converts explicit slots.
 */
export function migrateRouteAfterToRoutes(
  nodeId: string | undefined,
  _legacyType: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const routes: Record<string, string> = {};

  const existing = normalizeRouteBindings(params.routes);
  for (const row of existing) {
    routes[row.event] = row.to;
  }
  const hadExplicitRoutes = existing.length > 0;

  const take = (event: string, ...keys: string[]) => {
    if (routes[event]) return;
    for (const key of keys) {
      const v = params[key];
      if (typeof v === "string" && v.trim()) {
        routes[event] = resolvePinName(v.trim());
        return;
      }
    }
  };

  take("stay", "onStay");
  take("leave", "onLeave", "onReflect");
  take("direct", "onDirect");
  take("plan", "onPlan");
  take("rewrite", "onRewrite");
  take("doc_written", "onDocWritten");
  take("plan_resume", "onResume");
  take("step_blocked", "onStepBlocked");

  // Legacy route event name from pre-plan_resume graphs.
  if (routes.checklist_resume && !routes.plan_resume) {
    routes.plan_resume = routes.checklist_resume;
  }
  delete routes.checklist_resume;

  if (!routes.stay && !hadExplicitRoutes) {
    if (!nodeId) {
      throw new FSMConfigError("INVALID_ACTION_PARAMS", "Legacy route migration requires the containing node id");
    }
    routes.stay = nodeId;
  }

  const bindings = Object.entries(routes).map(([event, to]) => ({ event, to }));
  return { routes: bindings };
}

export function migrateRouteSkillReflectToRoutes(
  params: Record<string, unknown>,
  nodeId: string | undefined,
): Record<string, unknown> {
  if (!nodeId) {
    throw new FSMConfigError("INVALID_ACTION_PARAMS", "Legacy reflection route migration requires the containing node id");
  }
  const reflector = nodeId;
  const done =
    typeof params.onReflectDone === "string" && params.onReflectDone.trim()
      ? resolvePinName(params.onReflectDone.trim())
      : ROUTE_TARGET_REFLECT_DONE;
  const continuePin =
    typeof params.onReflect === "string" && params.onReflect.trim()
      ? resolvePinName(params.onReflect.trim())
      : reflector;
  return {
    routes: [
      { event: "stay", to: reflector },
      { event: "leave", to: done },
      { event: "done", to: done },
      { event: "continue", to: continuePin },
    ],
  };
}

/**
 * Rewrite legacy param keys onto the canonical names used by schemas.
 * Leaves unknown keys intact (schemas may still set additionalProperties).
 */
export function migrateActionParams(
  canonicalType: string,
  params: Record<string, unknown> | undefined,
  nodeId?: string,
  legacyType?: string,
): Record<string, unknown> | undefined {
  if (params === undefined) {
    // Legacy bump-replan counter carried no params; synthesize the
    // turn-scoped increment so the WriteBlackboard schema stays satisfied.
    if (
      canonicalType === "NodeActionWriteBlackboard" &&
      legacyType === "NodeActionBumpReplanCount"
    ) {
      return { key: "replanCount", mode: "increment" };
    }
    if (canonicalType === "NodeActionRouteTo" && legacyType && legacyType !== canonicalType) {
      return migrateActionParams(canonicalType, {}, nodeId, legacyType);
    }
    return undefined;
  }
  if (!isPlainObject(params)) return params;
  // Extension actions own their parameter vocabulary, including opaque strings.
  if (!Object.hasOwn(LEGACY_PIN_FIELDS, canonicalType) && !Object.hasOwn(PARAM_KEY_ALIASES, canonicalType)) {
    return params;
  }
  const renames = PARAM_KEY_ALIASES[canonicalType];
  let out: Record<string, unknown> = { ...params };
  if (renames) {
    for (const [from, to] of Object.entries(renames)) {
      if (Object.prototype.hasOwnProperty.call(out, from) && !(to in out)) {
        out[to] = out[from];
      }
      delete out[from];
    }
  }
  out = migratePinRefsInParams(canonicalType, out);
  if (canonicalType === "NodeActionRoleRoundBuilder") {
    delete out.recallMemory;
    if (Array.isArray(out.steps)) {
      out.steps = out.steps.filter((step) =>
        !step || typeof step !== "object" ||
        !["NodeActionWriteTurnMemory", "NodeActionRecallTurnMemory"].includes(
          (step as { type?: string }).type ?? "",
        ),
      );
    }
  }
  if (canonicalType === "NodeActionReadBlackboard") {
    // inject / injectLabel retired (PromptInject source=blackboard covers it).
    delete out.inject;
    delete out.injectLabel;
  }
  if (canonicalType === "NodeActionPromptInject") {
    return migratePromptInjectParams(out);
  }
  if (canonicalType === "NodeActionPrepareRole") {
    return migratePrepareRoleTemplate(out);
  }
  if (
    canonicalType === "NodeActionPrepareTools" ||
    canonicalType === "NodeActionRunTools"
  ) {
    return migrateAskModeToToolLists(out, canonicalType);
  }
  if (canonicalType === "NodeActionRouteTo") {
    // Legacy RouteToIf / pin-gate / when-table — do not rewrite into event routes.
    if (
      legacyType === "NodeActionRouteToIf" ||
      (typeof out.pin === "string" && out.pin.trim()) ||
      (Array.isArray(out.when) && out.when.length > 0)
    ) {
      return migrateRouteToFlagTableParams(out);
    }
    if (legacyType === "NodeActionRouteSkillReflect") {
      return migrateRouteSkillReflectToRoutes(out, nodeId);
    }
    if (legacyType === "NodeActionRouteAfterRound" || legacyType === "NodeActionAdvanceRole" ||
      legacyType === "NodeActionSkillReflectAdvance" ||
      SPECIALIZED_ROUTE_AFTER_TYPES.has(legacyType ?? "") ||
      Object.keys(out).some((key) => /^on(Stay|Leave|Reflect|Direct|Plan|Rewrite|DocWritten|Resume|StepBlocked)$/.test(key)) ||
      isPlainObject(out.routes)) {
      return migrateRouteAfterToRoutes(nodeId, legacyType ?? canonicalType, out);
    }
    return out;
  }
  if (canonicalType === "NodeActionStartTurn") {
    return migrateStartTurnParams(out);
  }
  if (canonicalType === "NodeActionApplyControlIntent") {
    return migrateApplyControlIntentParams(out);
  }
  if (
    canonicalType === "NodeActionWriteBlackboard" &&
    legacyType === "NodeActionBumpReplanCount"
  ) {
    return { ...out, key: "replanCount", mode: "increment" };
  }
  return out;
}

/**
 * Route guides and session phase are stable orientation — prefer Bucket0
 * system every round. Saved graphs that left them on the trailing overlay
 * (or set oncePerNode under system) are normalized on load.
 */
export function migratePromptInjectParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...params };
  if (out.source === "routeGuide" || out.source === "phase") {
    out.placement = "system";
  }
  if (out.placement === "system") {
    delete out.frequency;
  }
  return out;
}

/** Approve → planner resume: stamp opaque planning phase when review gate is used. */
export function migrateApplyControlIntentParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...params };
  const requirePhase =
    typeof out.approveRequirePhase === "string"
      ? out.approveRequirePhase.trim()
      : "";
  const setPhase =
    typeof out.approveSetPhase === "string" ? out.approveSetPhase.trim() : "";
  if (requirePhase === "review" && !setPhase) {
    out.approveSetPhase = "planning";
  }
  return out;
}

/**
 * Drop rolePins + retired phaseResume params. Stale-executing clear moves to
 * clearPhaseUnlessIncompletePlan. Phase→node resume is lifted to Compare +
 * RouteTo pin gate (session blackboard key phase) in migrateFSMGraphConfig.
 */
export function migrateStartTurnParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...params };
  delete out.rolePins;
  delete out.phaseResume;
  delete out.resumeRequireIncompletePlan;
  delete out.clearPhaseWhenResumeSkipped;
  delete out.initialActiveRole;
  delete out.approvedUserText;
  delete out.clearPhaseUnlessIncompletePlan;
  delete out.skipHooks;
  return out;
}

/** Collapse legacy pin+key/allOf into when[]; keep when[] rows on `to`. */
export function migrateRouteToFlagTableParams(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const onlyIf = params.onlyIfRouteTargetUnset === true;
  const whenRows: unknown[] = [];

  if (Array.isArray(params.when)) {
    for (const item of params.when) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        whenRows.push(item);
        continue;
      }
      const row = { ...(item as Record<string, unknown>) };
      if (
        typeof row.to !== "string" ||
        !row.to.trim()
      ) {
        if (typeof row.pin === "string" && row.pin.trim()) {
          row.to = resolvePinName(row.pin.trim());
        }
      } else {
        row.to = resolvePinName(row.to.trim());
      }
      delete row.pin;
      if (typeof row.key === "string") row.key = row.key.trim();
      if (Array.isArray(row.allOf)) {
        row.allOf = row.allOf
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter(Boolean);
      }
      const expr = legacyWhenRowToExpr(row);
      if (typeof row.to === "string" && row.to && expr) {
        whenRows.push({ expr, to: row.to });
      } else {
        // Migration must not erase authoring errors before Action validation.
        whenRows.push(row);
      }
    }
  }

  if (
    whenRows.length === 0 &&
    typeof params.pin === "string" &&
    params.pin.trim()
  ) {
    const legacyRow: Record<string, unknown> = {
      to: resolvePinName(params.pin.trim()),
    };
    if (typeof params.expr === "string") legacyRow.expr = params.expr.trim();
    if (Array.isArray(params.allOf)) {
      const allOf = params.allOf
        .filter((x): x is string => typeof x === "string")
        .map((x) => x.trim())
        .filter(Boolean);
      if (allOf.length > 0) legacyRow.allOf = allOf;
    }
    if (!legacyRow.allOf && typeof params.key === "string" && params.key.trim()) {
      legacyRow.key = params.key.trim();
    }
    const expr = legacyWhenRowToExpr(legacyRow);
    whenRows.push(expr ? { expr, to: legacyRow.to } : legacyRow);
  }

  const out: Record<string, unknown> = { ...params, when: whenRows };
  for (const key of ["pin", "expr", "key", "allOf"]) delete out[key];
  if (onlyIf) out.onlyIfRouteTargetUnset = true;
  const defaultPin =
    typeof params.defaultPin === "string" ? params.defaultPin.trim() : "";
  if (defaultPin) out.defaultPin = defaultPin;
  return out;
}

/** Rewrite string / pin-map / route-binding values that still use legacy pin names. */
export function migratePinRefsInParams(
  canonicalType: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...params };
  const fields = Object.hasOwn(LEGACY_PIN_FIELDS, canonicalType) ? LEGACY_PIN_FIELDS[canonicalType] : undefined;
  if (!fields) return out;
  for (const key of fields.selectKeys) {
    if (typeof out[key] === "string") out[key] = resolvePinName(out[key]);
  }
  for (const key of fields.bindingKeys) {
    const value = out[key];
    if (Array.isArray(value)) {
      out[key] = value.map((item) => {
        if (!isPlainObject(item)) return item;
        const next = { ...item };
        if (typeof next.to === "string") next.to = resolvePinName(next.to);
        if (typeof next.pin === "string") next.pin = resolvePinName(next.pin);
        if (typeof next.event === "string" && next.event === "checklist_resume") {
          next.event = "plan_resume";
        }
        return next;
      });
    } else if (isPlainObject(value)) {
      const nested: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        const keyOut = k === "checklist_resume" ? "plan_resume" : k;
        nested[keyOut] =
          typeof v === "string" ? resolvePinName(v) : v;
      }
      out[key] = nested;
    }
  }
  for (const key of fields.mapKeys) {
    if (isPlainObject(out[key])) {
      out[key] = Object.fromEntries(Object.entries(out[key]).map(([name, value]) =>
        [name, typeof value === "string" ? resolvePinName(value) : value],
      ));
    }
  }
  return out;
}

