import type { McpServerConfig, McpTransport } from "../toolsConfig/types.js";

export type McpConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type McpDiscoveredTool = {
  /** Original tool name as advertised by the MCP server. */
  name: string;
  description: string;
  /** Registry / LLM-facing name (`mcp__…`). */
  registryName: string;
  /** Built-in default for this MCP tool (Allow = 0). */
  defaultPermissionLevel: 0 | 1 | 2;
  /** Effective level after runtime overrides. */
  permissionLevel: 0 | 1 | 2;
  /** Whether this tool is in the always-offer set. */
  offered: boolean;
  /** Forced metas only — MCP tools are never locked. */
  offerLocked?: boolean;
  /** Lifetime invocation count when stats are available. */
  callCount?: number;
};


export type McpToolOption = {
  serverId: string;
  serverName: string;
  /** Registry name (`mcp__{serverId}__{tool}`). */
  toolName: string;
  name: string;
  transport: McpTransport["type"];
};

export type McpServerRuntime = {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  status: McpConnectionStatus;
  errorMessage?: string | undefined;
  tools: McpDiscoveredTool[];
};

export type McpServerUpsertInput = {
  /** Omit when creating a new server. */
  id?: string | undefined;
  name: string;
  enabled: boolean;
  transport: McpTransport;
};

export type { McpServerConfig, McpTransport };
