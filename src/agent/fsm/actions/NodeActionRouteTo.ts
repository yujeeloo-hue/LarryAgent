import { FSMConfigError } from "../FSMConfigError.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { validateBlackboardKey } from "../blackboardKeys.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";
import {
  normalizeRouteBindings,
  routeBindingsToMap,
  ROUTE_EVENT_LEAVE,
  ROUTE_EVENT_STAY,
} from "./routeEvents.js";
import { toolsRanOrInjected } from "./routeAfterCommon.js";
import {
  evaluateRouteWhenExpr,
  validateRouteWhenExpr,
  legacyWhenRowToExpr,
} from "./routeWhenExpr.js";

export {
  ROUTE_TARGET_REFLECT,
  ROUTE_TARGET_REFLECT_DONE,
  ROUTE_TARGET_STEP_CLAIM,
} from "./routeAfterCommon.js";

export type RouteToWhenRow = {
  /** Boolean expression (&& / ||) over turn flags; preferred. */
  expr?: string;
  /** Legacy AND keys when expr is absent. */
  keys: string[];
  /** Destination pin. */
  to: string;
};

/** Pure semantic checks for normalized Action params. */
export function validateNodeActionRouteToParams(
  params: Readonly<Record<string, unknown>>,
  label: string,
): void {
  const whenRows = Array.isArray(params.when) ? params.when : [];
  const hasWhen = whenRows.length > 0;
  const hasLegacyPin =
    typeof params.pin === "string" && params.pin.trim().length > 0;

  if (hasWhen) {
    for (const [i, item] of whenRows.entries()) {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: when[${i}] must be an object`,
        );
      }
      const row = item as Record<string, unknown>;
      const to =
        typeof row.to === "string" && row.to.trim()
          ? row.to.trim()
          : typeof row.pin === "string" && row.pin.trim()
            ? row.pin.trim()
            : "";
      if (!to) {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: when[${i}] requires to (pin)`,
        );
      }
      const hasExpr =
        typeof row.expr === "string" && row.expr.trim().length > 0;
      const hasKey =
        typeof row.key === "string" && row.key.trim().length > 0;
      const allOf = Array.isArray(row.allOf)
        ? row.allOf.filter(
            (x): x is string => typeof x === "string" && x.trim().length > 0,
          )
        : [];
      if (!hasExpr && !hasKey && allOf.length === 0) {
        throw new FSMConfigError(
          "INVALID_ACTION_PARAMS",
          `${label}: when[${i}] requires expr, key, or allOf`,
        );
      }
      if (hasExpr) {
        const exprError = validateRouteWhenExpr(row.expr as string, label);
        if (exprError) {
          throw new FSMConfigError("INVALID_ACTION_PARAMS", exprError);
        }
      }
      if (hasKey) {
        const keyError = validateBlackboardKey(row.key, label);
        if (keyError) {
          throw new FSMConfigError("INVALID_ACTION_PARAMS", keyError);
        }
      }
      for (const flag of allOf) {
        const keyError = validateBlackboardKey(flag, label);
        if (keyError) {
          throw new FSMConfigError("INVALID_ACTION_PARAMS", keyError);
        }
      }
    }
    return;
  }

  if (hasLegacyPin) {
    const hasExpr =
      typeof params.expr === "string" && params.expr.trim().length > 0;
    const hasKey =
      typeof params.key === "string" && params.key.trim().length > 0;
    const allOf = Array.isArray(params.allOf)
      ? params.allOf.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      : [];
    if (!hasExpr && !hasKey && allOf.length === 0) {
      throw new FSMConfigError(
        "INVALID_ACTION_PARAMS",
        `${label}: pin gate requires expr, key, or allOf`,
      );
    }
    if (hasExpr) {
      const exprError = validateRouteWhenExpr(params.expr as string, label);
      if (exprError) {
        throw new FSMConfigError("INVALID_ACTION_PARAMS", exprError);
      }
    }
    if (hasKey) {
      const keyError = validateBlackboardKey(params.key, label);
      if (keyError) {
        throw new FSMConfigError("INVALID_ACTION_PARAMS", keyError);
      }
    }
    for (const flag of allOf) {
      const keyError = validateBlackboardKey(flag, label);
      if (keyError) {
        throw new FSMConfigError("INVALID_ACTION_PARAMS", keyError);
      }
    }
    return;
  }
}

export const NodeActionRouteToSchema: FsmParamsSchema = {
  type: "object",
  "x-ui": "route-to",
  title: "Route to",
  description:
    "Set nodeContext.routeTarget from event→pin bindings (role rounds) or boolean flag expressions (when[]).",
  "x-llmDescription": "Close the round by writing nodeContext.routeTarget (a pin of this node). Shape 1: routes [{event,to}] binds route events (stay, leave, fsm_route values, tool events) to pins; fallback stay when tools ran or a subagent batch injected, else leave. Shape 2: when [{expr,to}] boolean rows over Compare asKey flags (&& || parentheses; first match wins) with optional defaultPin and onlyIfRouteTargetUnset. Precedence: explicit routeEvent, then when[], then event fallback.",
  additionalProperties: false,
  "x-emitsRouteEvents": [ROUTE_EVENT_STAY, ROUTE_EVENT_LEAVE],
  details: `RouteTo writes nodeContext.routeTarget (a pin name). Use ONE of these shapes per node (they can coexist — see precedence below).

1) Event table (role-round closer) — param routes:
   routes: [{ event: "stay", to: "<pin>" }, { event: "leave", to: "<pin>" }, ...]
   Resolves nodeContext.routeEvent from EmitRouteEvent / fsm_route. An event with no binding here falls through to the stay/leave fallback (fsm_route already rejects routes this node does not bind, and tools fire the same event on every node) — it never ends the turn. When no routeEvent: stay if tools ran or subagent batch injected, else leave. Skipped when stepClaimed=true.

2) Flag table (Compare-driven) — param when:
   when: [{ expr: "<boolean expr>", to: "<pin>" }, ...]
   optional: onlyIfRouteTargetUnset (skip if routeTarget already set), defaultPin (fallback pin).

   expr syntax: turn register flag names (from Compare asKey) joined with && (AND) and || (OR). Parentheses group sub-expressions. && binds tighter than ||.
   Examples:
     "reflect.auto && reflect.fullPerms"
     "resume.phase.executing && resume.planOpen.executing"
     "flag.a || flag.b && flag.c"  →  flag.a || (flag.b && flag.c)
     "(flag.a || flag.b) && flag.c"

   Rows are tried in array order; first expr that evaluates true wins. Different pins need separate rows (or one expr with || only when they share the same pin). Legacy rows { key } or { allOf: [...] } still work (treated as AND); prefer expr for new graphs.

Precedence when both routes and when exist: explicit routeEvent uses routes first; else when[] runs; else event stay/leave fallback.`,
  properties: {
    when: {
      type: "array",
      title: "When",
      description:
        "Flag routing table. Each item: { expr: string, to: pin }. First matching expr wins. Legacy { key } / { allOf: string[] } accepted.",
      items: {
        type: "object",
        properties: {
          expr: {
            type: "string",
            description:
              "Boolean expression over turn flags (Compare asKey names). Operators: && || (). Example: \"a && b || c\".",
          },
          to: {
            type: "string",
            minLength: 1,
            description: "Destination pin when expr is true.",
          },
          key: {
            type: "string",
            description: "Legacy single flag (prefer expr).",
          },
          allOf: {
            type: "array",
            items: { type: "string" },
            description: "Legacy AND list (prefer expr with &&).",
          },
        },
      },
      "x-ui": "hidden",
    },
    onlyIfRouteTargetUnset: {
      type: "boolean",
      default: false,
      title: "Only if route unset",
      description:
        "when[] only: skip flag routing when nodeContext.routeTarget is already set (e.g. Approve pin won).",
      "x-ui": "hidden",
    },
    defaultPin: {
      type: "string",
      minLength: 1,
      title: "Default pin",
      description:
        "when[] only: route here when no expr row matches and routeTarget is still unset.",
      "x-ui": "hidden",
    },
    routes: {
      type: "array",
      title: "Routes",
      description:
        "Event table: [{ event: string, to: pin }, ...]. Binds nodeContext.routeEvent to a pin.",
      items: {
        type: "object",
        properties: {
          event: { type: "string", description: "Route event name (e.g. stay, leave, fsm_route value)." },
          to: { type: "string", description: "Pin when this event fires." },
        },
      },
      "x-ui": "hidden",
    },
    // Legacy single-row pin gate (migrated to when[] on load).
    pin: {
      type: "string",
      minLength: 1,
      title: "Pin (legacy)",
      description: "Legacy single-row flag gate; prefer when[].",
      "x-ui": "hidden",
    },
    key: {
      type: "string",
      minLength: 1,
      title: "Flag key (legacy)",
      description: "Legacy single-row flag key; prefer when[].",
      "x-ui": "hidden",
    },
    allOf: {
      type: "array",
      items: { type: "string", minLength: 1 },
      title: "All flags (legacy)",
      description: "Legacy single-row AND flags; prefer when[].",
      "x-ui": "hidden",
    },
  },
};

function readRoutesMap(
  params: Record<string, unknown>,
): Record<string, string> {
  const fromRoutes = routeBindingsToMap(normalizeRouteBindings(params.routes));
  if (Object.keys(fromRoutes).length > 0) return fromRoutes;

  // Legacy flat onStay/onLeave before migration.
  const legacy: Record<string, string> = {};
  if (typeof params.onStay === "string" && params.onStay.trim()) {
    legacy[ROUTE_EVENT_STAY] = params.onStay.trim();
  }
  if (typeof params.onLeave === "string" && params.onLeave.trim()) {
    legacy[ROUTE_EVENT_LEAVE] = params.onLeave.trim();
  } else if (
    typeof params.onReflect === "string" &&
    params.onReflect.trim()
  ) {
    legacy[ROUTE_EVENT_LEAVE] = params.onReflect.trim();
  }
  return legacy;
}

function continueToEvent(
  routes: Record<string, string>,
  event: string,
  label: string,
): NodeActionExecResult {
  const pin = routes[event];
  if (!pin) {
    return {
      status: "halt",
      errorMessage: `${label}: route event "${event}" is not bound in routes`,
    };
  }
  return {
    status: "continue",
    nodeContextPatch: { routeTarget: pin, routeEvent: event },
  };
}

function flagKeysFromRow(row: Record<string, unknown>): string[] {
  if (typeof row.expr === "string" && row.expr.trim()) {
    return [];
  }
  if (Array.isArray(row.allOf)) {
    return row.allOf
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  if (typeof row.key === "string" && row.key.trim()) {
    return [row.key.trim()];
  }
  return [];
}

function rowPin(row: Record<string, unknown>): string {
  if (typeof row.to === "string" && row.to.trim()) return row.to.trim();
  if (typeof row.pin === "string" && row.pin.trim()) return row.pin.trim();
  return "";
}

/**
 * Normalize flag-table rows from `when[]` or legacy pin + key/allOf.
 * Returns null when this is not a flag-gate shape.
 */
export function normalizeRouteToWhenRows(
  params: Record<string, unknown> | undefined,
): RouteToWhenRow[] | null {
  if (!params) return null;

  if (Array.isArray(params.when) && params.when.length > 0) {
    const rows: RouteToWhenRow[] = [];
    for (const item of params.when) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const keys = flagKeysFromRow(row);
      const expr =
        typeof row.expr === "string" && row.expr.trim()
          ? row.expr.trim()
          : undefined;
      const to = rowPin(row);
      if ((!expr && keys.length === 0) || !to) continue;
      rows.push({ ...(expr ? { expr } : {}), keys, to });
    }
    return rows.length > 0 ? rows : null;
  }

  const legacyPin =
    typeof params.pin === "string" && params.pin.trim()
      ? params.pin.trim()
      : "";
  if (!legacyPin) return null;
  const keys = flagKeysFromRow(params);
  if (keys.length === 0 && !legacyWhenRowToExpr(params)) return null;
  const expr = legacyWhenRowToExpr(params);
  return [{ ...(expr ? { expr } : {}), keys, to: legacyPin }];
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === "true" || value === 1;
}

function execFlagTable(
  params: Record<string, unknown>,
  rows: RouteToWhenRow[],
  args: NodeActionExecArgs,
  label: string,
): NodeActionExecResult {
  if (params.onlyIfRouteTargetUnset === true) {
    const existing = args.nodeContext.routeTarget;
    if (typeof existing === "string" && existing.trim()) {
      return { status: "continue" };
    }
  }

  for (const row of rows) {
    if (row.expr) {
      const ev = evaluateRouteWhenExpr(row.expr, args.turnContext, label);
      if (ev.kind === "halt") {
        return { status: "halt", errorMessage: ev.message };
      }
      if (!ev.met) continue;
      return {
        status: "continue",
        nodeContextPatch: { routeTarget: row.to },
      };
    }
    let allMet = true;
    for (const key of row.keys) {
      const keyError = validateBlackboardKey(key, label);
      if (keyError) {
        return { status: "halt", errorMessage: keyError };
      }
      if (!isTruthyFlag(args.turnContext[key])) {
        allMet = false;
        break;
      }
    }
    if (!allMet) continue;
    return {
      status: "continue",
      nodeContextPatch: { routeTarget: row.to },
    };
  }
  const defaultPin =
    typeof params.defaultPin === "string" ? params.defaultPin.trim() : "";
  if (defaultPin) {
    return {
      status: "continue",
      nodeContextPatch: { routeTarget: defaultPin },
    };
  }
  return { status: "continue" };
}

function execEventFallback(
  routes: Record<string, string>,
  args: NodeActionExecArgs,
  label: string,
): NodeActionExecResult {
  const { toolsPath, injected, interrupted } = toolsRanOrInjected(
    args.nodeContext,
  );
  const fallback =
    toolsPath || injected || interrupted
      ? ROUTE_EVENT_STAY
      : ROUTE_EVENT_LEAVE;
  return continueToEvent(routes, fallback, label);
}

function execExplicitRouteEvent(
  routes: Record<string, string>,
  args: NodeActionExecArgs,
  label: string,
): NodeActionExecResult | null {
  const rawEvent = args.nodeContext.routeEvent;
  if (typeof rawEvent !== "string" || !rawEvent.trim()) return null;
  const event = rawEvent.trim();
  if (routes[event]) {
    return continueToEvent(routes, event, label);
  }
  // Unbound event — from a tool that fires one event on every node, or a model
  // route this node has no pin for (`fsm_route` rejects those up front, so this
  // is the last net). Fall through to the stay/leave fallback: the round stays
  // on the node and the model can route again. Never end the turn over it.
  return null;
}

function execEventTable(
  params: Record<string, unknown>,
  args: NodeActionExecArgs,
  label: string,
): NodeActionExecResult {
  if (args.nodeContext.stepClaimed === true) {
    return { status: "continue" };
  }

  const routes = readRoutesMap(params);
  if (Object.keys(routes).length === 0) {
    return {
      status: "halt",
      errorMessage: `${label}: routes map is empty`,
    };
  }

  const explicit = execExplicitRouteEvent(routes, args, label);
  if (explicit) return explicit;

  return execEventFallback(routes, args, label);
}

/**
 * Topology-blind router: event table (role rounds) or Compare-flag when table.
 */
export class NodeActionRouteTo extends NodeActionStubBase {
  readonly type = "NodeActionRouteTo";

  override declaredRouteEvents(): readonly string[] {
    return Object.keys(readRoutesMap(this.params));
  }

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const label = this.type;
    const whenRows = normalizeRouteToWhenRows(this.params);
    const routes = readRoutesMap(this.params);
    const hasRoutes = Object.keys(routes).length > 0;
    const hasWhen = whenRows !== null;

    if (!hasWhen && !hasRoutes) {
      // Legacy pin without key/allOf — authoring bug.
      if (typeof this.params.pin === "string" && this.params.pin.trim()) {
        return {
          status: "halt",
          errorMessage: `${label}: pin gate requires key or allOf (or when[])`,
        };
      }
      if (Array.isArray(this.params.when)) {
        return {
          status: "halt",
          errorMessage: `${label}: when[] has no valid rows (need key|allOf + to)`,
        };
      }
      return {
        status: "halt",
        errorMessage: `${label}: no route mappings (when[] or routes)`,
      };
    }

    // Corrections outrank plan/tool events from the superseded round. This
    // also covers enqueue arriving after the provider's final done event.
    if (hasRoutes && (args.nodeContext.roundInterrupted === true || args.host?.hasPendingSteer())) {
      return continueToEvent(routes, ROUTE_EVENT_STAY, label);
    }

    if (args.nodeContext.stepClaimed === true && hasRoutes) {
      return { status: "continue" };
    }

    if (hasRoutes) {
      const explicit = execExplicitRouteEvent(routes, args, label);
      if (explicit) return explicit;
    }

    if (hasWhen && whenRows) {
      const flagResult = execFlagTable(this.params, whenRows, args, label);
      if (flagResult.status === "halt") return flagResult;
      if (flagResult.nodeContextPatch?.routeTarget) return flagResult;
    }

    if (hasRoutes) {
      return execEventFallback(routes, args, label);
    }

    return { status: "continue" };
  }
}
