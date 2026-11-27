import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import type { FsmGraphToolFamily } from "../fsmGraphAuthoring.js";
import { abortIfSignaled, textResult } from "../pathUtil.js";
const contextProperties = {
  contextId: {
    type: "string",
    description: "Persistent editing context returned by create/open/list. Always identify the context explicitly; it is not runtime TurnContext or NodeContext."
  },
  expectedRevision: {
    type: "integer",
    description: "Required for every mutation, commit and discard. Use the latest returned revision; inspect after a conflict. Do not guess or reuse an old revision."
  }
};
const nodeId = {
  type: "string",
  description: "Stable node id within this context. Create nodes for independent roles, decisions, deterministic operations or retry stages. Keep visit-local preparation and consumers together."
};
const params = {
  type: "object",
  description: "Exact parameters from describe. update REPLACES the full params object; omitted params preserves it. No whole-graph JSON input."
};
export const fsmGraphAuthoringDefinitions: Array<{
  family: FsmGraphToolFamily;
  definition: ToolDefinition;
  handler: ToolHandler;
}> = [];
function register(family: FsmGraphToolFamily, description: string, operations: string[], properties: Record<string, unknown>) {
  const definition: ToolDefinition = {
    name: `fsm_graph_${family}`,
    description,
    parameters: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: operations
        },
        ...properties
      },
      required: ["operation"],
      additionalProperties: false
    },
    defaultPermissionLevel: 1
  };
  const handler: ToolHandler = async (args, context) => {
    const aborted = abortIfSignaled(context.signal);
    if (aborted) return aborted;
    if (!context.fsmGraphLibrary) return textResult(JSON.stringify({
      ok: false,
      error: "FSM graph editing is unavailable in this host"
    }), ToolReturnCode.GenericFailure);
    const result = await context.fsmGraphLibrary.execute(family, args, {
      workspacePath: context.workspacePath,
      ...(context.sessionId ? {
        sessionId: context.sessionId
      } : {})
    });
    return textResult(JSON.stringify(result), result.ok ? ToolReturnCode.Success : ToolReturnCode.GenericFailure);
  };
  fsmGraphAuthoringDefinitions.push({
    family,
    definition,
    handler
  });
}
register("context", "Create and resume persistent FSM editing drafts. Start with guide for node design, scopes, standard action sequences and routing rules. Workflow: create/open -> add empty nodes -> connect -> describe/add actions -> validate -> commit. Incomplete drafts autosave and remain editable; they never run or appear in Composer. Every mutation needs contextId + expectedRevision. Use inspect after interruption/conflict; full=true returns the config, normally summaries and stable ids suffice. Validation reports all blocking errors and warnings without executing actions. Commit requires static validity and checks the saved graph has not changed. Newly created graphs stay disabled until the user enables them after full validation. Existing graphs keep their valid saved version while a draft is edited. undo restores one edit and advances revision; discard removes only the draft. delete_graph deletes a saved graph. No enable operation or whole-config save.", ["guide", "list", "create", "open", "inspect", "validate", "set_meta", "undo", "commit", "discard", "delete_graph"], {
  ...contextProperties,
  graphId: {
    type: "string",
    description: "Required for open/delete_graph. list returns saved graph ids and resumable context ids."
  },
  name: {
    type: "string",
    description: "Required for create; optional set_meta display name."
  },
  description: {
    type: "string",
    description: "set_meta description; empty string clears it."
  },
  template: {
    type: "string",
    enum: ["react", "react_v2", "ask", "plan_execute", "subagent"],
    description: "create: optional built-in template to fork. Omit for an empty Start/End skeleton; actions are added separately."
  },
  full: {
    type: "boolean",
    description: "inspect only: include the full draft config. Default false to keep context small."
  },
  entryNodeId: {
    type: "string",
    description: "set_meta: existing node to enter first."
  },
  terminalNodeId: {
    type: "string",
    description: "set_meta: existing node whose actions run before graph completion."
  }
});
register("node", "Create, inspect and edit FSM nodes separately from actions and connections. add requires contextId, expectedRevision and nodeId; creates an EMPTY node and returns guidance. Optional pattern selects entry/model_round/decision/shell/data/end/custom design guidance without auto-inserting actions. A node is an independently entered processing stage. nodeContext resets on every visit, including self-loops: keep PrepareRole -> PrepareTools -> BuildModelWindow -> CallModel and their tool-result consumers in one visit. Separate nodes for roles, decisions or retry boundaries; use turn/session blackboard for explicit cross-node data. inspect requires contextId/nodeId and returns pattern guidance, pins, connections and stable action ids. update changes name/selfLoop only. remove rejects entry/terminal nodes and reports incident connections removed. add_pin/remove_pin require pin; removing a referenced pin leaves a repairable draft with diagnostics. selfLoop=true permits zero matching edges to re-enter this node, but multiple matches still fail. It must express intentional repetition, not conceal an unfinished graph.", ["add", "inspect", "update", "remove", "add_pin", "remove_pin"], {
  ...contextProperties,
  nodeId,
  pattern: {
    type: "string",
    enum: ["entry", "model_round", "decision", "shell", "data", "end", "custom"],
    description: "Optional add/update design intent. Returns the corresponding standard sequence and parameter guidance; actions are still added separately."
  },
  name: {
    type: "string"
  },
  selfLoop: {
    type: "boolean",
    description: "Opt into implicit re-entry when zero outgoing edges match; fresh nodeContext each time. Default false."
  },
  pin: {
    type: "string",
    description: "add_pin/remove_pin: local pin name, separate from destination node id."
  }
});
register("connection", "Connect existing FSM nodes independently of NodeActions. connect requires contextId, expectedRevision, from and to. Omit pin/type/params for a single unconditional EdgeAlways. For branching supply pin: tool creates that local source pin if needed and a node.routeTarget EdgeWhen; configure a separate RouteTo action to select the pin. pin cannot be combined with type/params. For explicit predicates describe the edge type first, then supply type/params. Example shell result condition: type=EdgeWhen, params={source:'node',turnKey:'shellExitCode',type:'int',operator:'==',value:0}. All outgoing edges are evaluated; exactly ONE must match, edge order is not priority. EdgeAlways must be alone. A pin can own at most one route edge; conflicts never overwrite existing edges. Unwired stay pins are legal for intentional implicit self-loops. update requires connectionId plus the full new from/to and connection specification; disconnect requires connectionId. catalog/describe need no context. Validation never executes conditions or actions.", ["catalog", "describe", "connect", "update", "disconnect"], {
  ...contextProperties,
  connectionId: {
    type: "string",
    description: "Stable connection id returned by connect/inspect. Optional on connect; required on update/disconnect."
  },
  from: {
    type: "string"
  },
  to: {
    type: "string"
  },
  pin: {
    type: "string",
    description: "Source node's local output pin; creates a routeTarget condition with source=node. Destination is given separately by to."
  },
  type: {
    type: "string",
    description: "describe: EdgeAlways or EdgeWhen. Explicit connection: type from catalog; omit when supplying pin."
  },
  params
});
register("action", "Inspect and edit one NodeAction at a time. Begin with catalog/describe; describe with contextId + nodeId returns real local pins, connections, pattern guidance, paramsSchema, prerequisites and a minimum example. add requires contextId, expectedRevision, nodeId and type; params must satisfy the registered schema and custom validator. Creates a stable actionId; optional beforeActionId inserts before an existing action, otherwise appends. update/remove/move require actionId, not array indexes; move without beforeActionId moves to end. update params replaces the full object. Missing visit-local prerequisites and unfinished wiring are saved as draft diagnostics, while malformed action parameters are rejected atomically. Standard model round: RoundGate -> PrepareRole -> PrepareTools -> BuildModelWindow -> CallModel -> RunTools -> ApplyToolEffects -> EmitRouteEvent -> optional AwaitSubagents -> RouteTo. PromptInject/tool restrictions belong before BuildModelWindow; plan sync is conditional. Decision nodes use Compare(asKey) -> RouteTo.when; scripts/data nodes need no model chain. roleKind is identity only; prompts/models/tool policies must be explicit. RouteTo.to names local pins. Composite children run in the same visit and are recursively validated. Adding or validating an action NEVER executes it.", ["catalog", "describe", "add", "update", "move", "remove"], {
  ...contextProperties,
  nodeId,
  actionId: {
    type: "string",
    description: "Stable action id, optional on add (generated otherwise); required on update/move/remove."
  },
  beforeActionId: {
    type: "string",
    description: "add/move: insert before this action in the same node; omit to append."
  },
  type: {
    type: "string",
    description: "Required for describe/add; optional update replacement type. Obtain exact type names from catalog."
  },
  params
});
