export type TokenHubModel = {
  id: string;
  supportsMultimodal: boolean;
  multimodalSource: "detected" | "manual";
};

export type ProviderApiOptions = {
  apiProtocol?: "auto" | "chat_completions" | "responses";
  responsesTools?: Array<Record<string, unknown>>;
  responsesStateful?: boolean;
};

/** Keep query/hash values unchanged when normalizing a provider's path. */
export function normalizeProviderBaseUrl(baseUrl: string, rawEndpoint = false): string {
  const value = baseUrl.trim();
  if (rawEndpoint) return value;
  const at = value.search(/[?#]/);
  const path = at < 0 ? value : value.slice(0, at);
  return path.replace(/\/+$/, "") + (at < 0 ? "" : value.slice(at));
}

/** One client-equivalent LLM Provider. A detected model becomes its own provider. */
export type TokenHubProvider = ProviderApiOptions & {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  apiKeyConfigured: boolean;
  supportsMultimodal: boolean;
  multimodalSource: "detected" | "manual";
  imageInput: "url" | "base64" | "file";
  rawEndpoint?: boolean;
  createdAt: number;
};

export type TokenHubSnapshot = {
  status: "ready" | "loading" | "unavailable";
  statusDetail: string | null;
  providers: TokenHubProvider[];
  selectedProviderId: string | null;
  deviceProviderIds: Record<string, string[]>;
};

export type TokenHubChange = "snapshot" | "provider-order";

export type SyncMatch = "add" | "overwrite";

export type DeviceSyncProvider = ProviderApiOptions & {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  supportsMultimodal: boolean;
  imageInput: "url" | "base64" | "file";
  rawEndpoint: boolean;
  apiKeyConfigured: boolean;
  match: SyncMatch;
};

export type DeviceSyncPending = "preview" | "push" | "pull" | "remove" | null;

export type DeviceProviderOperation = {
  status: "pending" | "done" | "failed";
  action?: SyncMatch;
  error?: string;
};

type DeviceMutation = "push" | "pull" | "remove";

export type DetectedTokenHubModel = {
  id: string;
  supportsMultimodal: boolean;
};

/** Two-turn Responses state probe verdict; failures keep a machine reason. */
export type ProbeStateResult =
  | { ok: true; supported: boolean }
  | { ok: false; reason: string };

type ServerSnapshot = {
  providers: TokenHubProvider[];
  deviceProviderIds: Record<string, string[]>;
};

export type DeviceSyncPreview = {
  deviceOnline: boolean;
  supportsSync: boolean;
  hubProviders: Array<TokenHubProvider & { match: SyncMatch }>;
  deviceProviders: DeviceSyncProvider[];
  snapshot: ServerSnapshot;
};

export type TokenHubControllerOptions = {
  apiBase: () => string;
  sessionToken: () => string;
};

function cloneSnapshot(snapshot: TokenHubSnapshot): TokenHubSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as TokenHubSnapshot;
}

function providerName(modelId: string): string {
  const segment = modelId.split("/").pop() ?? modelId;
  return segment.trim() || modelId;
}

function emptySnapshot(status: TokenHubSnapshot["status"], detail: string | null): TokenHubSnapshot {
  return {
    status,
    statusDetail: detail,
    providers: [],
    selectedProviderId: null,
    deviceProviderIds: {},
  };
}

export class TokenHubController {
  private snapshot = emptySnapshot("loading", null);
  private listeners = new Set<(change: TokenHubChange) => void>();
  private providerOrderSaving = false;
  private syncPendingByDevice = new Map<string, DeviceSyncPending>();
  private syncErrorByDevice = new Map<string, string | null>();
  private previewByDevice = new Map<string, DeviceSyncPreview>();
  private previewRequests = new Map<string, Promise<DeviceSyncPreview>>();
  private operations = new Map<string, DeviceProviderOperation>();
  private onlineByDevice = new Map<string, boolean>();
  private syncAnnouncements = new Map<string, string>();

  constructor(private readonly options: TokenHubControllerOptions) {}

  getSnapshot(): TokenHubSnapshot {
    return cloneSnapshot(this.snapshot);
  }

  getSyncPending(deviceId: string): DeviceSyncPending {
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

  getDeviceSyncPreview(deviceId: string): DeviceSyncPreview | null {
    const cached = this.previewByDevice.get(deviceId);
    if (!cached) return null;
    const preview = JSON.parse(JSON.stringify(cached)) as DeviceSyncPreview;
    if (this.onlineByDevice.get(deviceId) === false) preview.deviceOnline = false;
    // Matches describe identity, not equality of credentials or configuration.
    preview.deviceProviders = preview.deviceProviders.map((provider) => ({
      ...provider,
      match: hasProviderMatch(this.snapshot.providers, provider) ? "overwrite" : "add",
    }));
    preview.hubProviders = this.snapshot.providers.map((provider) => ({
      ...provider,
      match: hasProviderMatch(preview.deviceProviders, provider) ? "overwrite" : "add",
    }));
    return preview;
  }

  getDeviceOperation(deviceId: string, kind: DeviceMutation, providerId: string): DeviceProviderOperation | null {
    const operation = this.operations.get(this.operationKey(deviceId, kind, providerId));
    return operation ? { ...operation } : null;
  }

  getSyncAnnouncement(deviceId: string): string {
    return this.syncAnnouncements.get(deviceId) ?? "";
  }

  subscribe(listener: (change: TokenHubChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  selectProvider(providerId: string): void {
    if (!this.snapshot.providers.some((item) => item.id === providerId)) return;
    this.snapshot.selectedProviderId = providerId;
    this.notify();
  }

  isProviderOrderSaving(): boolean {
    return this.providerOrderSaving;
  }

  async reorderProviders(providerIds: string[]): Promise<void> {
    if (this.providerOrderSaving) throw new Error("Provider order is still saving.");
    const current = this.snapshot.providers.map((provider) => provider.id);
    const ids = new Set(providerIds);
    if (this.snapshot.status !== "ready" || providerIds.length !== current.length
      || ids.size !== current.length || current.some((id) => !ids.has(id))) {
      throw new Error("Providers changed. Refresh the list and try again.");
    }
    if (current.every((id, index) => id === providerIds[index])) return;
    this.providerOrderSaving = true;
    try {
      const result = await this.request<ServerSnapshot>("/providers/reorder", {
        method: "POST", body: JSON.stringify({ providerIds }),
      });
      this.providerOrderSaving = false;
      this.apply(result, undefined, "provider-order");
    } finally {
      this.providerOrderSaving = false;
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

  async detectModels(baseUrl: string, apiKey: string): Promise<DetectedTokenHubModel[]> {
    // The relay owns detection: it probes the gateway's /models (with the
    // desktop wizard's retry order) and tags vision models by id. Doing it
    // server-side also avoids the CORS wall browsers hit on most gateways.
    const result = await this.request<ProbeResponse>("/detect-models", {
      method: "POST",
      body: JSON.stringify({ baseUrl, apiKey }),
    });
    if (!result.ok) {
      throw new Error(probeErrorMessage(result.reason ?? "network"));
    }
    return (result.models ?? []).map((model) => ({
      id: String(model.id ?? ""),
      supportsMultimodal: model.supportsMultimodal === true,
    })).filter((model) => model.id);
  }

  /** Probe an existing provider by id — the relay decrypts and uses the stored key. */
  async probeProviderState(providerId: string): Promise<ProbeStateResult> {
    return this.request(`/providers/${encodeURIComponent(providerId)}/probe-state`, { method: "POST" });
  }

  /** Probe wizard-form values before the provider exists. */
  async probeWizardState(input: { baseUrl: string; apiKey: string; modelId: string }): Promise<ProbeStateResult> {
    return this.request("/probe-responses-state", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async addProviders(input: ProviderApiOptions & { baseUrl: string; apiKey: string; models: TokenHubModel[]; rawEndpoint?: boolean }): Promise<void> {
    const baseUrl = normalizeProviderBaseUrl(input.baseUrl, input.rawEndpoint === true);
    const created = await this.request<ServerSnapshot>("/providers", {
      method: "POST",
      body: JSON.stringify({
        providers: input.models.map((model) => ({
          name: providerName(model.id),
          baseUrl,
          modelId: model.id,
          apiKey: input.apiKey,
          supportsMultimodal: model.supportsMultimodal,
          multimodalSource: model.multimodalSource,
          apiProtocol: input.apiProtocol,
          responsesTools: input.responsesTools,
          responsesStateful: input.responsesStateful,
          rawEndpoint: input.rawEndpoint === true,
          imageInput: isMoonshotProviderBaseUrl(baseUrl) ? "base64" : "url",
        })),
      }),
    });
    const newest = created.providers[created.providers.length - 1]?.id;
    this.apply(created, newest);
  }

  async updateProvider(
    providerId: string,
    patch: ProviderApiOptions & {
      rawEndpoint?: boolean;
      name?: string;
      modelId?: string;
      baseUrl?: string;
      apiKey?: string;
      imageInput?: "url" | "base64" | "file";
    },
  ): Promise<void> {
    this.apply(await this.request<ServerSnapshot>(`/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }));
  }

  async setMultimodal(providerId: string, enabled: boolean): Promise<void> {
    this.apply(await this.request<ServerSnapshot>(`/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ supportsMultimodal: enabled }),
    }));
  }

  async setImageInput(
    providerId: string,
    imageInput: "url" | "base64" | "file",
  ): Promise<void> {
    this.apply(await this.request<ServerSnapshot>(`/providers/${encodeURIComponent(providerId)}`, {
      method: "PATCH",
      body: JSON.stringify({ imageInput }),
    }));
  }

  async removeProvider(providerId: string): Promise<void> {
    this.apply(await this.request<ServerSnapshot>(`/providers/${encodeURIComponent(providerId)}`, {
      method: "DELETE",
    }));
  }

  async assignProvider(deviceId: string, providerId: string): Promise<void> {
    this.apply(await this.request<ServerSnapshot>(
      `/devices/${encodeURIComponent(deviceId)}/providers/${encodeURIComponent(providerId)}`,
      { method: "PUT" },
    ));
  }

  async unassignProvider(deviceId: string, providerId: string): Promise<void> {
    this.apply(await this.request<ServerSnapshot>(
      `/devices/${encodeURIComponent(deviceId)}/providers/${encodeURIComponent(providerId)}`,
      { method: "DELETE" },
    ));
  }

  loadDeviceSyncPreview(deviceId: string): Promise<DeviceSyncPreview> {
    const inFlight = this.previewRequests.get(deviceId);
    if (inFlight) return inFlight;
    if (this.getSyncPending(deviceId)) return Promise.reject(new Error("A provider operation is still running."));
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

  async pushProviderToDevice(deviceId: string, providerId: string): Promise<{ action: SyncMatch }> {
    return this.mutateDevice(deviceId, "push", providerId, async () => {
      const result = await this.request<{ action: string; deviceProviderId: string | null; snapshot: ServerSnapshot }>(
        `/devices/${encodeURIComponent(deviceId)}/push`,
        { method: "POST", body: JSON.stringify({ providerId }) },
      );
      this.apply(result.snapshot);
      const cached = this.previewByDevice.get(deviceId);
      const provider = this.snapshot.providers.find((item) => item.id === providerId);
      if (cached && provider && result.deviceProviderId) {
        const existing = cached.deviceProviders.findIndex((item) => item.id === result.deviceProviderId);
        const transferred: DeviceSyncProvider = {
          ...provider, id: result.deviceProviderId, rawEndpoint: provider.rawEndpoint === true, match: "overwrite",
        };
        if (existing >= 0) cached.deviceProviders[existing] = transferred;
        else cached.deviceProviders.push(transferred);
        this.operations.delete(this.operationKey(deviceId, "pull", result.deviceProviderId));
      }
      return { action: result.action === "overwritten" ? "overwrite" : "add" };
    });
  }

  async pullProviderFromDevice(deviceId: string, providerId: string): Promise<{ action: SyncMatch }> {
    return this.mutateDevice(deviceId, "pull", providerId, async () => {
      const result = await this.request<{ action: string; snapshot: ServerSnapshot }>(
        `/devices/${encodeURIComponent(deviceId)}/pull`,
        { method: "POST", body: JSON.stringify({ providerId }) },
      );
      this.apply(result.snapshot);
      return { action: result.action === "overwritten" ? "overwrite" : "add" };
    });
  }

  async removeProviderFromDevice(deviceId: string, deviceProviderId: string): Promise<void> {
    await this.mutateDevice(deviceId, "remove", deviceProviderId, async () => {
      const result = await this.request<{ removed: boolean; snapshot: ServerSnapshot }>(
        `/devices/${encodeURIComponent(deviceId)}/remove`,
        { method: "POST", body: JSON.stringify({ deviceProviderId }) },
      );
      this.apply(result.snapshot);
      const cached = this.previewByDevice.get(deviceId);
      const removed = cached?.deviceProviders.find((item) => item.id === deviceProviderId);
      if (cached) cached.deviceProviders = cached.deviceProviders.filter((item) => item.id !== deviceProviderId);
      if (removed) for (const provider of this.snapshot.providers) {
        if (hasProviderMatch([removed], provider)) this.operations.delete(this.operationKey(deviceId, "push", provider.id));
      }
      this.operations.delete(this.operationKey(deviceId, "pull", deviceProviderId));
      return {};
    });
  }

  private async fetchDevicePreview(deviceId: string): Promise<void> {
    const preview = await this.request<DeviceSyncPreview>(`/devices/${encodeURIComponent(deviceId)}/sync-preview`);
    // An offline response has no device data; retain the last real list.
    if (preview.deviceOnline || !this.previewByDevice.has(deviceId)) this.previewByDevice.set(deviceId, preview);
    else this.previewByDevice.get(deviceId)!.deviceOnline = false;
    if (preview.snapshot) this.apply(preview.snapshot);
  }

  private async mutateDevice<T extends { action?: SyncMatch }>(
    deviceId: string, kind: DeviceMutation, providerId: string, work: () => Promise<T>,
  ): Promise<T> {
    if (this.getSyncPending(deviceId)) throw new Error("A provider operation is still running.");
    const key = this.operationKey(deviceId, kind, providerId);
    const name = (kind === "push" ? this.snapshot.providers : this.previewByDevice.get(deviceId)?.deviceProviders)
      ?.find((provider) => provider.id === providerId)?.name ?? "Provider";
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
    catch (err) { reloadError = `Change saved. Could not reload device providers: ${formatSyncError(err)}`; }
    this.operations.set(key, { status: "done", action: result.action });
    this.syncAnnouncements.set(deviceId, `${kind === "push" ? (result.action === "overwrite" ? "Replaced" : "Added") : kind === "pull" ? "Copied to Relay:" : "Deleted"} ${name}.`);
    this.setSyncState(deviceId, null, reloadError);
    return result;
  }

  private operationKey(deviceId: string, kind: DeviceMutation, providerId: string): string {
    return JSON.stringify([deviceId, kind, providerId]);
  }

  private clearDeviceOperations(deviceId: string): void {
    for (const key of this.operations.keys()) {
      if ((JSON.parse(key) as string[])[0] === deviceId) this.operations.delete(key);
    }
  }

  private setSyncState(deviceId: string, pending: DeviceSyncPending, error: string | null): void {
    this.syncPendingByDevice.set(deviceId, pending);
    this.syncErrorByDevice.set(deviceId, error);
    this.notify();
  }

  private apply(server: ServerSnapshot, selectId?: string, change: TokenHubChange = "snapshot"): void {
    const selected = selectId ?? this.snapshot.selectedProviderId;
    this.snapshot = {
      status: "ready",
      statusDetail: null,
      providers: server.providers,
      deviceProviderIds: server.deviceProviderIds ?? {},
      selectedProviderId: server.providers.some((item) => item.id === selected)
        ? selected
        : server.providers[0]?.id ?? null,
    };
    this.notify(change);
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const token = this.options.sessionToken();
    if (!token) throw new Error("Sign in required.");
    const res = await fetch(`${this.options.apiBase()}api/console/token-hub${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        "x-auth-token": token,
      },
    });
    const data = await res.json().catch(() => ({})) as {
      error?: string;
      reason?: string;
      detail?: string;
    };
    if (!res.ok) {
      if (data.error === "device_update_required") {
        throw new Error(typeof data.detail === "string"
          ? data.detail
          : "Update this device to sync providers remotely.");
      }
      const reason = typeof data.reason === "string" ? data.reason : "";
      const detail = typeof data.detail === "string" ? data.detail : "";
      const error = typeof data.error === "string" ? data.error : `Request failed (${res.status})`;
      throw new Error(detail || (reason ? `${error}: ${reason}` : error));
    }
    return data as T;
  }

  private notify(change: TokenHubChange = "snapshot"): void {
    for (const listener of this.listeners) listener(change);
  }
}

function isMoonshotProviderBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    return host === "api.moonshot.cn"
      || host.endsWith(".moonshot.cn")
      || host === "api.moonshot.ai"
      || host.endsWith(".moonshot.ai")
      || host === "api.kimi.com"
      || host.endsWith(".kimi.com");
  } catch {
    return false;
  }
}

function formatSyncError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasProviderMatch(
  providers: Array<{ baseUrl: string; modelId: string }>,
  target: { baseUrl: string; modelId: string },
): boolean {
  const url = (value: string) => normalizeProviderBaseUrl(value).toLowerCase();
  return providers.some((provider) => url(provider.baseUrl) === url(target.baseUrl)
    && provider.modelId.trim() === target.modelId.trim());
}

/** Server shape for POST /detect-models (HTTP 200 in both outcomes). */
type ProbeResponse =
  | { ok: true; models?: Array<{ id?: unknown; supportsMultimodal?: unknown }> }
  | { ok: false; reason?: string };

/** Console-side mirror of the probe reason codes → user copy. */
function probeErrorMessage(reason: string): string {
  switch (reason) {
    case "invalid_url":
      return "Enter a valid http(s) base URL.";
    case "missing_key":
      return "API key required — local servers can leave it empty.";
    case "network":
      return "The relay could not reach that host — check the URL.";
    case "blocked_target":
      return "That address is off-limits for the relay (link-local or cloud metadata).";
    case "bad_payload":
    case "no_models":
      return "The gateway answered but listed no usable models — add the model ID below.";
    case "http_401":
      return "HTTP 401 Unauthorized — check the API key and try again.";
    case "http_403":
      return "HTTP 403 Forbidden — the key lacks access to this gateway.";
    case "http_404":
    case "http_405":
      return "No /models route on this gateway — append the API version (e.g. /v1) or add the model ID below.";
    case "http_429":
      return "HTTP 429 — rate limited, retry in a moment.";
    default: {
      const match = /^http_(\d+)$/.exec(reason);
      if (match) {
        const status = Number(match[1]);
        if (status >= 500) return `HTTP ${status} — gateway error, try again later.`;
        return `HTTP ${status} — detection failed.`;
      }
      return "Detection failed — try again or add the model ID below.";
    }
  }
}
