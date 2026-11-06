import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { JsonObject } from "../session/types.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import type { McpServerConfig, McpTransport } from "../toolsConfig/types.js";
import { readToolsConfig } from "../toolsConfig/store.js";
import {
  resolvePermissionLevel,
} from "../tools/config.js";
import { getTool } from "../tools/registry.js";
import type { ToolExecuteResult } from "../tools/types.js";
import { getToolStatsSummary } from "../toolStats/recorder.js";
import { postNotification } from "../events/notificationCenter.js";
import {
  mapMcpCallResult,
  syncServerToolsToRegistry,
  unregisterServerToolsFromRegistry,
} from "./registerWithAgent.js";
import { attachMcpNotificationForwarder } from "./notifications.js";
import type {
  McpConnectionStatus,
  McpDiscoveredTool,
  McpServerRuntime,
  McpServerUpsertInput,
  McpToolOption,
} from "./types.js";

type LiveConnection = {
  client: Client;
  /** Close underlying transport / client. */
  close: () => Promise<void>;
};

type ServerState = {
  config: McpServerConfig;
  status: McpConnectionStatus;
  errorMessage?: string | undefined;
  tools: McpDiscoveredTool[];
  live: LiveConnection | null;
  /** Serializes connect/disconnect for one server. */
  gate: Promise<void>;
};

const CLIENT_INFO = { name: "jellybot", version: "0.0.16" } as const;

type McpPersistHandler = (configs: McpServerConfig[]) => Promise<void>;

let persistHandler: McpPersistHandler | null = null;

/**
 * Wire settings persistence for mutating MCP manager ops (IPC + agent tools).
 * Call once from main after app data root is known.
 */
export function configureMcpPersistence(handler: McpPersistHandler): void {
  persistHandler = handler;
}

async function persistConfigs(manager: McpManager): Promise<void> {
  if (!persistHandler) return;
  await persistHandler(manager.getConfigs());
}

/**
 * Owns MCP server configs (in-memory mirror of settings), live clients,
 * and agent-registry tool registration.
 */
export class McpManager {
  private readonly servers = new Map<string, ServerState>();

  /** Replace configs from settings and connect enabled servers. */
  async startFromSettings(configs: McpServerConfig[]): Promise<void> {
    await this.reconcile(configs);
  }

  /** Diff configs vs current state; connect / disconnect / reconnect as needed. */
  async reconcile(configs: McpServerConfig[]): Promise<void> {
    const nextIds = new Set(configs.map((c) => c.id));

    for (const id of [...this.servers.keys()]) {
      if (!nextIds.has(id)) {
        await this.removeServerInternal(id, { persistHook: false });
      }
    }

    for (const config of configs) {
      const existing = this.servers.get(config.id);
      if (!existing) {
        this.servers.set(config.id, {
          config: cloneConfig(config),
          status: "disconnected",
          tools: [],
          live: null,
          gate: Promise.resolve(),
        });
        if (config.enabled) {
          await this.connectServer(config.id);
        }
        continue;
      }

      const changed = !sameConfig(existing.config, config);
      existing.config = cloneConfig(config);

      if (!config.enabled) {
        await this.disconnectServer(config.id);
        continue;
      }

      if (changed || existing.status === "error" || existing.status === "disconnected") {
        if (changed || existing.status === "error" || existing.live) {
          await this.disconnectServer(config.id);
        }
        await this.connectServer(config.id);
      }
    }
  }

  /**
   * Re-read tools.json from disk and reconcile MCP servers. Used after agent
   * tools (create/update/delete) mutate config to keep runtime aligned with
   * disk and retry error-state connections. No-op when configs are unchanged.
   */
  async reloadFromDisk(): Promise<void> {
    const tools = await readToolsConfig();
    await this.reconcile(tools.mcpServers);
  }

  listRuntime(): McpServerRuntime[] {
    const callCounts = loadCallCounts();
    return [...this.servers.values()].map((state) => toRuntime(state, callCounts));
  }

  /** Enabled servers' tools from memory only — no stats or permission resolution. */
  listToolOptions(): McpToolOption[] {
    return [...this.servers.values()]
      .filter((s) => s.config.enabled)
      .flatMap((s) =>
        [...s.tools]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((t) => ({
            serverId: s.config.id,
            serverName: s.config.name,
            toolName: t.registryName,
            name: t.name,
            transport: s.config.transport.type,
          })),
      );
  }

  getRuntime(id: string): McpServerRuntime | null {
    const state = this.servers.get(id);
    return state ? toRuntime(state) : null;
  }

  /**
   * Resolve by id first, then by unique name (case-insensitive).
   * Ambiguous names → null with `ambiguous` flag via findServer lookup helper.
   */
  findServer(idOrName: string): {
    runtime: McpServerRuntime | null;
    ambiguous: boolean;
  } {
    const key = idOrName.trim();
    if (!key) return { runtime: null, ambiguous: false };
    const byId = this.servers.get(key);
    if (byId) return { runtime: toRuntime(byId), ambiguous: false };

    const needle = key.toLowerCase();
    const matches = [...this.servers.values()].filter(
      (s) => s.config.name.toLowerCase() === needle,
    );
    if (matches.length === 1) {
      return { runtime: toRuntime(matches[0]!), ambiguous: false };
    }
    if (matches.length > 1) {
      return { runtime: null, ambiguous: true };
    }
    return { runtime: null, ambiguous: false };
  }

  /** Current configs for persistence. */
  getConfigs(): McpServerConfig[] {
    return [...this.servers.values()].map((s) => cloneConfig(s.config));
  }

  async upsertServer(input: McpServerUpsertInput): Promise<McpServerRuntime> {
    const id =
      typeof input.id === "string" && input.id.trim()
        ? input.id.trim()
        : randomUUID();
    const name = input.name.trim();
    if (!name) throw new Error("MCP server name is required");
    const transport = validateTransport(input.transport);

    const config: McpServerConfig = {
      id,
      name,
      enabled: input.enabled !== false,
      transport,
    };

    const existing = this.servers.get(id);
    if (existing) {
      const changed = !sameConfig(existing.config, config);
      existing.config = cloneConfig(config);
      if (!config.enabled) {
        await this.disconnectServer(id);
      } else if (changed || existing.status !== "connected") {
        await this.disconnectServer(id);
        await this.connectServer(id);
      }
    } else {
      this.servers.set(id, {
        config: cloneConfig(config),
        status: "disconnected",
        tools: [],
        live: null,
        gate: Promise.resolve(),
      });
      if (config.enabled) {
        await this.connectServer(id);
      }
    }

    await persistConfigs(this);

    const runtime = this.getRuntime(id);
    if (!runtime) throw new Error("Failed to upsert MCP server");
    return runtime;
  }

  async removeServer(id: string): Promise<void> {
    await this.removeServerInternal(id, { persistHook: false });
    await persistConfigs(this);
  }

  async setEnabled(id: string, enabled: boolean): Promise<McpServerRuntime> {
    const state = this.servers.get(id);
    if (!state) throw new Error(`Unknown MCP server: ${id}`);
    state.config.enabled = enabled;
    if (enabled) {
      await this.connectServer(id);
    } else {
      await this.disconnectServer(id);
    }
    await persistConfigs(this);
    return toRuntime(state);
  }

  async reconnect(id: string): Promise<McpServerRuntime> {
    const state = this.servers.get(id);
    if (!state) throw new Error(`Unknown MCP server: ${id}`);
    await this.disconnectServer(id);
    if (state.config.enabled) {
      await this.connectServer(id);
    }
    return toRuntime(state);
  }

  async callTool(
    serverId: string,
    originalName: string,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<ToolExecuteResult> {
    const state = this.servers.get(serverId);
    if (!state?.live) {
      return {
        content: [
          {
            type: "text",
            text: `MCP server is not connected: ${serverId}`,
          },
        ],
        returnCode: ToolReturnCode.GenericFailure,
      };
    }

    if (signal?.aborted) {
      return {
        content: [{ type: "text", text: "Cancelled." }],
        returnCode: ToolReturnCode.Cancelled,
      };
    }

    try {
      const result = await state.live.client.callTool(
        {
          name: originalName,
          arguments: args,
        },
        undefined,
        signal ? { signal } : undefined,
      );
      if (signal?.aborted) {
        return {
          content: [{ type: "text", text: "Cancelled." }],
          returnCode: ToolReturnCode.Cancelled,
        };
      }
      return mapMcpCallResult(result);
    } catch (err) {
      if (
        signal?.aborted ||
        (err instanceof Error &&
          (err.name === "AbortError" || /aborted|abort/i.test(err.message)))
      ) {
        return {
          content: [{ type: "text", text: "Cancelled." }],
          returnCode: ToolReturnCode.Cancelled,
        };
      }
      const message =
        err instanceof Error ? err.message : "MCP tool call failed";
      return {
        content: [{ type: "text", text: message }],
        returnCode: ToolReturnCode.GenericFailure,
      };
    }
  }

  /**
   * Broadcast one server-status transition on the NotificationCenter
   * (eventName "mcp/server_status"). The renderer bridge forwards it so the
   * Tools page can refresh without polling listRuntime.
   */
  private postStatusEvent(state: ServerState): void {
    postNotification({
      eventName: "mcp/server_status",
      params: {
        serverId: state.config.id,
        serverName: state.config.name,
        status: state.status,
        ...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
      },
      sender: this,
    });
  }

  private async removeServerInternal(
    id: string,
    _opts: { persistHook: boolean },
  ): Promise<void> {
    await this.disconnectServer(id);
    this.servers.delete(id);
  }

  private async connectServer(id: string): Promise<void> {
    const state = this.servers.get(id);
    if (!state || !state.config.enabled) return;

    const run = async (): Promise<void> => {
      if (state.live) return;
      state.status = "connecting";
      state.errorMessage = undefined;
      state.tools = [];
      this.postStatusEvent(state);

      try {
        const live = await openConnection(state.config.transport);
        state.live = live;

        // Forward all unhandled server-initiated notifications (standard +
        // custom methods) to the NotificationCenter. Attached on every
        // (re)connect — each connection creates a fresh client. See
        // notifications.ts for the accepted progress-routing boundary.
        attachMcpNotificationForwarder(live.client, {
          serverId: id,
          serverName: state.config.name,
          sender: this,
        });

        const listed = await live.client.listTools();
        const metas = (listed.tools ?? []).map((tool) => ({
          serverId: id,
          originalName: tool.name,
          description: tool.description ?? "",
          inputSchema: (tool.inputSchema ?? {
            type: "object",
            properties: {},
          }) as JsonObject,
        }));

        state.tools = syncServerToolsToRegistry(
          id,
          metas,
          (sid, name, args, signal) => this.callTool(sid, name, args, signal),
        );
        state.status = "connected";
        state.errorMessage = undefined;
        this.postStatusEvent(state);
      } catch (err) {
        await this.closeLive(state);
        unregisterServerToolsFromRegistry(id);
        state.tools = [];
        state.status = "error";
        state.errorMessage =
          err instanceof Error ? err.message : "Failed to connect to MCP server";
        this.postStatusEvent(state);
      }
    };

    state.gate = state.gate.then(run, run);
    await state.gate;
  }

  private async disconnectServer(id: string): Promise<void> {
    const state = this.servers.get(id);
    if (!state) return;

    const run = async (): Promise<void> => {
      await this.closeLive(state);
      unregisterServerToolsFromRegistry(id);
      state.tools = [];
      state.status = "disconnected";
      state.errorMessage = undefined;
      this.postStatusEvent(state);
    };

    state.gate = state.gate.then(run, run);
    await state.gate;
  }

  private async closeLive(state: ServerState): Promise<void> {
    const live = state.live;
    state.live = null;
    if (!live) return;
    try {
      await live.close();
    } catch {
      // ignore close errors
    }
  }
}

/** `getToolStatsSummary()` scans the whole invocation table — call it once per runtime listing, never per tool. */
function loadCallCounts(): Map<string, number> {
  try {
    return new Map(getToolStatsSummary().map((r) => [r.name, r.calls]));
  } catch {
    return new Map();
  }
}

function toRuntime(
  state: ServerState,
  callCounts: Map<string, number> = loadCallCounts(),
): McpServerRuntime {
  const runtime: McpServerRuntime = {
    id: state.config.id,
    name: state.config.name,
    enabled: state.config.enabled,
    transport: cloneTransport(state.config.transport),
    status: state.status,
    tools: state.tools
      .map((t) => withResolvedPermission(t, callCounts))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  if (state.errorMessage) {
    runtime.errorMessage = state.errorMessage;
  }
  return runtime;
}

function withResolvedPermission(
  tool: McpDiscoveredTool,
  callCounts: Map<string, number>,
): McpDiscoveredTool {
  const registered = getTool(tool.registryName);
  const defaultPermissionLevel =
    registered?.definition.defaultPermissionLevel ??
    tool.defaultPermissionLevel ??
    0;
  const callCount = callCounts.get(tool.registryName) ?? 0;
  return {
    name: tool.name,
    description: tool.description,
    registryName: tool.registryName,
    defaultPermissionLevel,
    permissionLevel: resolvePermissionLevel(
      tool.registryName,
      defaultPermissionLevel,
    ),
    offered: false,
    offerLocked: true,
    callCount,
  };
}


function cloneConfig(config: McpServerConfig): McpServerConfig {
  return {
    id: config.id,
    name: config.name,
    enabled: config.enabled,
    transport: cloneTransport(config.transport),
  };
}

function cloneTransport(transport: McpTransport): McpTransport {
  if (transport.type === "stdio") {
    return {
      type: "stdio",
      command: transport.command,
      ...(transport.args ? { args: [...transport.args] } : {}),
      ...(transport.env ? { env: { ...transport.env } } : {}),
      ...(transport.cwd ? { cwd: transport.cwd } : {}),
    };
  }
  return {
    type: "http",
    url: transport.url,
    ...(transport.headers ? { headers: { ...transport.headers } } : {}),
  };
}

function sameConfig(a: McpServerConfig, b: McpServerConfig): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.enabled === b.enabled &&
    JSON.stringify(a.transport) === JSON.stringify(b.transport)
  );
}

function validateTransport(transport: McpTransport): McpTransport {
  if (transport.type === "stdio") {
    const command = transport.command?.trim();
    if (!command) throw new Error("stdio command is required");
    const next: Extract<McpTransport, { type: "stdio" }> = {
      type: "stdio",
      command,
    };
    if (transport.args && transport.args.length > 0) {
      next.args = [...transport.args];
    }
    if (transport.env && Object.keys(transport.env).length > 0) {
      next.env = { ...transport.env };
    }
    if (transport.cwd?.trim()) {
      next.cwd = transport.cwd.trim();
    }
    return next;
  }
  if (transport.type === "http") {
    const url = transport.url?.trim();
    if (!url) throw new Error("HTTP URL is required");
    void new URL(url);
    const next: Extract<McpTransport, { type: "http" }> = {
      type: "http",
      url,
    };
    if (transport.headers && Object.keys(transport.headers).length > 0) {
      next.headers = { ...transport.headers };
    }
    return next;
  }
  throw new Error("Unsupported MCP transport");
}

async function openConnection(transport: McpTransport): Promise<LiveConnection> {
  if (transport.type === "stdio") {
    return openStdio(transport);
  }
  return openHttp(transport);
}

async function openStdio(
  transport: Extract<McpTransport, { type: "stdio" }>,
): Promise<LiveConnection> {
  const env = {
    ...getDefaultEnvironment(),
    ...(transport.env ?? {}),
  };
  const params: {
    command: string;
    args?: string[];
    env: Record<string, string>;
    cwd?: string;
    stderr: "pipe";
  } = {
    command: transport.command,
    env,
    stderr: "pipe",
  };
  if (transport.args && transport.args.length > 0) {
    params.args = transport.args;
  }
  if (transport.cwd) {
    params.cwd = transport.cwd;
  }
  const stdio = new StdioClientTransport(params);
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  await client.connect(stdio);
  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        try {
          await stdio.close();
        } catch {
          // ignore
        }
      }
    },
  };
}

async function openHttp(
  transport: Extract<McpTransport, { type: "http" }>,
): Promise<LiveConnection> {
  const url = new URL(transport.url);
  const opts = transport.headers
    ? { requestInit: { headers: transport.headers } as RequestInit }
    : {};

  try {
    const httpTransport = new StreamableHTTPClientTransport(url, opts);
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    // SDK Transport.sessionId optional typing conflicts with exactOptionalPropertyTypes.
    await client.connect(httpTransport as Parameters<Client["connect"]>[0]);
    return {
      client,
      close: async () => {
        try {
          await client.close();
        } catch {
          try {
            await httpTransport.close();
          } catch {
            // ignore
          }
        }
      },
    };
  } catch (streamableErr) {
    // Fall back to legacy SSE for servers that do not speak Streamable HTTP.
    const sseTransport = new SSEClientTransport(url, opts);
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
      await client.connect(sseTransport as Parameters<Client["connect"]>[0]);
      return {
        client,
        close: async () => {
          try {
            await client.close();
          } catch {
            try {
              await sseTransport.close();
            } catch {
              // ignore
            }
          }
        },
      };
    } catch (sseErr) {
      const streamMsg =
        streamableErr instanceof Error
          ? streamableErr.message
          : String(streamableErr);
      const sseMsg =
        sseErr instanceof Error ? sseErr.message : String(sseErr);
      throw new Error(
        `HTTP MCP connect failed (streamable: ${streamMsg}; sse: ${sseMsg})`,
      );
    }
  }
}

/** Singleton used by main-process IPC. */
export const mcpManager = new McpManager();
