import type { OpenAiChatMessage, OpenAiToolDefinition } from "../../../llm/types.js";
import { createRoleLlmBinding } from "../../roles/llmBinding.js";
import type { RoleLlmBinding } from "../../roles/types.js";
import { filterModelTools } from "../../policy/filterModelTools.js";
import { asToolNameList } from "../../policy/toolNameLists.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import { haltFromTurnResult } from "../FsmHostCapabilities.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { scopeOf } from "./hostBridge.js";
import {
  boolParam,
  NodeActionStubBase,
  stringParam,
  stringParamPrefer,
} from "./NodeActionStubBase.js";

export const NodeActionCallModelSchema: FsmParamsSchema = {
  type: "object",
  title: "Call model",
  description:
    "Run one streaming LLM round on the prepared messages and tools. Leave params empty to use defaults / earlier Prepare role status text.",
  "x-llmDescription": "Run one streaming model round on the window from BuildModelWindow (halts 'Missing model window' otherwise). params: waitingMessage, disableReasoning. Writes assistant text, toolCalls and round counters to nodeContext.",
  details: `One streaming LLM round. Requires nodeContext.messages + tools from Build model window — missing window halts with 'Missing model window'. Uses nodeContext.activeLlm from explicit Prepare role settings, otherwise the session default; role identity never selects a model. Rebuilds the binding with reasoning off when disableReasoning is set.

Filters the current tool candidates against nodeContext.allowTools and disabledTools immediately before host.streamModelRound({llm, messages, tools, progressText}). This check always runs, including when Disable tools has legacy hardFilter=false or when the policy changed after Build model window. The candidates are not mutated. Progress text falls back waitingMessage > Prepare role's progressLabel > 'Waiting for model…'. Success writes the round payload to nodeContext (assistant, toolCalls, textPart, reasoningBuf, roundBillableTokens, hasPendingToolCalls, lastToolNames) and mirrors it into the turn-level lastAssistantRound slot — this action is its sole writer; the end node's Fill empty assistant is the sole reader. Cancelled / error rounds halt via haltFromTurnResult. Interrupted rounds (user-prompt interrupt) write roundInterrupted and continue — RouteTo's stay fallback keeps the round on this node so the round gate drains the queued prompt.`,
  // Legacy graphs may still store `purpose`; it is not used by the stream call.
  additionalProperties: true,
  properties: {
    waitingMessage: {
      type: "string",
      title: "Waiting message",
      description:
        "Progress text shown while the model responds. Empty → use Prepare role’s status, else “Waiting for model…”.",
      "x-ui": "text",
    },
    disableReasoning: {
      type: "boolean",
      default: false,
      title: "Turn off reasoning",
      description:
        "Disable chain-of-thought for this round. Ask mode turns this on automatically even if left off.",
      "x-ui": "toggle",
    },
  },
};

/** Rebuild binding so stream/complete close over disableReasoning. */
function withDisableReasoning(llm: RoleLlmBinding): RoleLlmBinding {
  if (llm.client.disableReasoning === true) return llm;
  return createRoleLlmBinding({
    providerId: llm.providerId,
    client: {
      ...llm.client,
      disableReasoning: true,
    },
    stream: llm.stream,
  });
}

/** Call model — one streaming LLM round. */
export class NodeActionCallModel extends NodeActionStubBase {
  readonly type = "NodeActionCallModel";

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const progressText =
      stringParamPrefer(this.params, "waitingMessage", "progressLabel") ||
      (typeof args.nodeContext.progressLabel === "string" && args.nodeContext.progressLabel
        ? args.nodeContext.progressLabel
        : "Waiting for model…");
    const host = args.host;
    if (!host) {
      const forceTools = args.turnContext.stubForceToolCalls === true;
      const rounds =
        typeof args.turnContext.stubModelRounds === "number"
          ? args.turnContext.stubModelRounds
          : 0;
      const hasPendingToolCalls = forceTools && rounds === 0;
      return {
        status: "continue",
        turnContextPatch: {
          stubModelRounds: rounds + 1,
        },
        nodeContextPatch: {
          streamSkipped: false,
          purpose: stringParam(this.params, "purpose", "chat"),
          progressLabel: progressText,
          hasPendingToolCalls,
          toolsRan: hasPendingToolCalls,
          assistantStub: true,
        },
      };
    }

    const messages = args.nodeContext.messages as OpenAiChatMessage[] | undefined;
    const candidates = args.nodeContext.tools as OpenAiToolDefinition[] | undefined;
    if (!messages || !candidates) {
      const result = await host.finish(
        "error",
        "Missing model window",
        "error",
      );
      return haltFromTurnResult(result, "Missing model window");
    }

    // Always enforce the current policy at the request boundary. Earlier
    // Actions may refresh tools or change denials after the window was built.
    const tools = filterModelTools(candidates, {
      allowTools: asToolNameList(args.nodeContext.allowTools),
      denyTools: asToolNameList(args.nodeContext.disabledTools),
    });

    const override = args.nodeContext.activeLlm as RoleLlmBinding | undefined;
    let llm =
      override ?? scopeOf(args.turnContext).llmBundle.sessionDefault;
    const disableReasoning = boolParam(this.params, "disableReasoning", false);
    if (disableReasoning) {
      llm = withDisableReasoning(llm);
    }
    const toolPolicy = {
      allowTools: asToolNameList(args.nodeContext.allowTools),
      denyTools: asToolNameList(args.nodeContext.disabledTools),
    };
    const hostedTools = filterModelTools(
      llm.hostedTools(),
      toolPolicy,
    );
    const builtScope = typeof args.nodeContext.modelWindowReasoningScope === "string"
      ? args.nodeContext.modelWindowReasoningScope
      : undefined;
    const round = await host.streamModelRound({
      llm,
      messages,
      tools,
      ...(hostedTools.length ? { hostedTools } : {}),
      ...(builtScope ? { builtScope } : {}),
      progressText,
    });

    if (round.kind === "interrupted") {
      // Non-terminal: the user interrupted the stream. Sealed tool calls
      // (if any) carry Cancelled results; roundInterrupted keeps RouteTo on
      // this node (stay fallback) so the round gate drains the queued
      // prompt before the next model call continues the same turn.
      return {
        status: "continue",
        turnContextPatch: {
          lastAssistantRound: {
            assistant: round.assistant,
            textPart: null,
            reasoningBuf: round.reasoningBuf,
            toolNames: [],
          },
        },
        nodeContextPatch: {
          streamSkipped: false,
          purpose: stringParam(this.params, "purpose", "chat"),
          progressLabel: "Interrupted",
          hasPendingToolCalls: false,
          toolsRan: false,
          roundInterrupted: true,
          lastToolNames: [],
          assistant: round.assistant,
          toolCalls: [],
          reasoningBuf: round.reasoningBuf,
          roundBillableTokens: round.roundBillableTokens,
        },
      };
    }

    if (round.kind === "cancelled" || round.kind === "error") {
      return haltFromTurnResult(
        round.result,
        round.kind === "cancelled" ? "Cancelled" : "Model error",
      );
    }

    const hasPendingToolCalls = round.toolCalls.length > 0;
    return {
      status: "continue",
      turnContextPatch: {
        // Typed turn-level slot: sole writer (Stream), sole reader (end
        // node Finalize). Overwritten per round — no stale risk.
        lastAssistantRound: {
          assistant: round.assistant,
          textPart: round.textPart ?? null,
          reasoningBuf: round.reasoningBuf,
          toolNames: round.toolCalls.map((c) => c.name),
        },
      },
      nodeContextPatch: {
        streamSkipped: false,
        purpose: stringParam(this.params, "purpose", "chat"),
        progressLabel: progressText,
        hasPendingToolCalls,
        toolsRan: hasPendingToolCalls,
        lastToolNames: round.toolCalls.map((c) => c.name),
        assistant: round.assistant,
        toolCalls: round.toolCalls,
        reasoningBuf: round.reasoningBuf,
        ...(round.textPart ? { textPart: round.textPart } : {}),
        roundBillableTokens: round.roundBillableTokens,
      },
    };
  }
}
