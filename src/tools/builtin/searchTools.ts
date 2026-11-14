import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  resolveAlwaysOfferedToolNames,
  searchRegistryTools,
} from "../offerSet.js";
import { deferredNameSet, type ToolBridgeScope } from "../toolBridge.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, textResult } from "../pathUtil.js";
import { listTools } from "../registry.js";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 16;

/** Default level: 0 — discovery meta-tool; always offered. */
export const searchToolsDefinition: ToolDefinition = {
  name: "search_tools",
  description:
    "Search deferred tools by keywords (AND). Returns names and short descriptions. Next: tool_describe for full schema, then tool_call to invoke. Does not add tools to the tools array.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Keywords (space/comma separated); all must match.",
      },
      limit: {
        type: "integer",
        description: `Max tools to return (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
    },
    required: ["query"],
  },
  defaultPermissionLevel: 0,
};

function parseLimit(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(1, Math.min(MAX_LIMIT, Math.floor(raw)));
  }
  if (typeof raw === "string" && raw.trim()) {
    const n = Number(raw.trim());
    if (Number.isFinite(n)) {
      return Math.max(1, Math.min(MAX_LIMIT, Math.floor(n)));
    }
  }
  return DEFAULT_LIMIT;
}

export const searchToolsHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return failureResult(
      'Invalid arguments: "query" (non-empty string) is required.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const limit = parseLimit(args.limit);
  const registryNames = listTools().map((t) => t.definition.name);
  const eager = resolveAlwaysOfferedToolNames(registryNames);
  const scope = context.bridgeScope as ToolBridgeScope | undefined;
  const deferred = deferredNameSet({
    registryNames,
    ...(scope ? { scope } : {}),
  });

  const hits = searchRegistryTools({
    query,
    limit,
    excludeNames: eager,
    includeNames: deferred,
  });
  if (hits.length === 0) {
    return textResult(
      `No deferred tools matched query ${JSON.stringify(query)}. Try different keywords.`,
      ToolReturnCode.Success,
    );
  }

  const names = hits.map((h) => h.name);
  const lines = hits.map(
    (h) =>
      `- ${h.name} (${h.displayName}) [${h.category}]: ${h.description.slice(0, 160)}${
        h.description.length > 160 ? "…" : ""
      }`,
  );

  return textResult(
    [
      `Found ${names.length} deferred tool(s): ${names.join(", ")}.`,
      "Next: tool_describe({ name }) for the full schema, then tool_call({ name, arguments }).",
      "These tools are NOT added to the tools array.",
      "",
      ...lines,
    ].join("\n"),
    ToolReturnCode.Success,
  );
};
