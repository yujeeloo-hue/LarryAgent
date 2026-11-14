import { agentLogInfo } from "../../../logging/agentLog.js";
import { isShellToolName } from "../../../tools/shellToolName.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { asToolCalls } from "./hostBridge.js";
import {
  asToolReceipts,
  checkEdgGuard,
  EDG_REUSE_EVENT,
  EDG_THEN_PARAM,
  parseEdgThen,
  readEdgBank,
  readEdgDispatched,
  readEdgPlanOffered,
  type EdgBank,
} from "./edgBank.js";
import { NodeActionStubBase, numberParam } from "./NodeActionStubBase.js";

export const NodeActionEdgAdmitSchema: FsmParamsSchema = {
  type: "object",
  title: "Edg admit",
  description:
    "Decide whether the next pre-committed shell command may run without a model round: build the bank from the shell call's `then`, check the structured receipt, emit edg_reuse.",
  "x-emitsRouteEvents": [EDG_REUSE_EVENT],
  "x-llmDescription": "Mount after RunTools (shellReceipt=structured) and EmitRouteEvent, before RouteTo, on the model node and on the reuse node. Emits route event edg_reuse when the next banked command is eligible; bind it in RouteTo to the reuse node. params: exitCode (guard, default 0).",
  details: `Model round (no nodeContext.edgDispatched): any earlier bank is dropped. When Edg plan schema offered \`then\` on this visit and the round had exactly one tool call — the shell tool with a non-empty \`then\` — a new turnContext.edgBank { rootCallId, toolName, commands, next } is stored (agentLog edg.bank).

Reuse round (Edg dispatch ran): writes the substitution certificate (agentLog edg.substitution: root call, call id, index, command, returnCode, exitCode).

Then the guard runs on the receipt of the call just executed (nodeContext.toolReceipts from RunTools): structured receipt present, not timed out, exitCode == params.exitCode. Pass + commands left + no route event already set + no pending steer → nodeContext.routeEvent = edg_reuse. Anything else clears the bank (agentLog edg.stop with the reason) and leaves routing to RouteTo's normal stay / leave fallback — the model sees every result on its next round.`,
  additionalProperties: false,
  properties: {
    exitCode: {
      type: "integer",
      default: 0,
      title: "Required exit code",
      description: "Each command continues the chain only when the previous one exited with this code.",
      "x-ui": "number",
    },
  },
};

export class NodeActionEdgAdmit extends NodeActionStubBase {
  readonly type = "NodeActionEdgAdmit";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const { nodeContext, turnContext } = args;
    const sessionId = args.host?.session.id;
    const receipts = asToolReceipts(nodeContext.toolReceipts);
    const dispatched = readEdgDispatched(nodeContext);
    const clear: NodeActionExecResult = {
      status: "continue",
      turnContextPatch: { edgBank: null },
    };

    let bank: EdgBank | null;
    let checkCallId: string;
    if (dispatched) {
      bank = readEdgBank(turnContext);
      const executed = receipts.find((r) => r.toolCallId === dispatched.callId);
      agentLogInfo("edg.substitution", {
        sessionId,
        rootCallId: bank?.rootCallId ?? null,
        callId: dispatched.callId,
        index: dispatched.index,
        command: dispatched.command,
        executed: executed !== undefined,
        returnCode: executed?.returnCode ?? null,
        exitCode: executed?.receipt?.exitCode ?? null,
      });
      if (!bank) return clear;
      checkCallId = dispatched.callId;
    } else {
      const offered = readEdgPlanOffered(nodeContext);
      const calls = asToolCalls(nodeContext.toolCalls);
      const root = calls.length === 1 ? calls[0]! : undefined;
      if (!offered || !root || !isShellToolName(root.name)) {
        return readEdgBank(turnContext) ? clear : { status: "continue" };
      }
      const commands = parseEdgThen(root.arguments?.[EDG_THEN_PARAM], offered.maxSteps);
      if (commands.length === 0) {
        return readEdgBank(turnContext) ? clear : { status: "continue" };
      }
      bank = { rootCallId: root.id, toolName: root.name, commands, next: 0 };
      agentLogInfo("edg.bank", {
        sessionId,
        rootCallId: root.id,
        commandCount: commands.length,
      });
      checkCallId = root.id;
    }

    const stop = (reason: string): NodeActionExecResult => {
      agentLogInfo("edg.stop", {
        sessionId,
        rootCallId: bank!.rootCallId,
        reason,
        dispatched: bank!.next,
        remaining: bank!.commands.length - bank!.next,
      });
      return clear;
    };

    const guard = checkEdgGuard(
      receipts.find((r) => r.toolCallId === checkCallId),
      Math.trunc(numberParam(this.params, "exitCode", 0)),
    );
    if (!guard.pass) return stop(guard.reason);
    if (bank.next >= bank.commands.length) return stop("exhausted");
    if (typeof nodeContext.routeEvent === "string" && nodeContext.routeEvent) {
      return stop("route_event_set");
    }
    if (args.host?.hasPendingSteer()) return stop("steer_pending");

    return {
      status: "continue",
      turnContextPatch: { edgBank: bank },
      nodeContextPatch: { routeEvent: EDG_REUSE_EVENT, routeEventSource: "edg" },
    };
  }
}
