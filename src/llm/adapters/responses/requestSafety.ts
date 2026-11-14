import type { ProviderRequestSafety } from "../../streamEvents.js";

const READ_ONLY_TOOLS = new Set(["web_search", "web_search_preview", "file_search"]);
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Classify the actual request capabilities, never names inferred from visible text. */
export function classifyResponsesRequestSafety(tools: unknown, input: unknown): ProviderRequestSafety {
  if (tools !== undefined && tools !== null && !Array.isArray(tools)) return "effects_possible";
  for (const value of Array.isArray(tools) ? tools : []) {
    const tool = record(value);
    if (tool?.type === "function") continue; // Functions execute locally only after completed output.
    if (typeof tool?.type !== "string" || !READ_ONLY_TOOLS.has(tool.type)) return "effects_possible";
  }
  for (const value of Array.isArray(input) ? input : [input]) {
    const item = record(value);
    if (item?.type === "mcp_approval_response" && item.approve === true) return "effects_possible";
  }
  return "read_only";
}
