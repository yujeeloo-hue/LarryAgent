import { agentLogInfo } from "../../../logging/agentLog.js";
import type { ToolCallPart } from "../../../session/types.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { readEdgBank, type EdgDispatched } from "./edgBank.js";
import { NodeActionStubBase, stringParam } from "./NodeActionStubBase.js";

export const NodeActionEdgDispatchSchema: FsmParamsSchema = {
  type: "object",
  title: "Edg dispatch",
  description:
    "Replay the next pre-committed shell command from the Edg bank as a synthetic tool call (no model round). Mount before RunTools on the reuse node.",
  "x-llmDescription": "Reuse-node entry after RoundGate (drainSteer=false). Takes the next command from turnContext.edgBank, appends it as a synthetic assistant tool call via the Host and hands it to RunTools. Pending steer or empty bank → no call (RouteTo falls back to the model node). params: waitingMessage.",
  details: `Reads turnContext.edgBank (written by Edg admit). With a pending steer the bank is dropped and nothing is dispatched, so the model node's Round gate drains the steer next — mount this node's Round gate with drainSteer=false. Otherwise builds one tool_call { command } for the bank's shell tool, appends it through host.appendSyntheticToolRound (assistant message + tool_call stream event, no model request, no model-iteration charge), advances bank.next and writes nodeContext assistant / toolCalls / hasPendingToolCalls plus edgDispatched { callId, index, command } for Edg admit's certificate. Execution goes through the normal RunTools path, so hooks, permission levels and shell risk assessment apply unchanged.`,
  additionalProperties: false,
  properties: {
    waitingMessage: {
      type: "string",
      title: "Waiting message",
      description: "Progress text while the reused command runs. Empty → “Running planned command…”.",
      "x-ui": "text",
    },
  },
};

export class NodeActionEdgDispatch extends NodeActionStubBase {
  readonly type = "NodeActionEdgDispatch";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const { host, turnContext } = args;
    const bank = readEdgBank(turnContext);
    const clear: NodeActionExecResult = {
      status: "continue",
      turnContextPatch: { edgBank: null },
    };
    if (!bank || bank.next >= bank.commands.length) return clear;
    if (host?.hasPendingSteer()) {
      agentLogInfo("edg.stop", {
        sessionId: host.session.id,
        rootCallId: bank.rootCallId,
        reason: "steer_pending",
        dispatched: bank.next,
        remaining: bank.commands.length - bank.next,
      });
      return clear;
    }
    if (host && !host.appendSyntheticToolRound) return clear;

    const index = bank.next;
    const command = bank.commands[index]!;
    const callArgs = { command };
    const call: ToolCallPart = {
      type: "tool_call",
      id: host ? host.createId() : `edg-${bank.rootCallId}-${index}`,
      name: bank.toolName,
      status: "pending",
      arguments: callArgs,
      argumentsRaw: JSON.stringify(callArgs),
    };
    const dispatched: EdgDispatched = { callId: call.id, index, command };
    const progressText =
      stringParam(this.params, "waitingMessage") || "Running planned command…";
    const assistant = host?.appendSyntheticToolRound?.({
      toolCalls: [call],
      progressText,
    });
    return {
      status: "continue",
      turnContextPatch: { edgBank: { ...bank, next: index + 1 } },
      nodeContextPatch: {
        ...(assistant ? { assistant } : {}),
        toolCalls: [call],
        hasPendingToolCalls: true,
        lastToolNames: [call.name],
        progressLabel: progressText,
        edgDispatched: dispatched,
      },
    };
  }
}
