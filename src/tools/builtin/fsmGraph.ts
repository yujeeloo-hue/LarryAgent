import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, textResult } from "../pathUtil.js";
import { runFsmGraphTool, type FsmGraphToolInput } from "../fsmGraphTool.js";

export const fsmGraphDefinition: ToolDefinition = {
  name: "fsm_graph",
  description:
    "Manage FSM graphs in the library: list, get, create (optional forkMode), delete, validate a stored graph by id, slim catalog of NodeAction/Edge types, or describe_action / describe_edge for one type's full paramsSchema. " +
    "Do NOT submit a whole FSMGraphConfig — use fsm_graph_edit for mutations. Author order: catalog → describe_action|describe_edge → fsm_graph_edit append_action|add_edge. " +
    "Graphs you create are origin 'llm' and stay disabled until the user enables them in the Graphs editor.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list",
          "get",
          "create",
          "delete",
          "validate",
          "catalog",
          "describe_action",
          "describe_edge",
        ],
        description:
          "Library / describe operation. Start with catalog (slim type index), then describe_action or describe_edge before editing params.",
      },
      id: {
        type: "string",
        description: "Graph id (get / delete / validate).",
      },
      name: {
        type: "string",
        description: "Graph name (required on create).",
      },
      description: {
        type: "string",
        description: "Optional description (create).",
      },
      forkMode: {
        type: "string",
        enum: ["react", "ask", "plan_execute", "subagent"],
        description:
          "Optional builtin template to fork on create instead of the default blank graph.",
      },
      type: {
        type: "string",
        description:
          "NodeAction or Edge type id for describe_action / describe_edge.",
      },
    },
    required: ["action"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

export const fsmGraphHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  if (!context.fsmGraphLibrary) {
    return textResult(
      JSON.stringify({
        ok: false,
        error:
          "fsm_graph is unavailable: graph library port is not wired in this host",
      }),
      ToolReturnCode.GenericFailure,
    );
  }

  const result = await runFsmGraphTool(
    args as FsmGraphToolInput,
    context.fsmGraphLibrary,
  );
  return textResult(
    JSON.stringify(result, null, 2),
    result.ok ? ToolReturnCode.Success : ToolReturnCode.GenericFailure,
  );
};
