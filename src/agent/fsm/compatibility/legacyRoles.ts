/** Historical v1 graph compatibility; independent of current graph presets. */
import { writeSessionPhaseAction } from "./legacyUtils.js";
import type { NodeActionConfig } from "../types.js";
import { migrateActionParams } from "./legacyActionParams.js";
import { rolePresetParams, presetPlanStepAction } from "./legacyPresets.js";
import { isPlainObject } from "./legacyUtils.js";

/** Actions formerly embedded in PrepareRole.onEnter. */
export function actionsFromLegacyOnEnter(
  onEnter: unknown,
): Array<{ type: string; params: Record<string, unknown> }> {
  if (!onEnter || typeof onEnter !== "object" || Array.isArray(onEnter)) {
    return [];
  }
  const obj = onEnter as Record<string, unknown>;
  const out: Array<{ type: string; params: Record<string, unknown> }> = [];

  const phaseRaw = obj.phase ?? obj.phase;
  if (phaseRaw === null) {
    out.push(writeSessionPhaseAction(null));
  } else if (typeof phaseRaw === "string" && phaseRaw.trim()) {
    const value = phaseRaw.trim();
    out.push(
      writeSessionPhaseAction(value === "none" || value === "clear" ? null : value),
    );
  }

  if (obj.bumpReplanCount === true) {
    out.push({
      type: "NodeActionWriteBlackboard",
      params: { key: "replanCount", mode: "increment" },
    });
  }
  // ensureInProgress: retired — update_plan auto-starts steps; load-time repair handles legacy sessions.
  if (obj.completeActivePlan === true) {
    out.push({ type: "NodeActionCompleteActivePlan", params: {} });
  }
  return out;
}

/**
 * Static phase text formerly on PrepareRole / overlayPreset — moved to
 * PromptInject(note) (via legacy BuildNodeOverlay.phaseOverlay expansion).
 */
export function extractMovedPhaseOverlay(
  rawParams: Record<string, unknown> | undefined,
): string | undefined {
  if (!rawParams) return undefined;
  const direct =
    typeof rawParams.phaseOverlay === "string"
      ? rawParams.phaseOverlay.trim()
      : "";
  if (direct) return direct;
  const legacyPreset =
    typeof rawParams.overlayPreset === "string"
      ? rawParams.overlayPreset.trim()
      : "";
  if (
    legacyPreset &&
    legacyPreset !== "none" &&
    legacyPreset !== "custom" &&
    Object.hasOwn(LEGACY_OVERLAY_PRESET_STATIC, legacyPreset)
  ) {
    return LEGACY_OVERLAY_PRESET_STATIC[legacyPreset];
  }
  return undefined;
}

export const LEGACY_OVERLAY_PRESET_STATIC: Record<string, string> = {
  analyser: [
    "[Analyse phase]",
    "Collect just enough context to choose Direct vs a written plan from task complexity.",
    "Do not complete the user's task here. run_shell is for investigation only.",
    "Once context is sufficient, call fsm_route with direct, gather, or plan.",
    "plan → plan_writer. direct → execute without a plan document. gather → stay here.",
    "Do not state the route only in prose.",
  ].join("\n"),
  planner: [
    "[Plan checklist phase]",
    "The user approved the plan document. Call create_plan with 2–12 step titles in execution order (serial, one at a time).",
    "Do not rewrite the document. Do not gather. Do not go Direct.",
  ].join("\n"),
  plan_writer: [
    "[Plan document phase]",
    "Call write_plan_doc when ready.",
    "Revising the existing doc? Send the complete updated content (title, content, summary only).",
  ].join("\n"),
  plan_reviewer: [
    "[Plan review phase]",
    "Follow the PLAN_REVIEWER checklist in the role body above.",
    "Fill gaps yourself (ask_user, read/search, write_plan_doc).",
    "Ask all open decisions together: every ask_user call in one response, then a single write_plan_doc with all answers.",
    "After all sealed items are settled, judge whether the plan merits one Socratic round — skip only genuinely simple fixed-route plans — and record either way (`asked` or `skipped — reason`) before ready.",
    "When the document is unambiguous and the Socratic round is complete, call fsm_route with ready — then wait for the user to Approve.",
    "If the document's premise is wrong, call fsm_route with rewrite.",
    "Do not call create_plan.",
  ].join("\n"),
  replanner: "[Replan phase]",
};

/**
 * Expand the legacy multi-source BuildNodeOverlay into a PromptInject
 * sequence, preserving the former composed block order:
 * note → routeGuide → plan → planDoc → pendingPlanDraft → phase.
 * Empty legacy toggles expand to nothing (the action is dropped).
 */
export function expandLegacyBuildNodeOverlay(params: {
  type: string;
  params?: Record<string, unknown>;
}): Array<{ type: string; params?: Record<string, unknown> }> {
  if (params.type !== "NodeActionBuildNodeOverlay") {
    return [params];
  }
  const raw =
    params.params &&
    typeof params.params === "object" &&
    !Array.isArray(params.params)
      ? params.params
      : {};
  const out: Array<{ type: string; params?: Record<string, unknown> }> = [];
  const note = typeof raw.phaseOverlay === "string" ? raw.phaseOverlay.trim() : "";
  if (note) {
    out.push({ type: "NodeActionPromptInject", params: { source: "note", note } });
  }
  const guide = Array.isArray(raw.routeGuide) ? raw.routeGuide : [];
  if (guide.length > 0) {
    out.push({
      type: "NodeActionPromptInject",
      params: { source: "routeGuide", placement: "system", routeGuide: guide },
    });
  }
  const liveSources: Array<[string, string]> = [
    ["plan", "includePlan"],
    ["planDoc", "includePlanDoc"],
    ["pendingPlanDraft", "includePendingPlanDraft"],
  ];
  for (const [source, key] of liveSources) {
    if (raw[key] === true) {
      out.push({ type: "NodeActionPromptInject", params: { source } });
    }
  }
  if (raw.includePhase === true) {
    out.push({
      type: "NodeActionPromptInject",
      params: { source: "phase", placement: "system" },
    });
  }
  return out;
}

export function isLegacyRolePreparation(params: Record<string, unknown>): boolean {
  const explicitKeys = [
    "personaLabel", "promptPlacement", "promptPreset", "modelBinding", "modelProviderId",
  ];
  return typeof params.roleKind === "string" &&
    !explicitKeys.some((key) => key in params);
}

/** Expand historical role-driven behavior once, into ordinary graph params. */
export function migrateRolePreparationActions(
  actions: NodeActionConfig[],
  nodeId: string,
  migrateChildren: (actions: NodeActionConfig[]) => NodeActionConfig[],
): NodeActionConfig[] {
  const out: NodeActionConfig[] = [];
  let pendingToolPolicy: string | undefined;
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index]!;
    const params = { ...(action.params ?? {}) };
    if (action.type === "NodeActionRoleRoundBuilder") {
      if (Array.isArray(params.steps)) {
        const children = params.steps.filter((child): child is NodeActionConfig =>
          child !== null && typeof child === "object" && !Array.isArray(child) &&
          typeof child.type === "string" && Boolean(child.type.trim()),
        );
        params.steps = migrateChildren(children);
      } else {
        const rawRole = isPlainObject(params.prepareRole) ? params.prepareRole : undefined;
        const preset = typeof params.roleKind === "string" ? params.roleKind :
          typeof rawRole?.roleKind === "string" ? rawRole.roleKind : "agent";
        const legacy = params.prepareRole === undefined || (rawRole && isLegacyRolePreparation(rawRole));
        if (legacy) {
          const preparedRole = migrateActionParams("NodeActionPrepareRole", rawRole) ?? {};
          delete preparedRole.subagentRole;
          params.prepareRole = rolePresetParams(preset, preparedRole);
          params.syncPlanStep ??= presetPlanStepAction(preset, rawRole?.waitingMessage ?? rawRole?.progressLabel).params;
          if (preset === "subagent") {
            pendingToolPolicy = `subagent_${typeof rawRole?.subagentRole === "string" ? rawRole.subagentRole : "general"}`;
            params.prepareTools = {
              toolPolicy: pendingToolPolicy,
              useOfferSet: false,
              ...(params.prepareTools as Record<string, unknown> | undefined),
            };
          }
          params.routeTo ??= { routes: [{ event: "stay", to: nodeId }] };
          if (params.detectStepClaim === true) params.onStepClaim ??= "execution_validator";
        }
        for (const [key, type] of [["prepareTools", "NodeActionPrepareTools"], ["routeTo", "NodeActionRouteTo"]] as const) {
          const childParams = params[key];
          if (isPlainObject(childParams)) {
            params[key] = migrateActionParams(type, childParams, nodeId);
          }
        }
        pendingToolPolicy = undefined;
      }
      out.push({ ...action, params });
      continue;
    }
    if (action.type === "NodeActionPrepareRole") {
      const legacy = isLegacyRolePreparation(params);
      pendingToolPolicy = legacy && params.roleKind === "subagent"
        ? `subagent_${typeof params.subagentRole === "string" ? params.subagentRole : "general"}`
        : undefined;
      delete params.subagentRole;
      out.push({ ...action, params: legacy ? rolePresetParams(String(params.roleKind), params) : params });
      if (legacy && actions[index + 1]?.type !== "NodeActionSyncPlanStep") {
        out.push(presetPlanStepAction(String(params.roleKind), params.waitingMessage));
      }
      continue;
    }
    if (action.type === "NodeActionPrepareTools" && pendingToolPolicy) {
      if (params.toolPolicy === undefined) {
        params.toolPolicy = pendingToolPolicy;
        params.useOfferSet = false;
      }
      out.push({ ...action, params });
      continue;
    }
    out.push(action);
  }
  return out;
}

export const LEGACY_PRESET_BUILD_OVERLAY: Record<string, Record<string, boolean>> = {
  analyser: { includePhase: true },
  planner: { includePlanDoc: true, includePhase: true },
  plan_writer: { includePendingPlanDraft: true, includePhase: true },
  plan_reviewer: { includePlanDoc: true, includePhase: true },
  executor: { includePlan: true, includePlanDoc: true, includePhase: true },
  replanner: { includePlanDoc: true, includePhase: true },
};

