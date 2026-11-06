import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";
import {
  EMIT_ROUTE_EVENTS,
  resolveRouteEventFromQueue,
} from "./routeEvents.js";

export const NodeActionEmitRouteEventSchema: FsmParamsSchema = {
  type: "object",
  title: "Emit route event",
  description:
    "Flush this round's tool routeEvent queue onto nodeContext for RouteTo. Does not mutate session.",
  "x-llmDescription": "Flush the routeEvent queue filled by RunTools onto nodeContext.routeEvent so RouteTo on this node can resolve it. No params. Common event names: doc_written, doc_adopted, plan_approved, step_blocked, plan_resume, direct, plan, gather, ready, rewrite.",
  additionalProperties: false,
  properties: {},
  "x-emitsRouteEvents": [...EMIT_ROUTE_EVENTS],
  details: `Flushes nodeContext.routeEventQueue (filled by Run tools from successful ToolExecuteResult.routeEvent patches) last-wins onto routeEvent / routeEventSource for Route to on the same node. Declares common event names via x-emitsRouteEvents for editor dropdowns; open-ended fsm_route.route values and Check plan / Emit route event when may add more.

Clears the queue after flush. Empty queue clears routeEvent. Does not inspect tool names or Session.plan — those belong on tools and Check plan.`,
};

/**
 * Flush tool routeEvent queue onto nodeContext for RouteTo.
 */
export class NodeActionEmitRouteEvent extends NodeActionStubBase {
  readonly type = "NodeActionEmitRouteEvent";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const resolved = resolveRouteEventFromQueue(
      args.nodeContext.routeEventQueue,
    );

    return {
      status: "continue",
      nodeContextPatch: {
        routeEventQueue: undefined,
        ...(resolved
          ? {
              routeEvent: resolved.event,
              routeEventSource: resolved.source,
            }
          : {
              routeEvent: undefined,
              routeEventSource: undefined,
            }),
      },
    };
  }
}
