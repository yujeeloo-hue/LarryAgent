/**
 * Route events for RouteTo. Tools enqueue via ToolExecuteResult.routeEvent;
 * EmitRouteEvent flushes the round queue; CheckPlan / EmitRouteEventWhen /
 * gates may write routeEvent directly. Never a next-node id.
 */

export const ROUTE_EVENT_STAY = "stay";
export const ROUTE_EVENT_LEAVE = "leave";
export const ROUTE_EVENT_DOC_WRITTEN = "doc_written";
export const ROUTE_EVENT_STEP_BLOCKED = "step_blocked";
/** Active plan still has open steps — resume executor (not analyser `plan`). */
export const ROUTE_EVENT_PLAN_RESUME = "plan_resume";

/**
 * Catalog hints for EmitRouteEvent (tools / CheckPlan / PromptInject may emit
 * these or other open-ended fsm_route.route values).
 */
export const EMIT_ROUTE_EVENTS = [
  ROUTE_EVENT_DOC_WRITTEN,
  "doc_adopted",
  "plan_approved",
  ROUTE_EVENT_STEP_BLOCKED,
  ROUTE_EVENT_PLAN_RESUME,
  "direct",
  "plan",
  "gather",
  "ready",
  "rewrite",
] as const;

export type RouteEventSource =
  | "fsm_route"
  | "tool"
  | "check_plan"
  | "blackboard";

export type ResolvedRouteEvent = {
  event: string;
  source: RouteEventSource;
};

/** Canonical RouteTo binding row. */
export type RouteBinding = { event: string; to: string };

/**
 * Normalize routes params to binding rows (supports legacy Record map).
 */
export function normalizeRouteBindings(raw: unknown): RouteBinding[] {
  if (Array.isArray(raw)) {
    const rows: RouteBinding[] = [];
    for (const item of raw) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const event =
        typeof (item as { event?: unknown }).event === "string"
          ? (item as { event: string }).event.trim()
          : "";
      const to =
        typeof (item as { to?: unknown }).to === "string"
          ? (item as { to: string }).to.trim()
          : typeof (item as { pin?: unknown }).pin === "string"
            ? (item as { pin: string }).pin.trim()
            : "";
      if (!event || !to) continue;
      rows.push({ event, to });
    }
    return rows;
  }
  if (raw && typeof raw === "object") {
    const rows: RouteBinding[] = [];
    for (const [event, to] of Object.entries(raw as Record<string, unknown>)) {
      const e = event.trim();
      if (!e || typeof to !== "string" || !to.trim()) continue;
      rows.push({ event: e, to: to.trim() });
    }
    return rows;
  }
  return [];
}

export function routeBindingsToMap(
  bindings: RouteBinding[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of bindings) {
    out[row.event] = row.to;
  }
  return out;
}

type RouteEventActionDescription = {
  type: string;
  params?: Readonly<Record<string, unknown>>;
  children?: readonly RouteEventActionDescription[];
};

/**
 * Collect schema event hints, guide targets, CheckPlan slots and implicit stay/leave.
 * Prepared descriptions include children from the registry's unified contract.
 */
export function collectEmittedRouteEvents(
  actions: readonly RouteEventActionDescription[],
  schemaLookup: (type: string) =>
    | { "x-emitsRouteEvents"?: readonly string[] }
    | undefined,
): string[] {
  const events = new Set<string>([ROUTE_EVENT_STAY, ROUTE_EVENT_LEAVE]);
  const pending = [...actions];
  for (let index = 0; index < pending.length; index += 1) {
    const action = pending[index]!;
    pending.push(...(action.children ?? []));
    const schema = schemaLookup(action.type);
    for (const raw of schema?.["x-emitsRouteEvents"] ?? []) {
      if (typeof raw === "string" && raw.trim()) events.add(raw.trim());
    }
    const params = action.params;
    if (action.type === "NodeActionCheckPlan" && params) {
      for (const key of ["onIncomplete", "onComplete"] as const) {
        const raw = params[key];
        if (typeof raw === "string" && raw.trim()) events.add(raw.trim());
      }
    }
    const guide = params?.routeGuide;
    if (!Array.isArray(guide)) continue;
    for (const row of guide) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      const routeTo = (row as { routeTo?: unknown }).routeTo;
      if (typeof routeTo === "string" && routeTo.trim()) {
        events.add(routeTo.trim());
      }
    }
  }
  return [...events].sort((a, b) => a.localeCompare(b));
}

/**
 * Last-wins flush of this round's tool routeEvent queue.
 */
export function resolveRouteEventFromQueue(
  queue: unknown,
): ResolvedRouteEvent | undefined {
  if (!Array.isArray(queue) || queue.length === 0) return undefined;
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const item = queue[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const event =
      typeof (item as { event?: unknown }).event === "string"
        ? (item as { event: string }).event.trim()
        : "";
    if (!event) continue;
    const rawSource = (item as { source?: unknown }).source;
    const source: RouteEventSource =
      rawSource === "fsm_route" ||
      rawSource === "tool" ||
      rawSource === "check_plan" ||
      rawSource === "blackboard"
        ? rawSource
        : "tool";
    return { event, source };
  }
  return undefined;
}
