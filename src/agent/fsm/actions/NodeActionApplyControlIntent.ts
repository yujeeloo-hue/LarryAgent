import type { SessionPatch } from "../../contracts/index.js";
import {
  canStartApproveTurn,
  canStartDiscardTurn,
  PLAN_APPROVE_PROMPT,
} from "../../planControl.js";
import { approvePlanDoc, planDocRevision } from "../../../session/planDoc.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import { pinSelectProperty, resolvePinSlot } from "../pinRouting.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import {
  boolParam,
  NodeActionStubBase,
  stringParam,
} from "./NodeActionStubBase.js";

export const NodeActionApplyControlIntentSchema: FsmParamsSchema = {
  type: "object",
  title: "Apply control intent",
  description:
    "Consume Approve / Discard from the UI: gate the intent, then write routeTarget to the matching pin.",
  "x-llmDescription": "Entry-node consumer of UI Approve / Discard: gates the intent and routes to onApproved / onDiscarded / onRejected (all required pin names). Optional approveRequirePhase, approveRequirePlanDoc (default true), approveRequireReviewedRevision, approveSetPhase, approvedUserText. No pending intent -> controlResult 'none', round continues unchanged.",
  additionalProperties: false,
  required: ["onDiscarded", "onRejected", "onApproved"],
  details: `Consumes turnInput.controlIntent (approve / discard) and writes routeTarget to the configured pin — edges must branch on routeTarget, not controlResult (which stays on turnContext for diagnostics and StartTurn's early exit).

Approve is gated by canStartApproveTurn (approveRequirePhase, approveRequirePlanDoc, and the plan doc file must exist), then clears approvalPending, optionally writes approveSetPhase onto Session.phase, stores approvedUserText on turnContext for Start turn, and routes onApproved. Discard requires canStartDiscardTurn, deletes the plan doc file via host.deletePlanDoc (best-effort), clears plan / planDoc / phase, and routes onDiscarded. Gate failures emit the error plus a plan_approval event and route onRejected. No intent present: controlResult='none', continue unchanged.`,
  properties: {
    onDiscarded: pinSelectProperty(
      "Discarded pin",
      "When discard succeeds (typically wired toward End).",
    ),
    onRejected: pinSelectProperty(
      "Rejected pin",
      "When approve/discard gate fails (typically wired toward End).",
    ),
    onApproved: pinSelectProperty(
      "Approved pin",
      "When approve succeeds (built-in: planner). Destination Set phase / Apply plan effects run on that node.",
    ),
    approveRequirePhase: {
      type: "string",
      minLength: 1,
      title: "Approve require phase",
      description:
        "When set, Approve fails unless session blackboard phase equals this value (e.g. review). Omit to skip the phase check.",
      "x-ui": "text",
    },
    approveRequirePlanDoc: {
      type: "boolean",
      default: true,
      title: "Approve require plan doc",
      description:
        "When true (default), Approve requires a plan document path on the session.",
      "x-ui": "toggle",
    },
    approveRequireReviewedRevision: {
      type: "boolean", default: false,
      description: "Require a recorded review of the current document revision before UI approval.",
    },
    approveSetPhase: {
      type: "string",
      minLength: 1,
      title: "Approve set phase",
      description:
        "When set, write this opaque phase onto the session blackboard on successful Approve (e.g. planning) so Compare + RouteTo when-table can re-enter the approved pin if the turn is interrupted before the destination node runs.",
      "x-ui": "text",
    },
    approvedUserText: {
      type: "string",
      minLength: 1,
      title: "Approved user text",
      description:
        "User message Start turn submits when Approve succeeds. Omit to use the built-in Approve prompt.",
      "x-ui": "textarea",
    },
  },
};

/**
 * Consume turnInput.controlIntent and write `routeTarget` = configured pin.
 * Still records controlResult on turnContext for diagnostics / StartTurn
 * early-exit; **edges must use routeTarget**, not controlResult.
 */
export class NodeActionApplyControlIntent extends NodeActionStubBase {
  readonly type = "NodeActionApplyControlIntent";

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const label = this.type;
    const intent =
      stringParam(
        (args.turnInput ?? {}) as unknown as Record<string, unknown>,
        "controlIntent",
      ) ??
      (typeof args.turnContext.controlIntent === "string"
        ? args.turnContext.controlIntent
        : undefined);

    if (intent !== "approve" && intent !== "discard") {
      return {
        status: "continue",
        turnContextPatch: { controlResult: "none" },
      };
    }

    const host = args.host;

    if (intent === "discard") {
      const discarded = resolvePinSlot(this.params, "onDiscarded", label);
      if (!discarded.ok) {
        return { status: "halt", errorMessage: discarded.errorMessage };
      }
      if (!host) {
        return {
          status: "continue",
          turnContextPatch: {
            controlIntent: "discard",
            controlResult: "discarded",
          },
          nodeContextPatch: { routeTarget: discarded.pin },
        };
      }
      const gate = canStartDiscardTurn(host.session);
      if (!gate.ok) {
        const rejected = resolvePinSlot(this.params, "onRejected", label);
        if (!rejected.ok) {
          return { status: "halt", errorMessage: rejected.errorMessage };
        }
        host.emitError(gate.error);
        return {
          status: "continue",
          turnContextPatch: {
            controlIntent: "discard",
            controlResult: "rejected",
          },
          nodeContextPatch: { routeTarget: rejected.pin },
        };
      }
      const docPath = host.session.planDoc?.path?.trim();
      if (docPath) {
        host.deletePlanDoc(docPath);
      }
      host.applySessionPatch({
        plan: null,
        planDoc: null,
        phase: null,
      });
      return {
        status: "continue",
        turnContextPatch: {
          controlIntent: "discard",
          controlResult: "discarded",
        },
        nodeContextPatch: { routeTarget: discarded.pin },
      };
    }

    // approve
    const approved = resolvePinSlot(this.params, "onApproved", label);
    if (!approved.ok) {
      return { status: "halt", errorMessage: approved.errorMessage };
    }

    if (!host) {
      const approvedUserText =
        stringParam(this.params, "approvedUserText")?.trim() ||
        PLAN_APPROVE_PROMPT;
      return {
        status: "continue",
        turnContextPatch: {
          controlIntent: "approve",
          controlResult: "approved",
          approvedUserText,
        },
        nodeContextPatch: {
          activeRole: approved.pin,
          routeTarget: approved.pin,
        },
      };
    }

    const gate = canStartApproveTurn(host.session, {
      requirePhase: stringParam(this.params, "approveRequirePhase") ?? null,
      requirePlanDoc: boolParam(this.params, "approveRequirePlanDoc", true),
      requireReviewedRevision: boolParam(this.params, "approveRequireReviewedRevision", false),
    });
    const docPath = host.session.planDoc?.path?.trim();
    const missingFile = Boolean(docPath && !host.planDocExists(docPath));
    const content = docPath && host.readPlanDocContent ? await host.readPlanDocContent(docPath) : undefined;
    const revision = typeof content === "string" ? planDocRevision(content) : host.session.planDoc?.revision;
    const changed = args.turnContext.planDocChanged === true || Boolean(host.session.planDoc?.revision && revision !== host.session.planDoc.revision);
    if (!gate.ok || missingFile || content === null || changed) {
      const rejected = resolvePinSlot(this.params, "onRejected", label);
      if (!rejected.ok) {
        return { status: "halt", errorMessage: rejected.errorMessage };
      }
      const message = !gate.ok
        ? gate.error
        : changed ? "Plan document changed. Review the updated version before approving."
        : `Could not read plan document: ${docPath}`;
      host.emitError(message);
      host.onEvent?.({
        type: "plan_approval",
        pending: true,
        error: message,
      });
      return {
        status: "continue",
        turnContextPatch: {
          controlIntent: "approve",
          controlResult: "rejected",
        },
        nodeContextPatch: { routeTarget: rejected.pin },
      };
    }

    const clearedPending = host.session.planDoc
      ? approvePlanDoc({ ...host.session.planDoc, ...(revision ? { revision } : {}) })
      : null;
    const approveSetPhase = stringParam(this.params, "approveSetPhase")?.trim();
    const sessionPatch: SessionPatch = {};
    if (clearedPending) sessionPatch.planDoc = clearedPending;
    if (approveSetPhase) sessionPatch.phase = approveSetPhase;
    if (Object.keys(sessionPatch).length > 0) {
      host.applySessionPatch(sessionPatch);
    }

    const approvedUserText =
      stringParam(this.params, "approvedUserText")?.trim() ||
      PLAN_APPROVE_PROMPT;

    return {
      status: "continue",
      turnContextPatch: {
        controlIntent: "approve",
        controlResult: "approved",
        approvedUserText,
      },
      nodeContextPatch: {
        activeRole: approved.pin,
        routeTarget: approved.pin,
      },
    };
  }
}
