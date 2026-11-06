import { hasOpenPlanSteps } from "../../../session/plan.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import {
  boolParam,
  NodeActionStubBase,
  stringParam,
} from "./NodeActionStubBase.js";

export const ROUTE_EVENT_SOURCE_CHECK_PLAN = "check_plan" as const;

export const NodeActionCheckPlanSchema: FsmParamsSchema = {
  type: "object",
  title: "Check plan",
  description:
    "Emit a configurable route event from Session.plan open vs complete state (optional; empty slots do not fire).",
  "x-llmDescription": "Emit a plan-state route event: onIncomplete when an active plan still has open steps, onComplete otherwise (empty slot = never fires). onlyWhenNoTools (default true) skips tool rounds. Bind the emitted names in RouteTo routes on this node.",
  details: `After Emit route event. If nodeContext already has a routeEvent this round, skips (tools win). When onlyWhenNoTools (default true), skips if toolsRan this round.

onIncomplete: active plan with pending/in_progress steps → write that event (source check_plan). Empty = no fire.
onComplete: otherwise (no plan / inactive / no open steps) → write that event. Empty = no fire.
Both empty → always no-op. Bind emitted names on Route to.`,
  additionalProperties: false,
  properties: {
    onIncomplete: {
      type: "string",
      title: "On incomplete",
      description:
        "Route event when the active plan still has open steps. Leave empty to skip this branch.",
      "x-ui": "text",
    },
    onComplete: {
      type: "string",
      title: "On complete",
      description:
        "Route event when there is no incomplete active plan. Leave empty to skip this branch.",
      "x-ui": "text",
    },
    onlyWhenNoTools: {
      type: "boolean",
      default: true,
      title: "Only when no tools",
      description:
        "When true (default), only runs on bare-reply rounds (toolsRan is not true).",
      "x-ui": "toggle",
    },
  },
};

/**
 * Session.plan open/complete → optional named routeEvent for RouteTo.
 */
export class NodeActionCheckPlan extends NodeActionStubBase {
  readonly type = "NodeActionCheckPlan";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const onIncomplete = (stringParam(this.params, "onIncomplete", "") ?? "").trim();
    const onComplete = (stringParam(this.params, "onComplete", "") ?? "").trim();
    if (!onIncomplete && !onComplete) {
      return { status: "continue" };
    }

    const onlyWhenNoTools = boolParam(this.params, "onlyWhenNoTools", true);
    if (onlyWhenNoTools && args.nodeContext.toolsRan === true) {
      return { status: "continue" };
    }

    const existing = args.nodeContext.routeEvent;
    if (typeof existing === "string" && existing.trim()) {
      return { status: "continue" };
    }

    const incomplete = hasOpenPlanSteps(args.host?.session.plan ?? null);
    const event = incomplete ? onIncomplete : onComplete;
    if (!event) {
      return { status: "continue" };
    }

    return {
      status: "continue",
      nodeContextPatch: {
        routeEvent: event,
        routeEventSource: ROUTE_EVENT_SOURCE_CHECK_PLAN,
      },
    };
  }
}
