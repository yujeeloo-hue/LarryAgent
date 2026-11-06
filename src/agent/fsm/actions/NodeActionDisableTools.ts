import type { FsmParamsSchema } from "../paramsSchema.js";
import { filterModelTools } from "../../policy/filterModelTools.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "../types.js";
import { boolParam, NodeActionStubBase, stringParam } from "./NodeActionStubBase.js";

/**
 * Record a phase deny list for the current role.
 *
 * The deny list is applied before every model request and at local execution.
 * Default (`hardFilter: false`) retains the prepared candidates so a later
 * merge:false policy replacement can make a previously denied tool available.
 *
 * Legacy `hardFilter: true` also narrows the prepared candidates immediately.
 * It never controls whether request filtering or local enforcement runs.
 */
export const NodeActionDisableToolsSchema: FsmParamsSchema = {
  type: "object",
  title: "Disable tools",
  description:
    "Exclude listed tools from this role’s model requests and reject attempts to execute them locally.",
  "x-llmDescription": "Deny tools for this role: toolNames (required, exact names or * patterns), merge (default true: union with existing denials). Both model requests and local execution filter the deny list.",
  details: `Records nodeContext.disabledTools. Build model window and Call model always filter the current candidates before preparing or sending a request, including for legacy hardFilter=false settings. Run tools checks the same denials again if the model emits a forbidden call from history.

By default tools[] retains the prepared candidates so merge=false can replace or clear the current denials without losing those candidates. Legacy hardFilter=true additionally removes matching candidates immediately; refreshing Prepare tools rebuilds them. merge=true unions with the existing deny list, false replaces it.`,
  additionalProperties: false,
  required: ["toolNames"],
  properties: {
    toolNames: {
      type: "array",
      items: { type: "string" },
      default: [],
      title: "Disabled tool names",
      description:
        "Tool names or * patterns excluded from model requests and local execution (e.g. run_shell, write_file).",
      "x-ui": "string-list",
    },
    merge: {
      type: "boolean",
      default: true,
      title: "Merge with existing deny list",
      description:
        "If true, union with NodeContext.disabledTools; if false, replace.",
      "x-ui": "toggle",
    },
    hardFilter: {
      type: "boolean",
      default: false,
      title: "Narrow prepared candidates immediately",
      description:
        "Legacy setting: also remove denied tools from the prepared candidates. Model requests always exclude disabled tools, regardless of this value.",
      "x-ui": "hidden",
    },
  },
};

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string" && x.length > 0);
}

export class NodeActionDisableTools extends NodeActionStubBase {
  readonly type = "NodeActionDisableTools";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const named = asStringList(this.params.toolNames);
    const merge = boolParam(this.params, "merge", true);
    const hardFilter = boolParam(this.params, "hardFilter", false);
    const prev = asStringList(args.nodeContext.disabledTools);
    const disabledTools = merge
      ? [...new Set([...prev, ...named])]
      : [...new Set(named)];

    // Keep candidates available for later policy replacements. Request-time
    // filtering is mandatory and independent of this legacy setting.
    if (!hardFilter) {
      return {
        status: "continue",
        nodeContextPatch: {
          disabledTools,
          toolsDisabledApplied: true,
        },
      };
    }

    const toolsRaw = args.nodeContext.tools;
    const tools = Array.isArray(toolsRaw)
      ? filterModelTools(toolsRaw, { denyTools: disabledTools })
      : toolsRaw;

    return {
      status: "continue",
      nodeContextPatch: {
        disabledTools,
        ...(Array.isArray(toolsRaw) ? { tools } : {}),
        toolsDisabledApplied: true,
      },
    };
  }
}
