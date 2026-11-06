/**
 * Console Token Hub API. Session-token guarded. Responses include provider
 * metadata and whether a key is configured; they never include the API key.
 * Device push/pull orchestrates Relay-originated encrypted device RPC.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { verifySessionToken } from "./auth.js";
import { modelSupportsVision, probeLlmModels } from "./modelProbe.js";
import { probeResponsesState } from "./responsesStateProbe.js";
import { normalizeProviderApiOptions, type ProviderApiOptions } from "./providerApiOptions.js";
import type { DeviceAction } from "./protocol.js";
import {
  providerMatchKey,
  TokenHubOrderConflictError,
  TokenHubStore,
  type TokenHubProviderInput,
  type TokenHubPublicProvider,
  type TokenHubSnapshot,
} from "./tokenHubStore.js";

const MAX_BODY_BYTES = 256 * 1024;

type DeviceSyncProvider = ProviderApiOptions & {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  supportsMultimodal: boolean;
  imageInput: "url" | "base64" | "file";
  rawEndpoint: boolean;
  apiKeyConfigured: boolean;
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

function asProviderInput(value: unknown): TokenHubProviderInput | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.name !== "string" || typeof row.baseUrl !== "string" || typeof row.modelId !== "string") return null;
  if (typeof row.apiKey !== "string") return null;
  if (row.multimodalSource !== "detected" && row.multimodalSource !== "manual") return null;
  return {
    ...normalizeProviderApiOptions(row),
    name: row.name,
    baseUrl: row.baseUrl,
    modelId: row.modelId,
    apiKey: row.apiKey,
    supportsMultimodal: row.supportsMultimodal === true,
    multimodalSource: row.multimodalSource,
    ...(row.imageInput === "url" || row.imageInput === "base64" || row.imageInput === "file"
      ? { imageInput: row.imageInput }
      : {}),
    ...(row.rawEndpoint === true ? { rawEndpoint: true } : {}),
  };
}

function matchAction(
  source: { baseUrl: string; modelId: string },
  targets: Array<{ baseUrl: string; modelId: string }>,
): "add" | "overwrite" {
  const key = providerMatchKey(source.baseUrl, source.modelId);
  return targets.some((t) => providerMatchKey(t.baseUrl, t.modelId) === key) ? "overwrite" : "add";
}

function isUnsupportedSyncError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unknown action/i.test(message);
}

function auditProbe(
  deps: TokenHubEndpointDeps,
  session: { username: string },
  baseUrl: string,
  probe: { ok: true; supported: boolean } | { ok: false; reason: string },
): void {
  let host = "-";
  try {
    host = new URL(baseUrl.replace(/\/+$/, "")).host;
  } catch {
    // Keep "-" — an invalid URL must not echo the raw input.
  }
  deps.onAudit?.(
    session.username,
    "tokenHubProbeState",
    `${host} · ${probe.ok ? (probe.supported ? "stateful" : "stateless") : `failed: ${probe.reason}`}`,
  );
}

async function listDeviceProviders(
  callDevice: NonNullable<TokenHubEndpointDeps["callDevice"]>,
  deviceId: string,
): Promise<DeviceSyncProvider[]> {
  const result = await callDevice(deviceId, "listSyncProviders", {}) as {
    providers?: DeviceSyncProvider[];
  };
  return Array.isArray(result?.providers) ? result.providers : [];
}

type TokenHubEndpointDeps = {
  tokenHub: TokenHubStore;
  isDeviceOnline?: (deviceId: string) => boolean;
  callDevice?: (deviceId: string, action: DeviceAction, payload?: unknown) => Promise<unknown>;
  onAudit?: (actor: string, action: string, detail?: string) => void;
};

export function createTokenHubEndpoints(deps: TokenHubEndpointDeps): {
  handle(pathname: string, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
} {
  const prefix = "/api/console/token-hub";
  const sendSnapshot = (res: ServerResponse, snapshot: TokenHubSnapshot) => json(res, 200, snapshot);

  return {
    async handle(pathname, req, res) {
      if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
      const session = verifySessionToken(req.headers["x-auth-token"]);
      if (!session) {
        json(res, 401, { error: "invalid_session" });
        return true;
      }
      if (!deps.tokenHub.available) {
        json(res, 503, { error: "token_hub_unavailable", reason: deps.tokenHub.unavailableReason });
        return true;
      }
      try {
        if (req.method === "GET" && pathname === prefix) {
          sendSnapshot(res, deps.tokenHub.snapshot());
          return true;
        }
        // Real gateway enumeration. The API key is used only inside the probe
        // request and never reaches the audit line, the response, or a log.
        if (req.method === "POST" && pathname === `${prefix}/detect-models`) {
          const body = await readJsonBody(req);
          if (typeof body.baseUrl !== "string" || !body.baseUrl.trim()) {
            json(res, 400, { error: "invalid_base_url" });
            return true;
          }
          const baseUrl = body.baseUrl.trim();
          const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
          const probe = await probeLlmModels({ baseUrl, apiKey });
          let host = "-";
          try {
            host = new URL(baseUrl.replace(/\/+$/, "")).host;
          } catch {
            // Keep "-" — an invalid URL must not echo the raw input either.
          }
          if (!probe.ok) {
            deps.onAudit?.(session.username, "tokenHubDetect", `${host} · failed: ${probe.reason}`);
            json(res, 200, { ok: false, reason: probe.reason });
            return true;
          }
          deps.onAudit?.(
            session.username,
            "tokenHubDetect",
            `${host} · ${probe.models.length} models`,
          );
          json(res, 200, {
            ok: true,
            models: probe.models.map((id) => ({
              id,
              supportsMultimodal: modelSupportsVision(id),
            })),
          });
          return true;
        }
        // Wizard-form probe: the provider does not exist yet, so the target
        // comes from the request body. The key stays server-side.
        if (req.method === "POST" && pathname === `${prefix}/probe-responses-state`) {
          const body = await readJsonBody(req);
          if (typeof body.baseUrl !== "string" || !body.baseUrl.trim() ||
            typeof body.modelId !== "string" || !body.modelId.trim()) {
            json(res, 400, { error: "invalid_probe_input" });
            return true;
          }
          const probe = await probeResponsesState({
            baseUrl: body.baseUrl,
            modelId: body.modelId,
            apiKey: typeof body.apiKey === "string" ? body.apiKey : "",
            rawEndpoint: body.rawEndpoint === true,
            responsesTools: normalizeProviderApiOptions(body).responsesTools,
          });
          auditProbe(deps, session, body.baseUrl as string, probe);
          json(res, 200, probe);
          return true;
        }
        if (req.method === "POST" && pathname === `${prefix}/providers`) {
          const body = await readJsonBody(req);
          const providers: TokenHubProviderInput[] = [];
          if (!Array.isArray(body.providers)) {
            json(res, 400, { error: "invalid_providers" });
            return true;
          }
          for (const item of body.providers) {
            const parsed = asProviderInput(item);
            if (!parsed) {
              json(res, 400, { error: "invalid_providers" });
              return true;
            }
            providers.push(parsed);
          }
          const snapshot = deps.tokenHub.addProviders(providers);
          deps.onAudit?.(session.username, "tokenHubAdd", `added ${providers.length} providers`);
          sendSnapshot(res, snapshot);
          return true;
        }
        const providerProbeMatch = /^\/api\/console\/token-hub\/providers\/([^/]+)\/probe-state$/.exec(pathname);
        if (providerProbeMatch && req.method === "POST") {
          const providerId = decodeURIComponent(providerProbeMatch[1]!);
          let transfer: ReturnType<TokenHubStore["getTransfer"]>;
          try {
            transfer = deps.tokenHub.getTransfer(providerId);
          } catch {
            json(res, 404, { error: "provider not found" });
            return true;
          }
          const probe = await probeResponsesState({
            baseUrl: transfer.baseUrl,
            modelId: transfer.modelId,
            apiKey: transfer.apiKey,
            rawEndpoint: transfer.rawEndpoint === true,
            responsesTools: transfer.responsesTools,
          });
          auditProbe(deps, session, transfer.baseUrl, probe);
          json(res, 200, probe);
          return true;
        }
        if (req.method === "POST" && pathname === `${prefix}/providers/reorder`) {
          const body = await readJsonBody(req);
          if (!Array.isArray(body.providerIds) || body.providerIds.some((id) => typeof id !== "string" || !id.trim())) {
            json(res, 400, { error: "invalid_provider_order" });
            return true;
          }
          const snapshot = deps.tokenHub.reorderProviders(body.providerIds);
          deps.onAudit?.(session.username, "tokenHubReorder", `ordered ${body.providerIds.length} providers`);
          sendSnapshot(res, snapshot);
          return true;
        }
        const providerMatch = /^\/api\/console\/token-hub\/providers\/([^/]+)$/.exec(pathname);
        if (providerMatch) {
          const providerId = providerMatch[1]!;
          if (req.method === "PATCH") {
            const body = await readJsonBody(req);
            const hasName = typeof body.name === "string";
            const hasModelId = typeof body.modelId === "string";
            const hasBaseUrl = typeof body.baseUrl === "string";
            const hasApiKey = typeof body.apiKey === "string" && body.apiKey.trim().length > 0;
            const hasMultimodal = typeof body.supportsMultimodal === "boolean";
            const hasImageInput = body.imageInput === "url"
              || body.imageInput === "base64"
              || body.imageInput === "file";
            const hasRawEndpoint = typeof body.rawEndpoint === "boolean";
            const apiOptions = normalizeProviderApiOptions(body);
            const hasApiOptions = Object.keys(apiOptions).length > 0;
            if (!hasName && !hasModelId && !hasBaseUrl && !hasApiKey && !hasMultimodal && !hasImageInput && !hasRawEndpoint && !hasApiOptions) {
              json(res, 400, { error: "invalid_patch" });
              return true;
            }
            let snapshot = deps.tokenHub.snapshot();
            if (hasName) snapshot = deps.tokenHub.renameProvider(providerId, body.name as string);
            if (hasModelId) snapshot = deps.tokenHub.setModelId(providerId, body.modelId as string);
            if (hasRawEndpoint) snapshot = deps.tokenHub.setRawEndpoint(providerId, body.rawEndpoint === true);
            if (hasBaseUrl) snapshot = deps.tokenHub.setBaseUrl(providerId, body.baseUrl as string);
            if (hasApiKey) snapshot = deps.tokenHub.setApiKey(providerId, body.apiKey as string);
            if (hasMultimodal) snapshot = deps.tokenHub.setMultimodal(providerId, body.supportsMultimodal === true);
            if (hasImageInput) snapshot = deps.tokenHub.setImageInput(providerId, body.imageInput as string);
            if (hasApiOptions) snapshot = deps.tokenHub.setApiOptions(providerId, apiOptions);
            deps.onAudit?.(session.username, "tokenHubUpdate", providerId.slice(0, 8));
            sendSnapshot(res, snapshot);
            return true;
          }
          if (req.method === "DELETE") {
            sendSnapshot(res, deps.tokenHub.removeProvider(providerId));
            deps.onAudit?.(session.username, "tokenHubDelete", providerId.slice(0, 8));
            return true;
          }
        }

        const syncPreviewMatch = /^\/api\/console\/token-hub\/devices\/([^/]+)\/sync-preview$/.exec(pathname);
        if (syncPreviewMatch && req.method === "GET") {
          const deviceId = decodeURIComponent(syncPreviewMatch[1]!);
          const online = deps.isDeviceOnline?.(deviceId) === true;
          const hubProviders = deps.tokenHub.snapshot().providers;
          if (!online || !deps.callDevice) {
            json(res, 200, {
              deviceOnline: online,
              supportsSync: false,
              hubProviders: hubProviders.map((p) => ({ ...p, match: "add" as const })),
              deviceProviders: [] as Array<DeviceSyncProvider & { match: "add" | "overwrite" }>,
              snapshot: deps.tokenHub.snapshot(),
            });
            return true;
          }
          try {
            const deviceProviders = await listDeviceProviders(deps.callDevice, deviceId);
            json(res, 200, {
              deviceOnline: true,
              supportsSync: true,
              hubProviders: hubProviders.map((p) => ({
                ...p,
                match: matchAction(p, deviceProviders),
              })),
              deviceProviders: deviceProviders.map((p) => ({
                ...p,
                match: matchAction(p, hubProviders),
              })),
              snapshot: deps.tokenHub.snapshot(),
            });
          } catch (err) {
            if (isUnsupportedSyncError(err)) {
              json(res, 200, {
                deviceOnline: true,
                supportsSync: false,
                hubProviders: hubProviders.map((p) => ({ ...p, match: "add" as const })),
                deviceProviders: [],
                snapshot: deps.tokenHub.snapshot(),
              });
              return true;
            }
            throw err;
          }
          return true;
        }

        const syncPushMatch = /^\/api\/console\/token-hub\/devices\/([^/]+)\/push$/.exec(pathname);
        if (syncPushMatch && req.method === "POST") {
          const deviceId = decodeURIComponent(syncPushMatch[1]!);
          if (!deps.callDevice || deps.isDeviceOnline?.(deviceId) !== true) {
            json(res, 409, { error: "device offline" });
            return true;
          }
          const body = await readJsonBody(req);
          const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
          if (!providerId) {
            json(res, 400, { error: "providerId required" });
            return true;
          }
          const transfer = deps.tokenHub.getTransfer(providerId);
          const result = await deps.callDevice(deviceId, "upsertSyncProvider", {
            ...normalizeProviderApiOptions(transfer),
            name: transfer.name,
            baseUrl: transfer.baseUrl,
            modelId: transfer.modelId,
            apiKey: transfer.apiKey,
            supportsMultimodal: transfer.supportsMultimodal,
            imageInput: transfer.imageInput,
            rawEndpoint: transfer.rawEndpoint,
          }) as { id?: string; action?: string };
          const snapshot = deps.tokenHub.assignProvider(deviceId, providerId);
          deps.onAudit?.(
            session.username,
            "tokenHubPush",
            `${deviceId} · ${providerId.slice(0, 8)} · ${result.action ?? "ok"}`,
          );
          json(res, 200, {
            action: result.action === "overwritten" ? "overwritten" : "added",
            deviceProviderId: typeof result.id === "string" ? result.id : null,
            snapshot,
          });
          return true;
        }

        const syncPullMatch = /^\/api\/console\/token-hub\/devices\/([^/]+)\/pull$/.exec(pathname);
        if (syncPullMatch && req.method === "POST") {
          const deviceId = decodeURIComponent(syncPullMatch[1]!);
          if (!deps.callDevice || deps.isDeviceOnline?.(deviceId) !== true) {
            json(res, 409, { error: "device offline" });
            return true;
          }
          const body = await readJsonBody(req);
          const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
          if (!providerId) {
            json(res, 400, { error: "providerId required" });
            return true;
          }
          const exported = await deps.callDevice(deviceId, "exportSyncProvider", { providerId }) as {
            name?: string;
            baseUrl?: string;
            modelId?: string;
            apiKey?: string;
            supportsMultimodal?: boolean;
            imageInput?: "url" | "base64" | "file";
            rawEndpoint?: boolean;
          };
          if (typeof exported?.name !== "string" || typeof exported.baseUrl !== "string" || typeof exported.modelId !== "string") {
            json(res, 400, { error: "invalid device provider export" });
            return true;
          }
          const upserted = deps.tokenHub.upsertByMatch({
            ...normalizeProviderApiOptions(exported),
            name: exported.name,
            baseUrl: exported.baseUrl,
            modelId: exported.modelId,
            apiKey: typeof exported.apiKey === "string" ? exported.apiKey : "",
            supportsMultimodal: exported.supportsMultimodal === true,
            multimodalSource: "manual",
            imageInput: exported.imageInput === "base64" || exported.imageInput === "file" || exported.imageInput === "url"
              ? exported.imageInput
              : undefined,
            rawEndpoint: exported.rawEndpoint === true,
          });
          const snapshot = deps.tokenHub.assignProvider(deviceId, upserted.providerId);
          deps.onAudit?.(
            session.username,
            "tokenHubPull",
            `${deviceId} · ${upserted.providerId.slice(0, 8)} · ${upserted.action}`,
          );
          json(res, 200, {
            action: upserted.action,
            providerId: upserted.providerId,
            snapshot,
          });
          return true;
        }

        const syncRemoveMatch = /^\/api\/console\/token-hub\/devices\/([^/]+)\/remove$/.exec(pathname);
        if (syncRemoveMatch && req.method === "POST") {
          const deviceId = decodeURIComponent(syncRemoveMatch[1]!);
          if (!deps.callDevice || deps.isDeviceOnline?.(deviceId) !== true) {
            json(res, 409, { error: "device offline" });
            return true;
          }
          const body = await readJsonBody(req);
          if (Object.prototype.hasOwnProperty.call(body, "deviceProviderId")) {
            const deviceProviderId = typeof body.deviceProviderId === "string" ? body.deviceProviderId.trim() : "";
            if (!deviceProviderId) {
              json(res, 400, { error: "deviceProviderId required" });
              return true;
            }
            const deviceProviders = await listDeviceProviders(deps.callDevice, deviceId);
            const target = deviceProviders.find((provider) => provider.id === deviceProviderId);
            if (!target) {
              json(res, 200, { removed: false, deviceProviderId, snapshot: deps.tokenHub.snapshot() });
              return true;
            }
            const targetKey = providerMatchKey(target.baseUrl, target.modelId);
            const uniqueMatch = deviceProviders.filter((provider) =>
              providerMatchKey(provider.baseUrl, provider.modelId) === targetKey).length === 1;
            let removed: { removed?: boolean; id?: string };
            try {
              // New devices prefer the id. Legacy devices can use the freshly
              // listed endpoint only when it identifies exactly this one row.
              // Ambiguous matches stay id-only and require an updated device.
              removed = await deps.callDevice(deviceId, "removeSyncProvider", {
                providerId: deviceProviderId,
                ...(uniqueMatch ? { baseUrl: target.baseUrl, modelId: target.modelId } : {}),
              }) as { removed?: boolean; id?: string };
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              if (/baseUrl and modelId required|provider removal by id unavailable/i.test(message)) {
                json(res, 409, {
                  error: "device_update_required",
                  detail: "Update this device to delete providers by their device ID.",
                });
                return true;
              }
              throw err;
            }
            let snapshot = deps.tokenHub.snapshot();
            // Keep legacy Hub associations while a same-endpoint device row
            // remains. The actual device list is authoritative for this UI.
            if (removed.removed === true && !deviceProviders.some((provider) =>
              provider.id !== deviceProviderId && providerMatchKey(provider.baseUrl, provider.modelId) === targetKey)) {
              for (const provider of snapshot.providers) {
                if (providerMatchKey(provider.baseUrl, provider.modelId) === targetKey) {
                  snapshot = deps.tokenHub.unassignProvider(deviceId, provider.id);
                }
              }
            }
            deps.onAudit?.(
              session.username,
              "tokenHubRemoveFromDevice",
              `${deviceId} · ${deviceProviderId.slice(0, 8)} · ${removed.removed ? "removed" : "missing"}`,
            );
            json(res, 200, { removed: removed.removed === true, deviceProviderId, snapshot });
            return true;
          }
          const providerId = typeof body.providerId === "string" ? body.providerId.trim() : "";
          if (!providerId) {
            json(res, 400, { error: "providerId required" });
            return true;
          }
          const transfer = deps.tokenHub.getTransfer(providerId);
          const removed = await deps.callDevice(deviceId, "removeSyncProvider", {
            baseUrl: transfer.baseUrl,
            modelId: transfer.modelId,
          }) as { removed?: boolean };
          const snapshot = deps.tokenHub.unassignProvider(deviceId, providerId);
          deps.onAudit?.(
            session.username,
            "tokenHubRemoveFromDevice",
            `${deviceId} · ${providerId.slice(0, 8)} · ${removed.removed ? "removed" : "missing"}`,
          );
          json(res, 200, {
            removed: removed.removed === true,
            snapshot,
          });
          return true;
        }

        const assignMatch = /^\/api\/console\/token-hub\/devices\/([^/]+)\/providers\/([^/]+)$/.exec(pathname);
        if (assignMatch && (req.method === "PUT" || req.method === "DELETE")) {
          const deviceId = assignMatch[1]!;
          const providerId = assignMatch[2]!;
          const snapshot = req.method === "PUT"
            ? deps.tokenHub.assignProvider(deviceId, providerId)
            : deps.tokenHub.unassignProvider(deviceId, providerId);
          deps.onAudit?.(
            session.username,
            req.method === "PUT" ? "tokenHubAssign" : "tokenHubUnassign",
            `${deviceId} · ${providerId.slice(0, 8)}`,
          );
          sendSnapshot(res, snapshot);
          return true;
        }
        json(res, 404, { error: "not_found" });
      } catch (err) {
        const message = err instanceof Error ? err.message : "token hub request failed";
        if (err instanceof TokenHubOrderConflictError) {
          json(res, 409, { error: "provider_order_conflict", detail: message });
          return true;
        }
        if (isUnsupportedSyncError(err)) {
          json(res, 409, {
            error: "device_update_required",
            detail: "Update this device to sync providers remotely.",
          });
          return true;
        }
        const status = /not found/i.test(message)
          ? 404
          : /unavailable|offline|timeout/i.test(message)
            ? 409
            : /unavailable/i.test(message)
              ? 503
              : 400;
        json(res, status, { error: message });
      }
      return true;
    },
  };
}

export type { TokenHubPublicProvider };
