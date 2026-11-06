import type { FsmParamsSchema } from "../paramsSchema.js";
import { haltFromTurnResult } from "../FsmHostCapabilities.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { PLAN_APPROVE_PROMPT } from "../../planControl.js";
import type { RoleKind } from "../../roles/types.js";
import type { TurnScope } from "../turnScope.js";
import { scopeOf } from "./hostBridge.js";
import { NodeActionStubBase } from "./NodeActionStubBase.js";

export const NodeActionStartTurnSchema: FsmParamsSchema = {
  type: "object",
  title: "Start turn",
  description:
    "Begin the Host turn (hooks, user message). Routing and phase resume belong on Compare + RouteTo on this node.",
  "x-llmDescription": "Open the Host turn (submit the user message / approved prompt) exactly once on the entry node. No params. Do entry routing afterwards with Compare + RouteTo (when[] + defaultPin), never here.",
  details: `Runs on the entry node after Apply control intent (when mounted). Calls host.startTurn to submit the user message (or turnContext.approvedUserText from Apply control intent / the built-in Approve prompt when controlResult=approved), then records turnStarted / turnStartedAtMs / turnStartMessageIndex.

Discarded / rejected control intents short-circuit with turnStarted=false (no Host start). Does not seed routeTarget — Compare + RouteTo when-table (and default pin) handle entry routing. activeRole falls back to nodeContext.activeRole or agent/subagent for turn scope only.`,
  additionalProperties: false,
  properties: {},
};

function asRoleKind(value: unknown): RoleKind | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

export class NodeActionStartTurn extends NodeActionStubBase {
  readonly type = "NodeActionStartTurn";

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const host = args.host;
    const controlResult = args.turnContext.controlResult;

    if (controlResult === "discarded" || controlResult === "rejected") {
      return {
        status: "continue",
        turnContextPatch: { turnStarted: false },
      };
    }

    if (!host) {
      const activeRole =
        asRoleKind(args.nodeContext.activeRole) ??
        (asRoleKind(
          (args.turnContext.turnScope as TurnScope | undefined)?.turnState
            ?.activeRole,
        ) === "subagent"
          ? "subagent"
          : "agent");
      return {
        status: "continue",
        turnContextPatch: {
          turnStarted: true,
          turnStartedAtMs: Date.now(),
        },
        nodeContextPatch: { activeRole },
      };
    }

    const turnInput = args.turnInput;
    if (!turnInput) {
      return {
        status: "halt",
        errorMessage: "StartTurn requires turnInput when host is set",
      };
    }

    const approved = controlResult === "approved";
    const fromContext =
      typeof args.turnContext.approvedUserText === "string"
        ? args.turnContext.approvedUserText.trim()
        : "";
    const approvedUserText = fromContext || PLAN_APPROVE_PROMPT;
    const turnStartMessageIndex = host.session.messages.length;
    const started = await host.startTurn({
      userText: approved ? approvedUserText : turnInput.userText,
      ...(turnInput.attachments && !approved
        ? { attachments: turnInput.attachments }
        : {}),
      ...(approved
        ? {}
        : turnInput.suppressUserMessage
          ? { suppressUserMessage: true }
          : {}),
      ...(turnInput.resumeToolBatch
        ? { resumeToolBatch: turnInput.resumeToolBatch }
        : {}),
      ...(turnInput.continuation && !approved
        ? { continuation: turnInput.continuation }
        : {}),
      ...(turnInput.parentSessionId
        ? { parentSessionId: turnInput.parentSessionId }
        : {}),
      ...(turnInput.subagentId ? { subagentId: turnInput.subagentId } : {}),
    });
    if (started !== "ok") {
      return haltFromTurnResult(started);
    }

    const activeRole =
      asRoleKind(args.nodeContext.activeRole) ??
      (host.isSubagentTurn ? "subagent" : "agent");
    const scope = scopeOf(args.turnContext);
    scope.turnState.activeRole = activeRole;

    return {
      status: "continue",
      turnContextPatch: {
        turnStarted: true,
        turnStartedAtMs: Date.now(),
        turnStartMessageIndex,
      },
      nodeContextPatch: { activeRole },
    };
  }
}
