export const MCP_TOOL_PREFIX = "mcp__";

export function encodeMcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeSegment(serverId)}__${sanitizeSegment(toolName)}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

export function mcpToolNamePrefixForServer(serverId: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeSegment(serverId)}__`;
}

export function sanitizeSegment(value: string): string {
  const trimmed = value.trim();
  const sanitized = trimmed.replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/_+/g, "_");
  const stripped = sanitized.replace(/^_+|_+$/g, "");
  return stripped || "tool";
}
