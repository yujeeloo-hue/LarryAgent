import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { NodeActionStubBase, stringParam } from "./NodeActionStubBase.js";

export const NodeActionSetComposerRunModeSchema: FsmParamsSchema = {
  type: "object",
  title: "Set composer run mode",
  description:
    "Request a composer run-mode switch (agent / ask / plan) for this session.",
  "x-llmDescription": "Request a composer run-mode switch: mode agent | ask | plan (required), optional whenNodeFlag gate on a nodeContext flag. Applied at turn end; may be declined (queued prompts, pending approval, already in target mode).",
  details: `Calls host.requestComposerRunMode(mode) — a main-process capability. The request is recorded, not applied inline: the turn host applies it in the turn's finally, and may decline it when queued prompts or a pending plan approval represent user intent composed for the current mode, or when the session already runs the target mode (idempotent no-op). Switching mid-turn is therefore safe — the in-flight turn keeps its own resolved mode.

Pure no-op without the injected capability (tests, subagent turns) and when whenNodeFlag is set but the node flag is not true. Records the request into nodeContext.composerRunModeRequested for graph introspection.`,
  additionalProperties: false,
  required: ["mode"],
  properties: {
    mode: {
      type: "string",
      enum: ["agent", "ask", "plan"],
      title: "Mode",
      description: "Target composer run mode.",
      "x-ui": "select",
      "x-enumLabels": {
        agent: "Agent",
        ask: "Ask",
        plan: "Plan",
      },
    },
    whenNodeFlag: {
      type: "string",
      title: "When node flag",
      description:
        "Only request when this nodeContext key is true (e.g. a When tool call flag). Empty = unconditional.",
      "x-ui": "text",
    },
  },
};

type ComposerRunModeTarget = "agent" | "ask" | "plan";

export class NodeActionSetComposerRunMode extends NodeActionStubBase {
  readonly type = "NodeActionSetComposerRunMode";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const host: FsmHostCapabilities | undefined = args.host;
    if (!host?.requestComposerRunMode) {
      return { status: "continue" };
    }
    const mode = stringParam(this.params, "mode");
    if (mode !== "agent" && mode !== "ask" && mode !== "plan") {
      return {
        status: "halt",
        errorMessage: "NodeActionSetComposerRunMode: mode must be agent, ask, or plan",
      };
    }
    const flag = stringParam(this.params, "whenNodeFlag")?.trim() ?? "";
    if (flag && args.nodeContext[flag] !== true) {
      return { status: "continue" };
    }
    const target: ComposerRunModeTarget = mode;
    host.requestComposerRunMode(target);
    return {
      status: "continue",
      nodeContextPatch: { composerRunModeRequested: target },
    };
  }
}
