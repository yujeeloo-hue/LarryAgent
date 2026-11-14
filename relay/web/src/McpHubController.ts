/** MCP Hub controller — TokenHubController's state machine for MCP servers
 *  (no model detection / state probes: stdio transports can't be probed from
 *  the relay, HTTP probing is a deliberate later addition). */

export type McpTransportDraft =
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
  | { type: "http"; url: string; headers?: Record<string, string> };

export type McpHubPublicTransport =
  | { type: "stdio"; command: string; args?: string[]; cwd?: string; envKeys?: string[] }
  | { type: "http"; url: string; headerKeys?: string[] };

export type McpHubServer = {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpHubPublicTransport;
  secretConfigured: boolean;
  createdAt: number;
};

export type McpHubSnapshot = {
  status: "ready" | "loading" | "unavailable";
  statusDetail: string | null;
  servers: McpHubServer[];
  selectedServerId: string | null;
  deviceServerIds: Record<string, string[]>;
};

export type McpHubChange = "snapshot" | "server-order";

export type SyncMatch = "add" | "overwrite";

export type DeviceSyncMcpServer = {
  id: string;
  name: string;
  enabled: boolean;
  transport: { type: "stdio"; command: string; args?: string[]; cwd?: string } | { type: "http"; url: string };
  secretConfigured: boolean;
  status?: "connected" | "connecting" | "disconnected" | "error";
  toolCount?: number;
  errorMessage?: string;
  match: SyncMatch;
};

export type DeviceSyncMcpPending = "preview" | "push" | "pull" | "remove" | null;

export type DeviceMcpOperation = {
  status: "pending" | "done" | "failed";
  action?: SyncMatch;
  error?: string;
};

type DeviceMutation = "push" | "pull" | "remove";

type ServerSnapshot = {
  servers: McpHubServer[];
  deviceServerIds: Record<string, string[]>;
};

export type DeviceSyncMcpPreview = {
  deviceOnline: boolean;
  supportsSync: boolean;
  hubServers: Array<McpHubServer & { match: SyncMatch }>;
  deviceServers: DeviceSyncMcpServer[];
  snapshot: ServerSnapshot;
};

export type McpHubControllerOptions = {
  apiBase: () => string;
  sessionToken: () => string;
};

function cloneSnapshot(snapshot: McpHubSnapshot): McpHubSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as McpHubSnapshot;
}

function emptySnapshot(status: McpHubSnapshot["status"], detail: string | null): McpHubSnapshot {
  return {
    status,
    statusDetail: detail,
    servers: [],
    selectedServerId: null,
    deviceServerIds: {},
  };
}

function mcpMatchKey(name: string): string {
  return name.trim().toLowerCase();
}

function hasServerMatch(servers: Array<{ name: string }>, target: { name: string }): boolean {
  const key = mcpMatchKey(target.name);
  return servers.some((server) => mcpMatchKey(server.name) === key);
}

export class McpHubController {
  private snapshot = emptySnapshot("loading", null);
  private listeners = new Set<(change: McpHubChange) => void>();
  private serverOrderSaving = false;
  private syncPendingByDevice = new Map<string, DeviceSyncMcpPending>();
  private syncErrorByDevice = new Map<string, string | null>();
  private previewByDevice = new Map<string, DeviceSyncMcpPreview>();
  private previewRequests = new Map<string, Promise<DeviceSyncMcpPreview>>();
  private operations = new Map<string, DeviceMcpOperation>();
  private onlineByDevice = new Map<string, boolean>();
  private syncAnnouncements = new Map<string, string>();

  constructor(private readonly options: McpHubControllerOptions) {}

  getSnapshot(): McpHubSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  getSyncPending(deviceId: string): DeviceSyncMcpPending {
    return this.syncPendingByDevice.get(deviceId) ?? null;
  }

  getSyncError(deviceId: string): string | null {
    return this.syncErrorByDevice.get(deviceId) ?? null;
  }

  setDeviceOnline(deviceId: string, online: boolean): void {
    this.onlineByDevice.set(deviceId, online);
    const cached = this.previewByDevice.get(deviceId);
    if (cached && cached.deviceOnline !== online) {
      cached.deviceOnline = online;
      this.notify();
    }
  }

  getDeviceSyncPreview(deviceId: string): DeviceSyncMcpPreview | null {
    const cached = this.previewByDevice.get(deviceId);
    if (!cached) return null;
    const preview = JSON.parse(JSON.stringify(cached)) as DeviceSyncMcpPreview;
    if (this.onlineByDevice.get(deviceId) === false) preview.deviceOnline = false;
    // Matches describe identity, not equality of secrets or configuration.
    preview.deviceServers = preview.deviceServers.map((server) => ({
      ...server,
      match: hasServerMatch(this.snapshot.servers, server) ? "overwrite" : "add",
    }));
    preview.hubServers = this.snapshot.servers.map((server) => ({
      ...server,
      match: hasServerMatch(preview.deviceServers, server) ? "overwrite" : "add",
    }));
    return preview;
  }

  getDeviceOperation(deviceId: string, kind: DeviceMutation, serverId: string): DeviceMcpOperation | null {
    const operation = this.operations.get(this.operationKey(deviceId, kind, serverId));
    return operation ? { ...operation } : null;
  }

  getSyncAnnouncement(deviceId: string): string {
    return this.syncAnnouncements.get(deviceId) ?? "";
  }

  subscribe(listener: (change: McpHubChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  selectServer(serverId: string): void {
    if (!this.snapshot.servers.some((item) => item.id === serverId)) return;
    this.snapshot.selectedServerId = serverId;
    this.notify();
  }

  isServerOrderSaving(): boolean {
    return this.serverOrderSaving;
  }

  async reorderServers(serverIds: string[]): Promise<void> {
    if (this.serverOrderSaving) throw new Error("Server order is still saving.");
    const current = this.snapshot.servers.map((server) => server.id);
    const ids = new Set(serverIds);
    if (this.snapshot.status !== "ready" || serverIds.length !== current.length
      || ids.size !== current.length || current.some((id) => !ids.has(id))) {
      throw new Error("Servers changed. Refresh the list and try again.");
    }
    if (current.every((id, index) => id === serverIds[index])) return;
    this.serverOrderSaving = true;
    try {
      const result = await this.request<ServerSnapshot>("/servers/reorder", {
        method: "POST", body: JSON.stringify({ serverIds }),
      });
      this.serverOrderSaving = false;
      this.apply(result, undefined, "server-order");
    } finally {
      this.serverOrderSaving = false;
    }
  }

  async refresh(): Promise<void> {
    if (!this.options.sessionToken()) {
      this.snapshot = emptySnapshot("unavailable", "Sign in required.");
      this.notify();
      return;
    }
    try {
      this.apply(await this.request<ServerSnapshot>(""));
    } catch (err) {
      this.snapshot = emptySnapshot("unavailable", err instanceof Error ? err.message : String(err));
      this.notify();
    }
  }

  async addServer(input: {
    name: string;
    enabled?: boolean;
    transport: McpTransportDraft;
  }): Promise<void> {
    const created = await this.request<ServerSnapshot>("/servers", {
      method: "POST",
      body: JSON.stringify({ servers: [input] }),
    });
    const newest = created.servers[created.servers.length - 1]?.id;
    this.apply(created, newest);
  }

  async updateServer(
    serverId: string,
    patch: {
      name?: string;
      enabled?: boolean;
      transport?: McpTransportDraft;
    },
  ): Promise<void> {
    this.apply(await this.request<ServerSnapshot>(`/servers/${encodeURIComponent(serverId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }));
  }

  async removeServer(serverId: string): Promise<void> {
    this.apply(await this.request<ServerSnapshot>(`/servers/${encodeURIComponent(serverId)}`, {
      method: "DELETE",
    }));
  }

  loadDeviceSyncPreview(deviceId: string): Promise<DeviceSyncMcpPreview> {
    const inFlight = this.previewRequests.get(deviceId);
    if (inFlight) return inFlight;
    if (this.getSyncPending(deviceId)) return Promise.reject(new Error("A server operation is still running."));
    this.clearDeviceOperations(deviceId);
    const request = this.fetchDevicePreview(deviceId)
      .then(() => {
        this.setSyncState(deviceId, null, null);
        return this.getDeviceSyncPreview(deviceId)!;
      })
      .catch((err: unknown) => {
        this.setSyncState(deviceId, null, formatSyncError(err));
        throw err;
      })
      .finally(() => this.previewRequests.delete(deviceId));
    this.previewRequests.set(deviceId, request);
    this.setSyncState(deviceId, "preview", null);
    return request;
  }

  async pushServerToDevice(deviceId: string, serverId: string): Promise<{ action: SyncMatch }> {
    return this.mutateDevice(deviceId, "push", serverId, async () => {
      const result = await this.request<{ action: string; deviceServerId: string | null; snapshot: ServerSnapshot }>(
        `/devices/${encodeURIComponent(deviceId)}/push`,
        { method: "POST", body: JSON.stringify({ serverId }) },
      );
      this.apply(result.snapshot);
      const cached = this.previewByDevice.get(deviceId);
      const server = this.snapshot.servers.find((item) => item.id === serverId);
      if (cached && server && result.deviceServerId) {
        const existing = cached.deviceServers.findIndex((item) => item.id === result.deviceServerId);
        const transferred: DeviceSyncMcpServer = {
          id: result.deviceServerId,
          name: server.name,
          enabled: server.enabled,
          transport: server.transport.type === "stdio"
            ? {
                type: "stdio",
                command: server.transport.command,
                ...(server.transport.args ? { args: server.transport.args } : {}),
                ...(server.transport.cwd ? { cwd: server.transport.cwd } : {}),
              }
            : { type: "http", url: server.transport.url },
          secretConfigured: server.secretConfigured,
          status: "connecting",
          toolCount: 0,
          match: "overwrite",
        };
        if (existing >= 0) cached.deviceServers[existing] = transferred;
        else cached.deviceServers.push(transferred);
        this.operations.delete(this.operationKey(deviceId, "pull", result.deviceServerId));
      }
      return { action: result.action === "overwritten" ? "overwrite" : "add" };
    });
  }

  async pullServerFromDevice(deviceId: string, serverId: string): Promise<{ action: SyncMatch }> {
    return this.mutateDevice(deviceId, "pull", serverId, async () => {
      const result = await this.request<{ action: string; serverId: string; snapshot: ServerSnapshot }>(
        `/devices/${encodeURIComponent(deviceId)}/pull`,
        { method: "POST", body: JSON.stringify({ serverId }) },
      );
      this.apply(result.snapshot);
      return { action: result.action === "overwritten" ? "overwrite" : "add" };
    });
  }

  async removeServerFromDevice(deviceId: string, deviceServerId: string): Promise<void> {
    await this.mutateDevice(deviceId, "remove", deviceServerId, async () => {
      const result = await this.request<{ removed: boolean; snapshot: ServerSnapshot }>(
        `/devices/${encodeURIComponent(deviceId)}/remove`,
        { method: "POST", body: JSON.stringify({ serverId: deviceServerId }) },
      );
      this.apply(result.snapshot);
      const cached = this.previewByDevice.get(deviceId);
      const removed = cached?.deviceServers.find((item) => item.id === deviceServerId);
      if (cached) cached.deviceServers = cached.deviceServers.filter((item) => item.id !== deviceServerId);
      if (removed) for (const server of this.snapshot.servers) {
        if (hasServerMatch([removed], server)) this.operations.delete(this.operationKey(deviceId, "push", server.id));
      }
      this.operations.delete(this.operationKey(deviceId, "pull", deviceServerId));
      return {};
    });
  }

  private async fetchDevicePreview(deviceId: string): Promise<void> {
    const preview = await this.request<DeviceSyncMcpPreview>(`/devices/${encodeURIComponent(deviceId)}/sync-preview`);
    // An offline response has no device data; retain the last real list.
    if (preview.deviceOnline || !this.previewByDevice.has(deviceId)) this.previewByDevice.set(deviceId, preview);
    else this.previewByDevice.get(deviceId)!.deviceOnline = false;
    if (preview.snapshot) this.apply(preview.snapshot);
  }

  private async mutateDevice<T extends { action?: SyncMatch }>(
    deviceId: string, kind: DeviceMutation, serverId: string, work: () => Promise<T>,
  ): Promise<T> {
    if (this.getSyncPending(deviceId)) throw new Error("A server operation is still running.");
    const key = this.operationKey(deviceId, kind, serverId);
    const name = (kind === "push" ? this.snapshot.servers : this.previewByDevice.get(deviceId)?.deviceServers)
      ?.find((server) => server.id === serverId)?.name ?? "Server";
    this.syncAnnouncements.set(deviceId, `${kind === "push" ? "Adding" : kind === "pull" ? "Copying" : "Deleting"} ${name}…`);
    this.operations.set(key, { status: "pending" });
    this.setSyncState(deviceId, kind, null);
    let result: T;
    try {
      result = await work();
    } catch (err) {
      const message = formatSyncError(err);
      this.operations.set(key, { status: "failed", error: message });
      this.syncAnnouncements.set(deviceId, `${name}: ${message}`);
      this.setSyncState(deviceId, null, message);
      throw new Error(message);
    }
    // A failed read after a committed mutation must not invite a duplicate retry.
    let reloadError: string | null = null;
    try { await this.fetchDevicePreview(deviceId); }
    catch (err) { reloadError = `Change saved. Could not reload device MCP servers: ${formatSyncError(err)}`; }
    this.operations.set(key, { status: "done", action: result.action });
    this.syncAnnouncements.set(deviceId, `${kind === "push" ? (result.action === "overwrite" ? "Replaced" : "Added") : kind === "pull" ? "Copied to Relay:" : "Deleted"} ${name}.`);
    this.setSyncState(deviceId, null, reloadError);
    return result;
  }

  private operationKey(deviceId: string, kind: DeviceMutation, serverId: string): string {
    return JSON.stringify([deviceId, kind, serverId]);
  }

  private clearDeviceOperations(deviceId: string): void {
    for (const key of this.operations.keys()) {
      if ((JSON.parse(key) as string[])[0] === deviceId) this.operations.delete(key);
    }
  }

  private setSyncState(deviceId: string, pending: DeviceSyncMcpPending, error: string | null): void {
    this.syncPendingByDevice.set(deviceId, pending);
    this.syncErrorByDevice.set(deviceId, error);
    this.notify();
  }

  private apply(server: ServerSnapshot, selectId?: string, change: McpHubChange = "snapshot"): void {
    const selected = selectId ?? this.snapshot.selectedServerId;
    this.snapshot = {
      status: "ready",
      statusDetail: null,
      servers: server.servers,
      deviceServerIds: server.deviceServerIds ?? {},
      selectedServerId: server.servers.some((item) => item.id === selected)
        ? selected
        : server.servers[0]?.id ?? null,
    };
    this.notify(change);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.options.sessionToken();
    if (!token) throw new Error("Sign in required.");
    const res = await fetch(`${this.options.apiBase()}api/console/mcp-hub${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-auth-token": token,
      },
    });
    const data = await res.json().catch(() => ({})) as {
      error?: string;
      detail?: string;
    };
    if (!res.ok) {
      if (data.error === "device_update_required") {
        throw new Error(typeof data.detail === "string"
          ? data.detail
          : "Update this device to sync MCP servers remotely.");
      }
      const error = typeof data.error === "string" ? data.error : `Request failed (${res.status})`;
      throw new Error(typeof data.detail === "string" ? data.detail : error);
    }
    return data as T;
  }

  private notify(change: McpHubChange = "snapshot"): void {
    for (const listener of this.listeners) listener(change);
  }
}

function formatSyncError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
