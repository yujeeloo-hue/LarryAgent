/** Prefix for all MCP-backed tool names in the agent registry / LLM. */
export const MCP_TOOL_PREFIX = "mcp__";

/**
 * Encode an MCP tool into a stable OpenAI-safe function name.
 * Format: `mcp__{serverId}__{sanitizedOriginalName}`
 */
export function encodeMcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeSegment(serverId)}__${sanitizeSegment(toolName)}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

export function mcpToolNamePrefixForServer(serverId: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeSegment(serverId)}__`;
}

/**
 * OpenAI function names: letters, digits, underscore, hyphen.
 * Collapse other runs into a single underscore.
 */
export function sanitizeSegment(value: string): string {
  const trimmed = value.trim();
  const sanitized = trimmed.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_");
  const stripped = sanitized.replace(/^_+|_+$/g, "");
  return stripped || "tool";
}
