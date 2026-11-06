import { parseFsmRouteArgs } from "../../session/fsmRoute.js";
import { approvePlanDoc, planDocRevision, withPlanDocApprovalPending } from "../../session/planDoc.js";
import { readFile } from "node:fs/promises";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";
import { agentLogInfo } from "../../logging/agentLog.js";

export { parseFsmRouteArgs };

/** Permission 0 — emits a structured control signal consumed by the FSM. */
export const fsmRouteDefinition: ToolDefinition = {
  name: "fsm_route",
  description:
    "Choose the next FSM route with a structured control signal. Use a route name allowed by the active phase instructions.",
  parameters: {
    type: "object",
    properties: {
      route: {
        type: "string",
        description: "Route name allowed by the active FSM phase.",
      },
      reason: {
        type: "string",
        description: "Short reason for the routing decision.",
      },
    },
    required: ["route"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 0,
};

export const fsmRouteHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const parsed = parseFsmRouteArgs(args);
  if (!parsed.ok) {
    return failureResult(parsed.message, ToolReturnCode.InvalidArguments);
  }

  const bound = context.boundRouteEvents ?? [];
  if (parsed.route === "plan_approved") {
    return failureResult("Approval is emitted by ready after a recorded human execution request; it cannot be selected manually.", ToolReturnCode.InvalidArguments);
  }
  if (bound.length > 0 && !bound.includes(parsed.route)) {
    return failureResult(
      `Route "${parsed.route}" is not available here. ` +
        `Available routes: ${bound.join(", ")}.`,
      ToolReturnCode.InvalidArguments,
    );
  }

  agentLogInfo("fsm.route", {
    sessionId: context.sessionId,
    route: parsed.route,
    reason: parsed.reason,
    via: "tool",
  });

  const base = textResult(
    `FSM route: ${parsed.route}. ${parsed.reason}`,
    ToolReturnCode.Success,
  );

  const withRoute = {
    ...base,
    routeEvent: { event: parsed.route, source: "fsm_route" as const },
  };

  if (parsed.route === "ready") {
    const doc = context.planDocSnapshot;
    if (doc?.revision) {
      try {
        const revision = planDocRevision(await readFile(doc.path, "utf8"));
        if (revision !== doc.revision) {
          return {
            ...textResult("The document changed during review. Read and review the current version before marking it ready.", ToolReturnCode.Success),
            sessionPatch: { planDoc: { path: doc.path, summary: doc.summary, updatedAt: Date.now(), revision } },
            routeEvent: { event: "stay", source: "tool" },
          };
        }
        const reviewed = { ...doc, reviewedRevision: revision };
        if (doc.executionRequestedRevision === revision && bound.includes("plan_approved")) {
          agentLogInfo("fsm.plan_approval", { sessionId: context.sessionId, revision, via: "execution_request" });
          return {
            ...base,
            sessionPatch: { planDoc: approvePlanDoc(reviewed) },
            routeEvent: { event: "plan_approved", source: "tool" },
          };
        }
        return { ...withRoute, sessionPatch: { planDoc: withPlanDocApprovalPending(reviewed, true) } };
      } catch {
        return failureResult(`Could not read plan document: ${doc.path}`, ToolReturnCode.NotFound);
      }
    }
    const next = withPlanDocApprovalPending(context.planDocSnapshot, true);
    if (next) {
      return { ...withRoute, sessionPatch: { planDoc: next } };
    }
    return withRoute;
  }
  if (parsed.route === "rewrite") {
    const next = withPlanDocApprovalPending(context.planDocSnapshot, false);
    if (next) {
      return { ...withRoute, sessionPatch: { planDoc: next } };
    }
    return withRoute;
  }
  return withRoute;
};
