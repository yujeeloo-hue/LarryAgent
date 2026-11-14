/**
 * Console MCP Hub API. Session-token guarded. Responses include server
 * metadata with env/header values stripped to key names; they never include
 * the values. Device push/pull orchestrates Relay-originated encrypted
 * device RPC — mirrors the Token Hub endpoints one for one.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifySessionToken } from "./auth.js";
import type { DeviceAction } from "./protocol.js";
import {
  mcpMatchKey,
  McpHubOrderConflictError,
  McpHubStore,
  normalizeMcpHubTransport,
  type McpHubSnapshot,
  type McpHubPublicServer,
  type McpHubTransport,
} from "./mcpHubStore.js";

const MAX_BODY_BYTES = 256 * 1024;

/** Device-side public server (listSyncMcpServers result rows). */
type DeviceSyncMcpServer = {
  id: string;
  name: string;
  enabled: boolean;
  transport: { type: "stdio"; command: string; args?: string[]; cwd?: string } | { type: "http"; url: string };
  secretConfigured: boolean;
  status?: string;
  toolCount?: number;
  errorMessage?: string;
};

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function matchAction(source: { name: string }, targets: Array<{ name: string }>): "add" | "overwrite" {
  const key = mcpMatchKey(source.name);
  return targets.some((t) => mcpMatchKey(t.name) === key) ? "overwrite" : "add";
}

function isUnsupportedSyncError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unknown action/i.test(message);
}

async function listDeviceMcpServers(
  callDevice: NonNullable<McpHubEndpointDeps["callDevice"]>,
  deviceId: string,
): Promise<DeviceSyncMcpServer[]> {
  const result = await callDevice(deviceId, "listSyncMcpServers", {}) as { servers?: DeviceSyncMcpServer[] };
  return Array.isArray(result?.servers) ? result.servers : [];
}

type McpHubEndpointDeps = {
  mcpHub: McpHubStore;
  isDeviceOnline?: (deviceId: string) => boolean;
  callDevice?: (deviceId: string, action: DeviceAction, payload?: unknown) => Promise<unknown>;
  onAudit?: (actor: string, action: string, detail?: string) => void;
};

export function createMcpHubEndpoints(deps: McpHubEndpointDeps): {
  handle(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
} {
  const prefix = "/api/console/mcp-hub";
  const sendSnapshot = (res: ServerResponse, snapshot: McpHubSnapshot) => json(res, 200, snapshot);

  return {
    async handle(pathname, req, res) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
      const session = verifySessionToken(req.headers["x-auth-token"]);
      if (!session) {
        json(res, 401, { error: "invalid_session" });
        return true;
      }
      if (!deps.mcpHub.available) {
        json(res, 503, { error: "mcp_hub_unavailable", reason: deps.mcpHub.unavailableReason });
        return true;
      }
      try {
        if (req.method === "GET" && pathname === prefix) {
          sendSnapshot(res, deps.mcpHub.snapshot());
          return true;
        }
        if (req.method === "POST" && pathname === `${prefix}/servers`) {
          const body = await readJsonBody(req);
          if (!Array.isArray(body.servers)) {
            json(res, 400, { error: "invalid_servers" });
            return true;
          }
          const snapshot = deps.mcpHub.addServers(body.servers.map((item) => {
            if (!item || typeof item !== "object") throw new Error("invalid server payload");
            const row = item as Record<string, unknown>;
            return {
              name: typeof row.name === "string" ? row.name : "",
              enabled: row.enabled !== false,
              transport: normalizeMcpHubTransport(row.transport),
            };
          }));
          deps.onAudit?.(session.username, "mcpHubAdd", `added ${body.servers.length} servers`);
          sendSnapshot(res, snapshot);
          return true;
        }
        if (req.method === "POST" && pathname === `${prefix}/servers/reorder`) {
          const body = await readJsonBody(req);
          if (!Array.isArray(body.serverIds) || body.serverIds.some((id) => typeof id !== "string" || !id.trim())) {
            json(res, 400, { error: "invalid_server_order" });
            return true;
          }
          const snapshot = deps.mcpHub.reorderServers(body.serverIds);
          deps.onAudit?.(session.username, "mcpHubReorder", `ordered ${body.serverIds.length} servers`);
          sendSnapshot(res, snapshot);
          return true;
        }
        const serverMatch = /^\/api\/console\/mcp-hub\/servers\/([^/]+)$/.exec(pathname);
        if (serverMatch) {
          const serverId = decodeURIComponent(serverMatch[1]!);
          if (req.method === "PATCH") {
            const body = await readJsonBody(req);
            const patch: { name?: string; enabled?: boolean; transport?: McpHubTransport } = {};
            if (typeof body.name === "string") patch.name = body.name;
            if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
            if (body.transport !== undefined) {
              // Blank env/header values keep the stored ones — mirror the
              // API-key blank-to-keep semantics from the Token Hub UI.
              const before = deps.mcpHub.getTransfer(serverId);
              const incoming = normalizeMcpHubTransport(body.transport);
              patch.transport = mergeBlankSecrets(before.transport, incoming) ?? incoming;
            }
            if (!patch.name && patch.enabled === undefined && !patch.transport) {
              json(res, 400, { error: "invalid_patch" });
              return true;
            }
            const snapshot = deps.mcpHub.updateServer(serverId, patch);
            deps.onAudit?.(session.username, "mcpHubUpdate", (patch.name ?? deps.mcpHub.getTransfer(serverId).name).slice(0, 40));
            sendSnapshot(res, snapshot);
            return true;
          }
          if (req.method === "DELETE") {
            const transfer = deps.mcpHub.getTransfer(serverId);
            sendSnapshot(res, deps.mcpHub.removeServer(serverId));
            deps.onAudit?.(session.username, "mcpHubDelete", transfer.name.slice(0, 40));
            return true;
          }
        }

        const syncPreviewMatch = /^\/api\/console\/mcp-hub\/devices\/([^/]+)\/sync-preview$/.exec(pathname);
        if (syncPreviewMatch && req.method === "GET") {
          const deviceId = decodeURIComponent(syncPreviewMatch[1]!);
          const online = deps.isDeviceOnline?.(deviceId) === true;
          const hubServers = deps.mcpHub.snapshot().servers;
          if (!online || !deps.callDevice) {
            json(res, 200, {
              deviceOnline: online,
              supportsSync: false,
              hubServers: hubServers.map((s) => ({ ...s, match: "add" as const })),
              deviceServers: [] as Array<DeviceSyncMcpServer & { match: "add" | "overwrite" }>,
              snapshot: deps.mcpHub.snapshot(),
            });
            return true;
          }
          try {
            const deviceServers = await listDeviceMcpServers(deps.callDevice, deviceId);
            json(res, 200, {
              deviceOnline: true,
              supportsSync: true,
              hubServers: hubServers.map((s) => ({
                ...s,
                match: matchAction(s, deviceServers),
              })),
              deviceServers: deviceServers.map((s) => ({
                ...s,
                match: matchAction(s, hubServers),
              })),
              snapshot: deps.mcpHub.snapshot(),
            });
          } catch (err) {
            if (isUnsupportedSyncError(err)) {
              json(res, 200, {
                deviceOnline: true,
                supportsSync: false,
                hubServers: hubServers.map((s) => ({ ...s, match: "add" as const })),
                deviceServers: [],
                snapshot: deps.mcpHub.snapshot(),
              });
              return true;
            }
            throw err;
          }
          return true;
        }

        const syncPushMatch = /^\/api\/console\/mcp-hub\/devices\/([^/]+)\/push$/.exec(pathname);
        if (syncPushMatch && req.method === "POST") {
          const deviceId = decodeURIComponent(syncPushMatch[1]!);
          if (!deps.callDevice || deps.isDeviceOnline?.(deviceId) !== true) {
            json(res, 409, { error: "device offline" });
            return true;
          }
          const body = await readJsonBody(req);
          const serverId = typeof body.serverId === "string" ? body.serverId.trim() : "";
          if (!serverId) {
            json(res, 400, { error: "serverId required" });
            return true;
          }
          const transfer = deps.mcpHub.getTransfer(serverId);
          const result = await deps.callDevice(deviceId, "upsertSyncMcpServer", {
            name: transfer.name,
            enabled: transfer.enabled,
            transport: transfer.transport,
          }) as { id?: string; action?: string };
          const snapshot = deps.mcpHub.assignServer(deviceId, serverId);
          deps.onAudit?.(
            session.username,
            "mcpHubPush",
            `${deviceId} · ${transfer.name.slice(0, 40)} · ${result.action ?? "ok"}`,
          );
          json(res, 200, {
            action: result.action === "overwritten" ? "overwritten" : "added",
            deviceServerId: typeof result.id === "string" ? result.id : null,
            snapshot,
          });
          return true;
        }

        const syncPullMatch = /^\/api\/console\/mcp-hub\/devices\/([^/]+)\/pull$/.exec(pathname);
        if (syncPullMatch && req.method === "POST") {
          const deviceId = decodeURIComponent(syncPullMatch[1]!);
          if (!deps.callDevice || deps.isDeviceOnline?.(deviceId) !== true) {
            json(res, 409, { error: "device offline" });
            return true;
          }
          const body = await readJsonBody(req);
          const serverId = typeof body.serverId === "string" ? body.serverId.trim() : "";
          if (!serverId) {
            json(res, 400, { error: "serverId required" });
            return true;
          }
          const exported = await deps.callDevice(deviceId, "exportSyncMcpServer", { serverId }) as {
            name?: string;
            enabled?: boolean;
            transport?: unknown;
          };
          if (typeof exported?.name !== "string" || !exported.name.trim() || !exported.transport) {
            json(res, 400, { error: "invalid device MCP server export" });
            return true;
          }
          const upserted = deps.mcpHub.upsertByMatch({
            name: exported.name,
            enabled: exported.enabled !== false,
            transport: normalizeMcpHubTransport(exported.transport),
          });
          const snapshot = deps.mcpHub.assignServer(deviceId, upserted.serverId);
          deps.onAudit?.(
            session.username,
            "mcpHubPull",
            `${deviceId} · ${upserted.serverId.slice(0, 8)} · ${upserted.action}`,
          );
          json(res, 200, {
            action: upserted.action,
            serverId: upserted.serverId,
            snapshot,
          });
          return true;
        }

        const syncRemoveMatch = /^\/api\/console\/mcp-hub\/devices\/([^/]+)\/remove$/.exec(pathname);
        if (syncRemoveMatch && req.method === "POST") {
          const deviceId = decodeURIComponent(syncRemoveMatch[1]!);
          if (!deps.callDevice || deps.isDeviceOnline?.(deviceId) !== true) {
            json(res, 409, { error: "device offline" });
            return true;
          }
          const body = await readJsonBody(req);
          const deviceServerId = typeof body.serverId === "string" ? body.serverId.trim() : "";
          if (!deviceServerId) {
            json(res, 400, { error: "serverId required" });
            return true;
          }
          const deviceServers = await listDeviceMcpServers(deps.callDevice, deviceId);
          const target = deviceServers.find((server) => server.id === deviceServerId);
          if (!target) {
            json(res, 200, { removed: false, deviceServerId, snapshot: deps.mcpHub.snapshot() });
            return true;
          }
          const removed = await deps.callDevice(deviceId, "removeSyncMcpServer", {
            serverId: deviceServerId,
          }) as { removed?: boolean };
          let snapshot = deps.mcpHub.snapshot();
          // Drop hub associations for this name once no same-name device row
          // remains — the actual device list stays authoritative for the UI.
          if (removed.removed === true && !deviceServers.some((server) =>
            server.id !== deviceServerId && mcpMatchKey(server.name) === mcpMatchKey(target.name))) {
            for (const server of snapshot.servers) {
              if (mcpMatchKey(server.name) === mcpMatchKey(target.name)) {
                snapshot = deps.mcpHub.unassignServer(deviceId, server.id);
              }
            }
          }
          deps.onAudit?.(
            session.username,
            "mcpHubRemoveFromDevice",
            `${deviceId} · ${target.name.slice(0, 40)} · ${removed.removed ? "removed" : "missing"}`,
          );
          json(res, 200, { removed: removed.removed === true, deviceServerId, snapshot });
          return true;
        }

        json(res, 404, { error: "not_found" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "mcp hub request failed";
        if (err instanceof McpHubOrderConflictError) {
          json(res, 409, { error: "server_order_conflict", detail: message });
          return true;
        }
        if (isUnsupportedSyncError(err)) {
          json(res, 409, {
            error: "device_update_required",
            detail: "Update this device to sync MCP servers remotely.",
          });
          return true;
        }
        const status = /not found/i.test(message)
          ? 404
          : /unavailable|offline|timeout/i.test(message)
            ? 409
            : 400;
        json(res, status, { error: message });
      }
      return true;
    },
  };
}

/**
 * Blank-to-keep merge for a transport PATCH: env/header keys sent with empty
 * values keep their stored values; keys absent from the patch are dropped.
 * Returns the merged transport, or null when nothing needed merging.
 */
function mergeBlankSecrets(
  before: McpHubTransport,
  next: McpHubTransport,
): McpHubTransport | null {
  if (before.type !== next.type) return null;
  if (next.type === "stdio") {
    const beforeEnv = before.type === "stdio" ? before.env ?? {} : {};
    const nextEnv = next.env ?? {};
    let merged = false;
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(nextEnv)) {
      if (value === "" && beforeEnv[key] !== undefined) {
        env[key] = beforeEnv[key]!;
        merged = true;
      } else env[key] = value;
    }
    if (!merged) return null;
    const transport: McpHubTransport = {
      type: "stdio",
      command: next.command,
      ...(next.args ? { args: next.args } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      ...(next.cwd ? { cwd: next.cwd } : {}),
    };
    return transport;
  }
  const beforeHeaders = before.type === "http" ? before.headers ?? {} : {};
  const nextHeaders = next.headers ?? {};
  let merged = false;
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(nextHeaders)) {
    if (value === "" && beforeHeaders[key] !== undefined) {
      headers[key] = beforeHeaders[key]!;
      merged = true;
    } else headers[key] = value;
  }
  if (!merged) return null;
  const transport: McpHubTransport = {
    type: "http",
    url: next.url,
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };
  return transport;
}

export type { McpHubPublicServer, McpHubSnapshot };
