import type { McpServerConfig, McpTransport } from "../toolsConfig/types.js";

export type McpConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export type McpDiscoveredTool = {
  name: string;
  description: string;
  registryName: string;
  defaultPermissionLevel: 0 | 1 | 2;
  permissionLevel: 0 | 1 | 2;
  offered: boolean;
  offerLocked?: boolean;
  callCount?: number;
};


export type McpToolOption = {
  serverId: string;
  serverName: string;
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
  id?: string | undefined;
  name: string;
  enabled: boolean;
  transport: McpTransport;
};

export type { McpServerConfig, McpTransport };
