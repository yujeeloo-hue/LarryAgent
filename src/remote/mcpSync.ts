import { mcpManager, mcpToolNamePrefixForServer } from "../mcp/index.js";
import type { McpServerConfig, McpTransport } from "../toolsConfig/types.js";
import { clearToolPermissionOverridesWithPrefix, getAllToolPermissionOverrides } from "../tools/config.js";
import { clearToolOfferOverridesWithPrefix, getAllToolOfferOverrides, getToolOfferAutoBaseline } from "../tools/offerConfig.js";
import { getAllToolDisplayOverrides } from "../tools/displayConfig.js";
import { patchToolsConfig } from "../toolsConfig/store.js";

export type SyncMcpStatus = "connected" | "connecting" | "disconnected" | "error";

export type SyncMcpServerPublic = {
  id: string;
  name: string;
  enabled: boolean;
  transport:
    | { type: "stdio"; command: string; args?: string[]; cwd?: string }
    | { type: "http"; url: string };
  secretConfigured: boolean;
  status: SyncMcpStatus;
  toolCount: number;
  errorMessage?: string;
};

export type SyncMcpServerTransfer = {
  name: string;
  enabled: boolean;
  transport: McpTransport;
};

export function mcpSyncMatchKey(name: string): string {
  return name.trim().toLowerCase();
}

const ERROR_MESSAGE_CAP = 200;

function toPublic(config: McpServerConfig): SyncMcpServerPublic {
  const runtime = mcpManager.getRuntime(config.id);
  const transport: SyncMcpServerPublic["transport"] = config.transport.type === "stdio"
    ? {
        type: "stdio",
        command: config.transport.command,
        ...(config.transport.args ? { args: [...config.transport.args] } : {}),
        ...(config.transport.cwd ? { cwd: config.transport.cwd } : {}),
      }
    : { type: "http", url: config.transport.url };
  const secretCount = config.transport.type === "stdio"
    ? Object.keys(config.transport.env ?? {}).length
    : Object.keys(config.transport.headers ?? {}).length;
  const status: SyncMcpStatus = runtime?.status ?? "disconnected";
  const out: SyncMcpServerPublic = {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    transport,
    secretConfigured: secretCount > 0,
    status: config.enabled ? status : "disconnected",
    toolCount: runtime?.tools.length ?? 0,
  };
  if (config.enabled && status === "error" && runtime?.errorMessage) {
    out.errorMessage = runtime.errorMessage.slice(0, ERROR_MESSAGE_CAP);
  }
  return out;
}

export function listSyncMcpServers(): SyncMcpServerPublic[] {
  return mcpManager.getConfigs().map(toPublic);
}

export function exportSyncMcpServer(serverId: string): SyncMcpServerTransfer & { id: string } {
  const id = serverId.trim();
  if (!id) throw new Error("Server ID is required.");
  const config = mcpManager.getConfigs().find((server) => server.id === id);
  if (!config) throw new Error("MCP server not found.");
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    transport: config.transport,
  };
}

export async function upsertSyncMcpServer(
  transfer: SyncMcpServerTransfer,
): Promise<{ id: string; action: "added" | "overwritten" }> {
  const name = transfer.name.trim();
  if (!name) throw new Error("MCP server name is required.");
  const existing = mcpManager.getConfigs()
    .find((server) => mcpSyncMatchKey(server.name) === mcpSyncMatchKey(name));
  const transport = mergeBlankSecrets(existing?.transport, transfer.transport);
  const runtime = await mcpManager.upsertServer({
    ...(existing ? { id: existing.id } : {}),
    name,
    enabled: transfer.enabled !== false,
    transport,
  });
  return { id: runtime.id, action: existing ? "overwritten" : "added" };
}

function mergeBlankSecrets(
  existing: McpTransport | undefined,
  incoming: McpTransport,
): McpTransport {
  if (!existing || existing.type !== incoming.type) return incoming;
  if (incoming.type === "stdio") {
    const beforeEnv = existing.type === "stdio" ? existing.env ?? {} : {};
    const nextEnv = incoming.env ?? {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(nextEnv)) {
      env[key] = value === "" && beforeEnv[key] !== undefined ? beforeEnv[key]! : value;
    }
    return {
      type: "stdio",
      command: incoming.command,
      ...(incoming.args ? { args: incoming.args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(incoming.cwd ? { cwd: incoming.cwd } : {}),
    };
  }
  const beforeHeaders = existing.type === "http" ? existing.headers ?? {} : {};
  const nextHeaders = incoming.headers ?? {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(nextHeaders)) {
    headers[key] = value === "" && beforeHeaders[key] !== undefined ? beforeHeaders[key]! : value;
  }
  return {
    type: "http",
    url: incoming.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
}

export async function removeSyncMcpServer(
  serverId: string,
): Promise<{ removed: boolean; id?: string }> {
  const id = serverId.trim();
  if (!id) throw new Error("Server ID is required.");
  const config = mcpManager.getConfigs().find((server) => server.id === id);
  if (!config) return { removed: false };
  await mcpManager.removeServer(id);
  const prefix = mcpToolNamePrefixForServer(id);
  const removedPerm = clearToolPermissionOverridesWithPrefix(prefix);
  const removedOffer = clearToolOfferOverridesWithPrefix(prefix);
  const display = getAllToolDisplayOverrides();
  const displayNames = Object.keys(display).filter((name) => name.startsWith(prefix));
  for (const name of displayNames) delete display[name];
  if (removedPerm.length > 0 || removedOffer.length > 0 || displayNames.length > 0) {
    await patchToolsConfig({
      toolPermissionOverrides: getAllToolPermissionOverrides(),
      toolOfferOverrides: getAllToolOfferOverrides(),
      toolDisplayOverrides: display,
      toolOfferAutoBaseline: getToolOfferAutoBaseline() ?? [],
    });
  }
  return { removed: true, id };
}
