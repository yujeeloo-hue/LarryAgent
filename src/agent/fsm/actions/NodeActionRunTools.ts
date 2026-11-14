import type { AssistantMessage, ToolCallPart } from "../../../session/types.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import { haltFromTurnResult } from "../FsmHostCapabilities.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { asToolCalls } from "./hostBridge.js";
import { asToolNameList } from "../../policy/toolNameLists.js";
import { boolParam, NodeActionStubBase, stringParam } from "./NodeActionStubBase.js";

export const NodeActionRunToolsSchema: FsmParamsSchema = {
  type: "object",
  title: "Run tools",
  description:
    "Execute pending tool_calls from the last model round (or skip when there are none). Honors Disable tools denials and Prepare tools allowTools (via nodeContext) at run time.",
  "x-llmDescription": "Execute the pending tool_calls of the last model round (skips cleanly when there are none; skipIfNoToolCalls default true). Applies plan/doc session patches inline and enqueues routeEvent patches for EmitRouteEvent. Mount after CallModel.",
  details: `Executes the round's pending tool_calls via host.runToolsPhase (assistant message + tool call parts). With skipIfNoToolCalls (default) and no pending calls it continues without touching the Host.

Model requests already exclude disabled tools. Local execution checks the policy again: Disable tools' deny list and Prepare tools' allowTools ride in via nodeContext, so calls inferred from history still receive a denial result. The tool context also receives requirePlanDocForCreatePlan and plan / planDoc snapshots. Session patches from plan tools are applied inline in runTools via host.applySessionPatch. Successful tools may also enqueue routeEvent patches onto nodeContext.routeEventQueue for Emit route event. turnContext.toolFailureCount is accumulated (the only tools signal that outlives a round); nodeContext gets toolsRan=true and the cleared pending flag, plus toolReceipts (executed calls with returnCode and, when shellReceipt=structured, the shell tool's structured receipt). Cancelled turns halt.`,
  additionalProperties: false,
  properties: {
    skipIfNoToolCalls: {
      type: "boolean",
      default: true,
      title: "Skip if no tool calls",
      description: "When true and the model returned no tools, continue without calling the Host.",
      "x-ui": "toggle",
    },
    shellReceipt: {
      type: "string",
      enum: ["off", "structured"],
      default: "off",
      title: "Shell receipt",
      description:
        "structured: the shell tool also returns exitCode / stdout / stderr / timedOut as a model-invisible receipt (nodeContext.toolReceipts) for deterministic checks such as Edg admit. Set here, never by the model.",
      "x-ui": "select",
    },
  },
};

export class NodeActionRunTools extends NodeActionStubBase {
  readonly type = "NodeActionRunTools";

  async Exec(args: NodeActionExecArgs): Promise<NodeActionExecResult> {
    const skipIfNone = boolParam(this.params, "skipIfNoToolCalls", true);
    const pending = args.nodeContext.hasPendingToolCalls === true;

    const host = args.host;
    if (!host) {
      if (skipIfNone && !pending) {
        return {
          status: "continue",
          nodeContextPatch: {
            toolsSkipped: true,
            hasPendingToolCalls: false,
          },
        };
      }
      return {
        status: "continue",
        turnContextPatch: { stubForceToolCalls: false },
        nodeContextPatch: {
          toolsSkipped: false,
          hasPendingToolCalls: false,
          toolsRan: true,
        },
      };
    }

    const toolCalls = asToolCalls(args.nodeContext.toolCalls);
    if (skipIfNone && toolCalls.length === 0) {
      return {
        status: "continue",
        nodeContextPatch: {
          toolsSkipped: true,
          hasPendingToolCalls: false,
        },
      };
    }

    const assistant = args.nodeContext.assistant as AssistantMessage | undefined;
    if (!assistant || toolCalls.length === 0) {
      const result = await host.finish(
        "error",
        "Missing tool calls",
        "error",
      );
      return haltFromTurnResult(result, "Missing tool calls");
    }

    // Keep local enforcement even though requests exclude forbidden tools:
    // the model may infer a call from earlier conversation history.
    const disabledToolsRaw = args.nodeContext.disabledTools;
    const disabledTools = Array.isArray(disabledToolsRaw)
      ? disabledToolsRaw.filter(
          (n): n is string => typeof n === "string" && n.length > 0,
        )
      : [];
    const allowTools = asToolNameList(args.nodeContext.allowTools);

    const extra: Record<string, unknown> = {};
    extra.planExecutionRequested = args.turnContext.planExecutionRequested === true;
    if (args.turnContext.requirePlanDocForCreatePlan === true) {
      extra.requirePlanDocForCreatePlan = true;
    }
    if (args.turnContext.requirePlanDocApprovalForCreatePlan === true) extra.requirePlanDocApprovalForCreatePlan = true;
    extra.planSnapshot = host.session.plan ?? null;
    extra.planDocSnapshot = host.session.planDoc ?? null;
    const boundRouteEvents = Array.isArray(args.nodeContext.boundRouteEvents)
      ? args.nodeContext.boundRouteEvents.filter(
          (n): n is string => typeof n === "string" && n.length > 0,
        )
      : [];
    if (boundRouteEvents.length > 0) {
      extra.boundRouteEvents = boundRouteEvents;
    }
    if (stringParam(this.params, "shellReceipt", "off") === "structured") {
      extra.shellStructuredReceipt = true;
    }
    if (args.nodeContext.skillActor === "reflector") extra.skillActor = "reflector";
    if (args.nodeContext.skillWritePolicy === "auto_owned_only") {
      extra.skillWritePolicy = "auto_owned_only";
    }

    const toolsResult = await host.runToolsPhase(
      assistant,
      toolCalls as ToolCallPart[],
      {
        ...(disabledTools.length > 0 ? { disabledTools } : {}),
        ...(allowTools.length > 0 ? { allowedTools: allowTools } : {}),
        extra,
      },
    );
    if (toolsResult.kind === "cancelled" || toolsResult.kind === "error") {
      return haltFromTurnResult(toolsResult.result,
        toolsResult.kind === "cancelled" ? "Cancelled" : "Tool execution stopped");
    }

    const lastToolNames = toolCalls.map((c) => c.name);

    return {
      status: "continue",
      turnContextPatch: {
        // Turn-level accumulator — the only tools signal that outlives a round.
        toolFailureCount:
          typeof args.turnContext.toolFailureCount === "number"
            ? (args.turnContext.toolFailureCount as number) +
              toolsResult.toolFailureCount
            : toolsResult.toolFailureCount,
      },
      nodeContextPatch: {
        toolsSkipped: false,
        hasPendingToolCalls: false,
        toolsRan: true,
        assistant,
        toolCalls,
        lastToolNames,
        routeEventQueue: toolsResult.routeEvents ?? [],
        toolReceipts: toolsResult.receipts ?? [],
      },
    };
  }
}
