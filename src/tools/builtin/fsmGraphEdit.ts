import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, textResult } from "../pathUtil.js";
import {
  runFsmGraphEditTool,
  type FsmGraphEditToolInput,
} from "../fsmGraphEditTool.js";

const APPEND_ACTION_HINT =
  "Append one NodeAction to a node. REQUIRED before calling: fsm_graph describe_action with this type — read paramsSchema, then fill params. Do not invent fields from memory or from the slim catalog.";

const ADD_EDGE_HINT =
  "Add one edge. REQUIRED before calling: fsm_graph describe_edge with this type — read paramsSchema, then fill params. Do not invent fields from memory or from the slim catalog.";

export const fsmGraphEditDefinition: ToolDefinition = {
  name: "fsm_graph_edit",
  description:
    "Apply one structural edit to a saved FSM graph (id required). Author order: fsm_graph catalog → describe_action|describe_edge → then append_action|add_edge. " +
    "Other actions: set_meta, add_node, remove_node, add_pin, remove_pin, remove_action, remove_edge. " +
    "LLM-authored graphs remain disabled until the user enables them. No whole-config save.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "set_meta",
          "add_node",
          "remove_node",
          "add_pin",
          "remove_pin",
          "append_action",
          "remove_action",
          "add_edge",
          "remove_edge",
        ],
        description:
          "Single mutation. append_action: " +
          APPEND_ACTION_HINT +
          " add_edge: " +
          ADD_EDGE_HINT,
      },
      id: {
        type: "string",
        description: "Target graph id (from fsm_graph list / create).",
      },
      name: {
        type: "string",
        description: "set_meta / add_node: display name.",
      },
      description: {
        type: "string",
        description: "set_meta: optional graph description.",
      },
      nodeId: {
        type: "string",
        description: "Node id for node/pin/action edits.",
      },
      pinName: {
        type: "string",
        description: "Pin name for add_pin / remove_pin.",
      },
      type: {
        type: "string",
        description:
          "append_action: NodeAction type id — call fsm_graph describe_action with this type first and follow paramsSchema. " +
          "add_edge: Edge type id — call fsm_graph describe_edge first.",
      },
      params: {
        type: "object",
        description:
          "append_action / add_edge only: params object shaped exactly like the paramsSchema from the matching describe_* call. " +
          "Do not guess keys. Prefer describing the type in this turn before appending.",
      },
      index: {
        type: "number",
        description:
          "remove_action: 0-based action index on the node. remove_edge: optional index among from→to matches.",
      },
      from: {
        type: "string",
        description: "add_edge / remove_edge: source node id.",
      },
      to: {
        type: "string",
        description: "add_edge / remove_edge: target node id.",
      },
      selfLoop: {
        type: "boolean",
        description: "add_node: optional self-loop flag.",
      },
    },
    required: ["action", "id"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 1,
};

export const fsmGraphEditHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  if (!context.fsmGraphLibrary) {
    return textResult(
      JSON.stringify({
        ok: false,
        error:
          "fsm_graph_edit is unavailable: graph library port is not wired in this host",
      }),
      ToolReturnCode.GenericFailure,
    );
  }

  const result = await runFsmGraphEditTool(
    args as FsmGraphEditToolInput,
    context.fsmGraphLibrary,
  );
  return textResult(
    JSON.stringify(result, null, 2),
    result.ok ? ToolReturnCode.Success : ToolReturnCode.GenericFailure,
  );
};
