import type { OpenAiToolDefinition } from "../../../llm/types.js";
import type { JsonObject } from "../../../session/types.js";
import { isShellToolName } from "../../../tools/shellToolName.js";
import type { FsmParamsSchema } from "../paramsSchema.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import {
  clampEdgMaxSteps,
  EDG_DEFAULT_MAX_STEPS,
  EDG_MAX_STEPS_CAP,
  EDG_THEN_PARAM,
  edgThenSchema,
  type EdgPlanOffered,
} from "./edgBank.js";
import {
  boolParam,
  NodeActionStubBase,
  numberParam,
} from "./NodeActionStubBase.js";

export const NodeActionEdgPlanSchemaSchema: FsmParamsSchema = {
  type: "object",
  title: "Edg plan schema",
  description:
    "Offer an optional `then` (follow-up commands) argument on the shell tool so the model can pre-commit a command chain that Edg admit / Edg dispatch replay without new model rounds.",
  "x-llmDescription": "Mount after PrepareTools (before BuildModelWindow). Adds optional `then: string[]` to the shell tool schema in nodeContext.tools and writes nodeContext.edgPlanOffered for Edg admit. params: enabled (default true — the on/off switch for the whole EDG reuse path), maxSteps (1–8, default 6).",
  details: `Rewrites the shell tool entry in nodeContext.tools (copy; the Host tool cache is untouched) with an extra optional array property \`then\` (maxItems = maxSteps). The schema is identical every round, so tools[] stays prompt-cache stable. The shell handler ignores the field; the argument stays in the transcript so later rounds see the chain they asked for.

Also writes nodeContext.edgPlanOffered = { toolName, maxSteps }; Edg admit only builds a bank on visits where this was offered. enabled=false is a full no-op (no field offered → no bank → no reuse), which is the A/B switch. No shell tool in tools[] → no-op.`,
  additionalProperties: false,
  properties: {
    enabled: {
      type: "boolean",
      default: true,
      title: "Enabled",
      description: "Off = do not offer `then`; the reuse path never starts.",
      "x-ui": "toggle",
    },
    maxSteps: {
      type: "integer",
      default: EDG_DEFAULT_MAX_STEPS,
      minimum: 1,
      title: "Max follow-up commands",
      description: `Upper bound on \`then\` entries per shell call (clamped to ${EDG_MAX_STEPS_CAP}).`,
      "x-ui": "number",
    },
  },
};

export class NodeActionEdgPlanSchema extends NodeActionStubBase {
  readonly type = "NodeActionEdgPlanSchema";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    if (!boolParam(this.params, "enabled", true)) return { status: "continue" };
    const tools = args.nodeContext.tools as OpenAiToolDefinition[] | undefined;
    if (!Array.isArray(tools)) return { status: "continue" };
    const maxSteps = clampEdgMaxSteps(
      numberParam(this.params, "maxSteps", EDG_DEFAULT_MAX_STEPS),
    );

    const index = tools.findIndex((tool) => isShellToolName(tool.function.name));
    if (index < 0) return { status: "continue" };
    const shell = tools[index]!;
    const parameters = (shell.function.parameters ?? { type: "object" }) as JsonObject;
    const properties = (parameters.properties ?? {}) as JsonObject;
    const next = [...tools];
    next[index] = {
      ...shell,
      function: {
        ...shell.function,
        parameters: {
          ...parameters,
          properties: { ...properties, [EDG_THEN_PARAM]: edgThenSchema(maxSteps) },
        },
      },
    };
    const offered: EdgPlanOffered = { toolName: shell.function.name, maxSteps };
    return {
      status: "continue",
      nodeContextPatch: { tools: next, edgPlanOffered: offered },
    };
  }
}
