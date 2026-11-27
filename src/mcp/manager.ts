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
  close: () => Promise<void>;
};

type ServerState = {
  config: McpServerConfig;
  status: McpConnectionStatus;
  errorMessage?: string | undefined;
  tools: McpDiscoveredTool[];
  live: LiveConnection | null;
  gate: Promise<void>;
  probeGeneration: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
};

export type McpRetryOptions = {
  retryBaseMs?: number;
  retryMaxMs?: number;
};

const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 60_000;

export type McpToolInvoker = (
  name: string,
  args: JsonObject,
  signal?: AbortSignal,
) => Promise<ToolExecuteResult>;

export type McpServerConnection = {
  serverId: string;
  toolNames: readonly string[];
  serverCapabilities: JsonObject | null;
  callTool: McpToolInvoker;
  stillCurrent: () => boolean;
  transport: McpTransport["type"];
  reconnect: () => void;
};

export type McpServerProbe = {
  onConnected: (connection: McpServerConnection) => Promise<void>;
  onDisconnected: (serverId: string) => void;
  onNotification?: (serverId: string, method: string, params: JsonObject) => void;
};

const TOOLS_LIST_CHANGED = "notifications/tools/list_changed";

const CLIENT_INFO = { name: "jellybot", version: "0.0.16" } as const;

type McpPersistHandler = (configs: McpServerConfig[]) => Promise<void>;

let persistHandler: McpPersistHandler | null = null;

export function configureMcpPersistence(handler: McpPersistHandler): void {
  persistHandler = handler;
}

async function persistConfigs(manager: McpManager): Promise<void> {
  if (!persistHandler) return;
  await persistHandler(manager.getConfigs());
}

export class McpManager {
  private readonly servers = new Map<string, ServerState>();
  private hiddenToolNames = new Set<string>();
  private serverProbe: McpServerProbe | null = null;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;

  constructor(options: McpRetryOptions = {}) {
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
  }

  setHiddenMcpToolNames(names: readonly string[]): void {
    this.hiddenToolNames = new Set(names);
  }

  setMcpServerProbe(probe: McpServerProbe | null): void {
    this.serverProbe = probe;
  }

  async startFromSettings(configs: McpServerConfig[]): Promise<void> {
    await this.reconcile(configs);
  }

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
        this.servers.set(config.id, freshServerState(config));
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

  async reloadFromDisk(): Promise<void> {
    const tools = await readToolsConfig();
    await this.reconcile(tools.mcpServers);
  }

  listRuntime(): McpServerRuntime[] {
    const callCounts = loadCallCounts();
    return [...this.servers.values()].map((state) => toRuntime(state, callCounts));
  }

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
      this.servers.set(id, freshServerState(config));
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
      if (state.live || !state.config.enabled) return;
      this.clearRetry(state);
      const generation = ++state.probeGeneration;
      this.serverProbe?.onDisconnected(id);
      state.status = "connecting";
      state.errorMessage = undefined;
      state.tools = [];
      this.postStatusEvent(state);

      try {
        const transport = state.config.transport;
        const live = await openConnection(transport);
        state.live = live;
        const stillCurrent = () =>
          state.probeGeneration === generation && state.live === live && state.config.enabled;
        live.client.onclose = () => {
          if (state.live !== live) return;
          state.live = null;
          state.probeGeneration += 1;
          this.serverProbe?.onDisconnected(id);
          this.finishDisconnect(state);
          this.scheduleRetry(state);
        };

        attachMcpNotificationForwarder(live.client, {
          serverId: id,
          serverName: state.config.name,
          sender: this,
          onNotification: (method, params) => {
            if (state.live !== live) return;
            if (method === TOOLS_LIST_CHANGED) {
              void this.refreshServerTools(id, live);
              return;
            }
            this.serverProbe?.onNotification?.(id, method, params);
          },
        });

        await this.syncToolsAndProbe(state, live, stillCurrent);
        if (!stillCurrent()) return;
        state.status = "connected";
        state.errorMessage = undefined;
        state.retryAttempt = 0;
        this.postStatusEvent(state);
      } catch (err) {
        if (state.probeGeneration !== generation) return;
        await this.closeLive(state);
        unregisterServerToolsFromRegistry(id);
        state.tools = [];
        this.serverProbe?.onDisconnected(id);
        state.status = "error";
        state.errorMessage =
          err instanceof Error ? err.message : "Failed to connect to MCP server";
        this.postStatusEvent(state);
        this.scheduleRetry(state);
      }
    };

    state.gate = state.gate.then(run, run);
    await state.gate;
  }

  private async syncToolsAndProbe(
    state: ServerState,
    live: LiveConnection,
    stillCurrent: () => boolean,
  ): Promise<void> {
    const id = state.config.id;
    const listed = await live.client.listTools();
    if (!stillCurrent()) return;
    const metas = (listed.tools ?? []).map((tool) => ({
      serverId: id,
      originalName: tool.name,
      description: tool.description ?? "",
      inputSchema: (tool.inputSchema ?? {
        type: "object",
        properties: {},
      }) as JsonObject,
    }));

    const visible = metas.filter((tool) => !this.hiddenToolNames.has(tool.originalName));
    state.tools = syncServerToolsToRegistry(
      id,
      state.config.name,
      visible,
      (sid, name, args, signal) => this.callTool(sid, name, args, signal),
    );
    try {
      await this.serverProbe?.onConnected({
        serverId: id,
        toolNames: metas.map((tool) => tool.originalName),
        serverCapabilities: (live.client.getServerCapabilities() ?? null) as JsonObject | null,
        callTool: (name, args, signal) => this.callTool(id, name, args, signal),
        stillCurrent,
        transport: state.config.transport.type,
        reconnect: () => { void this.reconnectLive(id, live); },
      });
    } catch {
      if (stillCurrent()) this.serverProbe?.onDisconnected(id);
    }
  }

  private async refreshServerTools(id: string, live: LiveConnection): Promise<void> {
    const state = this.servers.get(id);
    if (!state) return;

    const run = async (): Promise<void> => {
      if (state.live !== live || state.status !== "connected") return;
      const generation = ++state.probeGeneration;
      const stillCurrent = () =>
        state.probeGeneration === generation && state.live === live && state.config.enabled;
      try {
        await this.syncToolsAndProbe(state, live, stillCurrent);
      } catch {
        return;
      }
      if (stillCurrent()) this.postStatusEvent(state);
    };

    state.gate = state.gate.then(run, run);
    await state.gate;
  }

  private async disconnectServer(id: string): Promise<void> {
    const state = this.servers.get(id);
    if (!state) return;

    const run = async (): Promise<void> => {
      this.clearRetry(state);
      state.retryAttempt = 0;
      state.probeGeneration += 1;
      this.serverProbe?.onDisconnected(id);
      await this.closeLive(state);
      this.finishDisconnect(state);
    };

    state.gate = state.gate.then(run, run);
    await state.gate;
  }

  private async reconnectLive(id: string, live: LiveConnection): Promise<void> {
    const state = this.servers.get(id);
    if (!state) return;
    let dropped = false;

    const run = async (): Promise<void> => {
      if (state.live !== live) return;
      state.probeGeneration += 1;
      this.serverProbe?.onDisconnected(id);
      await this.closeLive(state);
      this.finishDisconnect(state);
      dropped = true;
    };

    state.gate = state.gate.then(run, run);
    await state.gate;
    if (dropped && state.config.enabled && this.servers.get(id) === state) {
      await this.connectServer(id);
    }
  }

  private scheduleRetry(state: ServerState): void {
    this.clearRetry(state);
    if (!state.config.enabled || this.servers.get(state.config.id) !== state) return;
    const delay = Math.min(this.retryBaseMs * 2 ** state.retryAttempt, this.retryMaxMs);
    state.retryAttempt += 1;
    const timer = setTimeout(() => {
      state.retryTimer = null;
      if (state.live || !state.config.enabled || this.servers.get(state.config.id) !== state) return;
      void this.connectServer(state.config.id);
    }, delay);
    timer.unref?.();
    state.retryTimer = timer;
  }

  private clearRetry(state: ServerState): void {
    if (state.retryTimer) clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }

  private finishDisconnect(state: ServerState): void {
    unregisterServerToolsFromRegistry(state.config.id);
    state.tools = [];
    state.status = "disconnected";
    state.errorMessage = undefined;
    this.postStatusEvent(state);
  }

  private async closeLive(state: ServerState): Promise<void> {
    const live = state.live;
    state.live = null;
    if (!live) return;
    try {
      await live.close();
    } catch {
    }
  }
}

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


function freshServerState(config: McpServerConfig): ServerState {
  return {
    config: cloneConfig(config),
    status: "disconnected",
    tools: [],
    live: null,
    gate: Promise.resolve(),
    probeGeneration: 0,
    retryTimer: null,
    retryAttempt: 0,
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
  try {
    await client.connect(stdio);
  } catch (err) {
    await closeQuietly(client, stdio);
    throw err;
  }
  return {
    client,
    close: async () => {
      try {
        await client.close();
      } catch {
        try {
          await stdio.close();
        } catch {
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
    try {
      await client.connect(httpTransport as Parameters<Client["connect"]>[0]);
    } catch (err) {
      await closeQuietly(client, httpTransport);
      throw err;
    }
    return {
      client,
      close: async () => {
        try {
          await client.close();
        } catch {
          try {
            await httpTransport.close();
          } catch {
          }
        }
      },
    };
  } catch (streamableErr) {
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
            }
          }
        },
      };
    } catch (sseErr) {
      await closeQuietly(client, sseTransport);
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

async function closeQuietly(client: Client, transport: { close: () => Promise<void> }): Promise<void> {
  try {
    await client.close();
  } catch {
  }
  try {
    await transport.close();
  } catch {
  }
}

export const mcpManager = new McpManager();
