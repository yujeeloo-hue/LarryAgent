import type { ToolResultPart } from "../../../session/types.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { asToolCalls } from "./hostBridge.js";
import { boolParam, NodeActionStubBase, stringParam } from "./NodeActionStubBase.js";

export const NodeActionWhenToolCallSchema: FsmParamsSchema = {
  type: "object",
  title: "When tool call",
  description:
    "Set a node flag when this round's tool calls match a tool-name / argument / success filter.",
  "x-llmDescription": "Set flagKey=true on nodeContext when this round's tool calls match toolName (required) plus optional argKey / argEquals and requireSuccess (tool_result returnCode 0). Later actions gate on the flag (e.g. SetComposerRunMode whenNodeFlag).",
  details: `Scans this round's tool calls (nodeContext.toolCalls — same container DetectStepClaim reads) and sets flagKey=true on the node context when one matches: same toolName, optional argKey/argEquals strict-equal check on the call's arguments, and — with requireSuccess — the matching tool_result (looked up by toolCallId in the last tool message) returned returnCode 0. No match writes nothing; later Actions gate on the flag (e.g. Set composer run mode's whenNodeFlag).

Mounting: after Run tools on the acting role node (the round container is per-visit, so a flag only reflects the current node's rounds). Without a Host, requireSuccess never matches (results are unverifiable); a name/arg-only filter still matches on the stub path.`,
  additionalProperties: false,
  required: ["toolName", "flagKey"],
  properties: {
    toolName: {
      type: "string",
      minLength: 1,
      title: "Tool name",
      description: "Exact tool-call name to match (e.g. complete_plan).",
      "x-ui": "text",
    },
    argKey: {
      type: "string",
      title: "Argument key",
      description:
        "Optional: also require the call's arguments[argKey] to strict-equal argEquals.",
      "x-ui": "text",
    },
    argEquals: {
      title: "Argument equals",
      description:
        "Value arguments[argKey] must strict-equal (scalar: string / number / boolean).",
    },
    requireSuccess: {
      type: "boolean",
      default: false,
      title: "Require success",
      description:
        "Only match calls whose tool_result returned returnCode 0 (needs a Host; never matches on the stub path).",
      "x-ui": "toggle",
    },
    flagKey: {
      type: "string",
      minLength: 1,
      title: "Flag key",
      description:
        "nodeContext key set to true on match (e.g. planCompletedThisRound). Consumed by later Actions on the same node.",
      "x-ui": "text",
    },
  },
};

/** Find the tool_result for `toolCallId` in the last role:"tool" message. */
function findToolResult(
  messages: Array<{
    role: string;
    parts: Array<{ type?: string; toolCallId?: string }>;
  }>,
  toolCallId: string,
): ToolResultPart | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i]!;
    if (msg.role !== "tool") continue;
    for (const part of msg.parts) {
      if (
        part &&
        part.type === "tool_result" &&
        (part as ToolResultPart).toolCallId === toolCallId
      ) {
        return part as ToolResultPart;
      }
    }
    // Only the latest tool message holds this round's results.
    break;
  }
  return null;
}

export class NodeActionWhenToolCall extends NodeActionStubBase {
  readonly type = "NodeActionWhenToolCall";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const toolName = stringParam(this.params, "toolName")?.trim();
    const flagKey = stringParam(this.params, "flagKey")?.trim();
    if (!toolName || !flagKey) {
      return {
        status: "halt",
        errorMessage: "NodeActionWhenToolCall requires toolName and flagKey",
      };
    }
    const argKey = stringParam(this.params, "argKey")?.trim() ?? "";
    const argEquals = this.params.argEquals;
    const requireSuccess = boolParam(this.params, "requireSuccess", false);

    const messages = args.host?.session.messages ?? null;
    for (const call of asToolCalls(args.nodeContext.toolCalls)) {
      if (call.name !== toolName) continue;
      if (argKey && call.arguments[argKey] !== argEquals) continue;
      if (requireSuccess) {
        const result = messages ? findToolResult(messages, call.id) : null;
        if (!result || result.returnCode !== 0) continue;
      }
      return {
        status: "continue",
        nodeContextPatch: { [flagKey]: true },
      };
    }
    return { status: "continue" };
  }
}
