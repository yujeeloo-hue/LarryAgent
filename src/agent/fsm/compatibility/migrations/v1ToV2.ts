import type { LegacyFSMGraphConfig } from "../types.js";
/** Historical v1 graph compatibility; independent of current graph presets. */
import type { FSMGraphConfig, FSMGraphNodeConfig } from "../../types.js";
import {
  extractPhaseResumeLift,
  migrateSetPhaseAction,
  expandLegacyRouteToWhen,
  REMOVED_ACTION_TYPES,
  expandLegacyApplyPlanEffects,
  ensurePlannerPlanningPhase,
  ensurePostToolSplitActions,
  migrateSkillReflectTopology,
  migrateSkillReflectGateStack,
  applyPhaseResumeCompareRoute,
  hoistLegacyStartTurnParams,
} from "../legacyTopology.js";
import { resolveActionType, resolvePinName } from "../legacyAliases.js";
import {
  extractMovedPhaseOverlay,
  expandLegacyBuildNodeOverlay,
  actionsFromLegacyOnEnter,
  isLegacyRolePreparation,
  LEGACY_PRESET_BUILD_OVERLAY,
  LEGACY_OVERLAY_PRESET_STATIC,
  migrateRolePreparationActions,
} from "../legacyRoles.js";
import { migrateActionParams } from "../legacyActionParams.js";

/**
 * Rewrite legacy NodeAction type / param keys / pin names in a graph config.
 * Call on load/save so editor + runtime share canonical names.
 */
export function migrateV1ToV2(input: LegacyFSMGraphConfig): FSMGraphConfig {
  const config = migrateSkillReflectTopology(migrateSkillReflectGateStack({
    ...structuredClone(input), version: 2,
  }));
  const phaseResumeLift = extractPhaseResumeLift(config);
  const nodes = hoistLegacyStartTurnParams(config.nodes);
  const migrated = {
    ...config,
    nodes: nodes.map(migrateV1Node),
    edges: config.edges.map((edge) => {
      const params = edge.params;
      if (!params || typeof params !== "object") return edge;
      const next = { ...(params as Record<string, unknown>) };
      if (edge.type === "EdgeWhen" && next.turnKey === "routeTarget" && typeof next.equals === "string") {
        next.equals = resolvePinName(next.equals);
      }
      return { ...edge, params: next };
    }),
  };
  return applyPhaseResumeCompareRoute(migrated, phaseResumeLift);
}

/** The same action conversion applies recursively to composite children. */
function migrateV1Node(node: FSMGraphNodeConfig): FSMGraphNodeConfig {
  const legacyPlanner = (node.id === "planner" || node.id === "replanner") &&
    (node.actions ?? []).some((action) =>
      resolveActionType(action.type) === "NodeActionPrepareRole" &&
      action.params?.roleKind === node.id &&
      isLegacyRolePreparation(action.params ?? {}),
    );
  // Legacy PrepareRole overlay upgrade: only fire when the node has no
  // overlay action at all — BuildNodeOverlay (legacy) or any PromptInject.
  const hasBuildOverlay = (node.actions ?? []).some(
    (a) =>
      resolveActionType(a.type) === "NodeActionBuildNodeOverlay" ||
      a.type === "NodeActionPromptInject",
  );
  const migratedActions: NonNullable<typeof node.actions> = [];
  let pendingPhaseOverlay: string | undefined;
  for (const action of node.actions ?? []) {
    const rawParams =
      action.params &&
      typeof action.params === "object" &&
      !Array.isArray(action.params)
        ? (action.params as Record<string, unknown>)
        : undefined;
    const rawPreset =
      typeof rawParams?.overlayPreset === "string"
        ? String(rawParams.overlayPreset).trim()
        : "";
    const movedPhaseOverlay = extractMovedPhaseOverlay(rawParams);

    const legacyType = action.type.trim();
    if (
      legacyType === "NodeActionSetPhase" ||
      resolveActionType(legacyType) === "NodeActionSetPhase"
    ) {
      migratedActions.push(migrateSetPhaseAction(action.params));
      continue;
    }
    if (
      legacyType === "NodeActionRouteToWhen" ||
      resolveActionType(legacyType) === "NodeActionRouteToWhen"
    ) {
      const rtwParams =
        action.params &&
        typeof action.params === "object" &&
        !Array.isArray(action.params)
          ? (action.params as Record<string, unknown>)
          : {};
      migratedActions.push(...expandLegacyRouteToWhen(rtwParams));
      continue;
    }
    if (REMOVED_ACTION_TYPES.has(legacyType)) {
      continue;
    }
    const type = resolveActionType(legacyType);
    if (REMOVED_ACTION_TYPES.has(type)) {
      continue;
    }
    let params = migrateActionParams(
      type,
      action.params,
      node.id,
      legacyType,
    );

    if (type === "NodeActionBuildNodeOverlay" && pendingPhaseOverlay) {
      const buildParams = {
        ...((params as Record<string, unknown> | undefined) ?? {}),
      };
      if (
        typeof buildParams.phaseOverlay !== "string" ||
        !String(buildParams.phaseOverlay).trim()
      ) {
        buildParams.phaseOverlay = pendingPhaseOverlay;
      }
      params = buildParams;
      pendingPhaseOverlay = undefined;
    }

    const expandedActions =
      type === "NodeActionBuildNodeOverlay"
        ? expandLegacyBuildNodeOverlay({
            type,
            ...(params !== undefined
              ? { params: params as Record<string, unknown> }
              : {}),
          })
        : [
            {
              type,
              ...(params !== undefined
                ? { params: params as Record<string, unknown> }
                : {}),
            },
          ];
    for (const expanded of expandedActions) {
      for (const action of expandLegacyApplyPlanEffects(expanded)) {
        migratedActions.push(action);
      }
    }

    if (type === "NodeActionPrepareRole") {
      const legacyOnEnter = rawParams?.onEnter;
      for (const extra of actionsFromLegacyOnEnter(legacyOnEnter)) {
        migratedActions.push(extra);
      }
      if (!hasBuildOverlay) {
        const roleKind =
          params &&
          typeof params === "object" &&
          typeof (params as Record<string, unknown>).roleKind === "string"
            ? String((params as Record<string, unknown>).roleKind).trim()
            : "";
        const legacyIdentity = isLegacyRolePreparation(
          (params as Record<string, unknown>) ?? {},
        );
        const inferredOverlay = legacyIdentity
          ? (roleKind && Object.hasOwn(LEGACY_PRESET_BUILD_OVERLAY, roleKind) ? roleKind : undefined)
          : undefined;
        const overlayKey =
          (rawPreset && Object.hasOwn(LEGACY_PRESET_BUILD_OVERLAY, rawPreset)
            ? rawPreset
            : undefined) ??
          inferredOverlay;
        const staticText =
          movedPhaseOverlay ??
          (overlayKey ? LEGACY_OVERLAY_PRESET_STATIC[overlayKey] : undefined);
        if (overlayKey || staticText) {
          const overlayActions = expandLegacyBuildNodeOverlay({
            type: "NodeActionBuildNodeOverlay",
            params: {
              ...(overlayKey
                ? { ...LEGACY_PRESET_BUILD_OVERLAY[overlayKey] }
                : {}),
              ...(staticText ? { phaseOverlay: staticText } : {}),
            },
          });
          migratedActions.push(...overlayActions);
        }
      } else if (movedPhaseOverlay) {
        pendingPhaseOverlay = movedPhaseOverlay;
      }
    }
  }
  const actions = migrateRolePreparationActions(
    ensurePlannerPlanningPhase(ensurePostToolSplitActions(migratedActions, legacyPlanner), node.id),
    node.id,
    (children) => migrateV1Node({ ...node, actions: children }).actions ?? [],
  );
  return {
    ...node,
    ...(node.pins !== undefined ? {
      pins: node.pins.map((pin) => ({ ...pin, name: resolvePinName(pin.name) })),
    } : {}),
    ...(node.actions !== undefined || actions.length > 0 ? { actions } : {}),
  };

}
