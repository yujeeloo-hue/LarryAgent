/**
 * Token Hub — AES-256-GCM secrets in SQLite, console API never returns the key.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createSessionToken } from "../src/auth.ts";
import { startRelay } from "../src/index.ts";
import { decryptTokenHubSecret, encryptTokenHubSecret } from "../src/tokenHubCipher.ts";
import { createTokenHubEndpoints } from "../src/tokenHubEndpoints.ts";
import { TokenHubStore } from "../src/tokenHubStore.ts";

const API_KEY = "sk-live-tokenhub-secret-do-not-store-plain";
const BASE_URL = "https://secret-gateway.example/v1";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "jellybot-token-hub-"));
}

describe("token hub cipher", () => {
  it("round-trips a secret and rejects a swapped provider id", () => {
    const key = randomBytes(32);
    const sealed = encryptTokenHubSecret(key, "provider-a", { apiKey: API_KEY, baseUrl: BASE_URL });
    assert.equal(decryptTokenHubSecret(key, "provider-a", sealed.nonce, sealed.cipherText).apiKey, API_KEY);
    assert.throws(() => decryptTokenHubSecret(key, "provider-b", sealed.nonce, sealed.cipherText));
  });
});

describe("token hub store", () => {
  it("keeps the API key and base URL out of the database file", () => {
    const dir = tempDataDir();
    const store = new TokenHubStore(dir);
    try {
      assert.equal(store.available, true);
      assert.equal(statSync(join(dir, "token-hub.key")).mode & 0o777, 0o600);
      const snapshot = store.addProviders([{
        name: "gpt-5",
        modelId: "gpt-5",
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        supportsMultimodal: true,
        multimodalSource: "detected",
      }]);
      assert.equal(snapshot.providers.length, 1);
      assert.equal(snapshot.providers[0]!.baseUrl, BASE_URL);
      assert.equal(snapshot.providers[0]!.apiKeyConfigured, true);
      assert.equal(snapshot.providers[0]!.imageInput, "url");
      assert.equal(snapshot.providers[0]!.rawEndpoint, false);
      assert.equal("apiKey" in snapshot.providers[0]!, false);
      const raw = readFileSync(store.dbPath);
      assert.equal(raw.includes(API_KEY), false);
      assert.equal(raw.includes(BASE_URL), false);
      assert.equal(raw.includes("secret-gateway.example"), false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upserts by Base URL + Model ID and exposes server-only transfers", () => {
    const dir = tempDataDir();
    const store = new TokenHubStore(dir);
    try {
      const created = store.addProviders([{
        name: "gpt-5",
        modelId: "gpt-5",
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        supportsMultimodal: false,
        multimodalSource: "detected",
      }]);
      const id = created.providers[0]!.id;
      const transfer = store.getTransfer(id);
      assert.equal(transfer.apiKey, API_KEY);
      assert.equal(transfer.baseUrl, BASE_URL);

      const overwritten = store.upsertByMatch({
        name: "GPT 5 Renamed",
        modelId: "gpt-5",
        baseUrl: `${BASE_URL}/`,
        apiKey: "sk-new-hub-key",
        supportsMultimodal: true,
        multimodalSource: "manual",
        imageInput: "base64",
        rawEndpoint: true,
      });
      assert.equal(overwritten.action, "overwritten");
      assert.equal(overwritten.providerId, id);
      const next = store.getTransfer(id);
      assert.equal(next.name, "GPT 5 Renamed");
      assert.equal(next.apiKey, "sk-new-hub-key");
      assert.equal(next.rawEndpoint, true);
      assert.equal(next.imageInput, "base64");
      assert.equal(readFileSync(store.dbPath).includes("sk-new-hub-key"), false);

      const added = store.upsertByMatch({
        name: "Claude",
        modelId: "claude-4-sonnet",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "",
        supportsMultimodal: true,
        multimodalSource: "manual",
      });
      assert.equal(added.action, "added");
      assert.notEqual(added.providerId, id);
      assert.equal(store.snapshot().providers.length, 2);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("token hub HTTP", () => {
  it("requires a session and never echoes the API key", async () => {
    const dataDir = tempDataDir();
    const relay = await startRelay({ port: 0, dataDir });
    try {
      const base = `http://127.0.0.1:${relay.port}`;
      const anon = await fetch(`${base}/api/console/token-hub`);
      assert.equal(anon.status, 401);

      const session = createSessionToken("tester");
      const headers = { "content-type": "application/json", "x-auth-token": session.token };
      const created = await fetch(`${base}/api/console/token-hub/providers`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          providers: [{
            name: "gpt-5",
            modelId: "gpt-5",
            baseUrl: BASE_URL,
            apiKey: API_KEY,
            supportsMultimodal: false,
            multimodalSource: "detected",
          }],
        }),
      });
      const createdBody = await created.json() as {
        providers: Array<{ id: string; apiKeyConfigured: boolean; baseUrl: string; supportsMultimodal: boolean }>;
      };
      assert.equal(created.status, 200);
      assert.equal(JSON.stringify(createdBody).includes(API_KEY), false);
      assert.equal(createdBody.providers[0]!.apiKeyConfigured, true);
      assert.equal(createdBody.providers[0]!.baseUrl, BASE_URL);

      const id = createdBody.providers[0]!.id;
      const patched = await (await fetch(`${base}/api/console/token-hub/providers/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ supportsMultimodal: true }),
      })).json() as { providers: Array<{ multimodalSource: string; supportsMultimodal: boolean }> };
      assert.equal(patched.providers[0]!.supportsMultimodal, true);
      assert.equal(patched.providers[0]!.multimodalSource, "manual");
      assert.equal(JSON.stringify(patched).includes(API_KEY), false);

      const kimi = await (await fetch(`${base}/api/console/token-hub/providers/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ baseUrl: "https://api.kimi.com/coding/v1" }),
      })).json() as { providers: Array<{ baseUrl: string; imageInput: string }> };
      assert.equal(kimi.providers[0]!.imageInput, "base64");

      const kimiFiles = await (await fetch(`${base}/api/console/token-hub/providers/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ imageInput: "file" }),
      })).json() as { providers: Array<{ imageInput: string }> };
      assert.equal(kimiFiles.providers[0]!.imageInput, "file");

      const renamed = await (await fetch(`${base}/api/console/token-hub/providers/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ name: "DeepSeek Chat" }),
      })).json() as { providers: Array<{ name: string; modelId: string }> };
      assert.equal(renamed.providers[0]!.name, "DeepSeek Chat");
      assert.equal(renamed.providers[0]!.modelId, "gpt-5");
      assert.equal(JSON.stringify(renamed).includes(API_KEY), false);

      const rotatedKey = "sk-rotated-tokenhub-secret";
      const keyed = await (await fetch(`${base}/api/console/token-hub/providers/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ apiKey: rotatedKey }),
      })).json() as { providers: Array<{ apiKeyConfigured: boolean }> };
      assert.equal(keyed.providers[0]!.apiKeyConfigured, true);
      assert.equal(JSON.stringify(keyed).includes(rotatedKey), false);
      assert.equal(JSON.stringify(keyed).includes(API_KEY), false);
      assert.equal(readFileSync(relay.tokenHub.dbPath).includes(rotatedKey), false);

      const edited = await (await fetch(`${base}/api/console/token-hub/providers/${id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ modelId: "deepseek-chat", baseUrl: "https://private-gateway.example/v1" }),
      })).json() as { providers: Array<{ modelId: string; baseUrl: string; imageInput: string }> };
      assert.equal(edited.providers[0]!.modelId, "deepseek-chat");
      assert.equal(edited.providers[0]!.baseUrl, "https://private-gateway.example/v1");
      assert.equal(edited.providers[0]!.imageInput, "url");
      assert.equal(readFileSync(relay.tokenHub.dbPath).includes("private-gateway.example"), false);
      assert.equal(JSON.stringify(edited).includes(rotatedKey), false);

      const assigned = await (await fetch(`${base}/api/console/token-hub/devices/dev-1/providers/${id}`, {
        method: "PUT",
        headers,
      })).json() as { deviceProviderIds: Record<string, string[]> };
      assert.deepEqual(assigned.deviceProviderIds["dev-1"], [id]);

      const listed = await (await fetch(`${base}/api/console/token-hub`, { headers })).json() as {
        providers: Array<{ id: string }>;
      };
      assert.equal(JSON.stringify(listed).includes(API_KEY), false);
      assert.equal(listed.providers[0]!.id, id);

      const removed = await (await fetch(`${base}/api/console/token-hub/providers/${id}`, {
        method: "DELETE",
        headers,
      })).json() as { providers: unknown[]; deviceProviderIds: Record<string, string[]> };
      assert.equal(removed.providers.length, 0);
      assert.equal(removed.deviceProviderIds["dev-1"], undefined);
    } finally {
      await relay.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("token hub device sync endpoints", () => {
  it("removes device-only and duplicate rows by their exact device id", async () => {
    const dir = tempDataDir();
    const store = new TokenHubStore(dir);
    const providers = new Map([
      ["first", { id: "first", name: "First", baseUrl: BASE_URL, modelId: "gpt-5" }],
      ["second", { id: "second", name: "Second", baseUrl: BASE_URL, modelId: "gpt-5" }],
      ["local", { id: "local", name: "Local only", baseUrl: "https://local.example/v1", modelId: "local" }],
      ["keep", { id: "keep", name: "Keep", baseUrl: "https://keep.example/v1", modelId: "keep" }],
    ]);
    const calls: Array<Record<string, unknown>> = [];
    const endpoints = createTokenHubEndpoints({
      tokenHub: store,
      isDeviceOnline: () => true,
      callDevice: async (_deviceId, action, payload) => {
        if (action === "listSyncProviders") return { providers: [...providers.values()] };
        if (action !== "removeSyncProvider") throw new Error(`Unexpected action: ${action}`);
        const body = payload as Record<string, unknown>;
        calls.push(body);
        const id = String(body.providerId ?? "");
        if (!providers.has(id)) return { removed: false };
        if (providers.size === 1) throw new Error("Cannot remove the last LLM provider on this device.");
        providers.delete(id);
        return { removed: true, id };
      },
    });
    const hubId = store.addProviders([{
      name: "Hub GPT", modelId: "gpt-5", baseUrl: BASE_URL, apiKey: API_KEY,
      supportsMultimodal: false, multimodalSource: "manual",
    }]).providers[0]!.id;
    store.assignProvider("dev-1", hubId);
    const server = createServer((req, res) => {
      void endpoints.handle(new URL(req.url ?? "/", "http://localhost").pathname, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const headers = { "content-type": "application/json", "x-auth-token": createSessionToken("tester").token };
    const remove = (body: unknown) => fetch(`${base}/api/console/token-hub/devices/dev-1/remove`, {
      method: "POST", headers, body: JSON.stringify(body),
    });
    try {
      const preview = await (await fetch(`${base}/api/console/token-hub/devices/dev-1/sync-preview`, { headers })).json() as {
        deviceProviders: Array<{ id: string }>;
      };
      assert.deepEqual(preview.deviceProviders.map((provider) => provider.id), ["first", "second", "local", "keep"]);

      assert.equal((await remove({ deviceProviderId: " ", providerId: hubId })).status, 400);
      assert.equal(calls.length, 0, "invalid device id never falls back to the Hub id");

      const local = await remove({ deviceProviderId: "local" });
      assert.equal(local.status, 200);
      assert.equal((await local.json() as { removed: boolean }).removed, true);
      assert.equal(providers.has("local"), false);
      assert.deepEqual(calls[0], {
        providerId: "local", baseUrl: "https://local.example/v1", modelId: "local",
      }, "unique rows include legacy metadata while new devices prefer the id");

      const second = await remove({ deviceProviderId: "second" });
      assert.equal(second.status, 200);
      await second.json();
      assert.equal(providers.has("second"), false);
      assert.equal(providers.has("first"), true, "same-endpoint peer survives");
      assert.deepEqual(calls[1], { providerId: "second" }, "duplicate identities never receive match-delete metadata");
      assert.deepEqual(store.snapshot().deviceProviderIds["dev-1"], [hubId]);

      const first = await remove({ deviceProviderId: "first" });
      assert.equal(first.status, 200);
      await first.json();
      assert.deepEqual(store.snapshot().deviceProviderIds["dev-1"] ?? [], []);

      const missing = await remove({ deviceProviderId: "second" });
      assert.equal(missing.status, 200);
      assert.equal((await missing.json() as { removed: boolean }).removed, false);
      const last = await remove({ deviceProviderId: "keep" });
      assert.equal(last.status, 400);
      assert.match((await last.json() as { error: string }).error, /last LLM provider/);
      assert.deepEqual([...providers.keys()], ["keep"]);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("deletes a freshly listed unique device-only row on legacy devices and protects the last row", async () => {
    const dir = tempDataDir();
    const store = new TokenHubStore(dir);
    const providers = new Map([
      ["local", { id: "local", name: "Local", baseUrl: BASE_URL, modelId: "gpt-5" }],
      ["keep", { id: "keep", name: "Keep", baseUrl: "https://keep.example/v1", modelId: "keep" }],
    ]);
    const calls: unknown[] = [];
    const endpoints = createTokenHubEndpoints({
      tokenHub: store,
      isDeviceOnline: () => true,
      callDevice: async (_deviceId, action, payload) => {
        if (action === "listSyncProviders") return { providers: [...providers.values()] };
        const body = payload as Record<string, unknown>;
        calls.push(body);
        // Older bridges ignore providerId and still require both match fields.
        if (!body.baseUrl || !body.modelId) throw new Error("baseUrl and modelId required");
        const target = [...providers.values()].find((provider) =>
          provider.baseUrl === body.baseUrl && provider.modelId === body.modelId);
        if (!target) return { removed: false };
        if (providers.size === 1) throw new Error("Cannot remove the last LLM provider on this device.");
        providers.delete(target.id);
        return { removed: true, id: target.id };
      },
    });
    const server = createServer((req, res) => {
      void endpoints.handle(new URL(req.url ?? "/", "http://localhost").pathname, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const headers = { "content-type": "application/json", "x-auth-token": createSessionToken("tester").token };
    const remove = (deviceProviderId: string) => fetch(`${base}/api/console/token-hub/devices/dev-1/remove`, {
      method: "POST", headers, body: JSON.stringify({ deviceProviderId }),
    });
    try {
      const response = await remove("local");
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { removed: boolean }).removed, true);
      assert.deepEqual([...providers.keys()], ["keep"]);
      assert.deepEqual(calls[0], { providerId: "local", baseUrl: BASE_URL, modelId: "gpt-5" });

      const last = await remove("keep");
      assert.equal(last.status, 400);
      assert.match((await last.json() as { error: string }).error, /last LLM provider/);
      assert.deepEqual([...providers.keys()], ["keep"]);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires an update for duplicate endpoint identities on legacy devices without falling back", async () => {
    const dir = tempDataDir();
    const store = new TokenHubStore(dir);
    const calls: unknown[] = [];
    const endpoints = createTokenHubEndpoints({
      tokenHub: store,
      isDeviceOnline: () => true,
      callDevice: async (_deviceId, action, payload) => {
        if (action === "listSyncProviders") {
          return { providers: [
            { id: "device-only", name: "Local", baseUrl: BASE_URL, modelId: "gpt-5" },
            { id: "same-endpoint", name: "Other", baseUrl: `${BASE_URL.toUpperCase()}/`, modelId: "gpt-5" },
          ] };
        }
        calls.push(payload);
        throw new Error("baseUrl and modelId required");
      },
    });
    const server = createServer((req, res) => {
      void endpoints.handle(new URL(req.url ?? "/", "http://localhost").pathname, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    try {
      const response = await fetch(`${base}/api/console/token-hub/devices/dev-1/remove`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-auth-token": createSessionToken("tester").token },
        body: JSON.stringify({ deviceProviderId: "device-only" }),
      });
      assert.equal(response.status, 409);
      assert.equal((await response.json() as { error: string }).error, "device_update_required");
      assert.deepEqual(calls, [{ providerId: "device-only" }]);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pushes and pulls one provider without returning API keys", async () => {
    const dir = tempDataDir();
    const store = new TokenHubStore(dir);
    const deviceProviders = new Map<string, {
      id: string;
      name: string;
      baseUrl: string;
      modelId: string;
      apiKey: string;
      supportsMultimodal: boolean;
      imageInput: "url" | "base64" | "file";
      rawEndpoint: boolean;
    }>();
    deviceProviders.set("dev-p1", {
      id: "dev-p1",
      name: "Device Claude",
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "claude-4-sonnet",
      apiKey: "sk-device-secret",
      supportsMultimodal: true,
      imageInput: "url",
      rawEndpoint: false,
    });

    const endpoints = createTokenHubEndpoints({
      tokenHub: store,
      isDeviceOnline: () => true,
      callDevice: async (_deviceId, action, payload) => {
        const body = (payload ?? {}) as Record<string, unknown>;
        if (action === "listSyncProviders") {
          return {
            providers: [...deviceProviders.values()].map((p) => ({
              id: p.id,
              name: p.name,
              baseUrl: p.baseUrl,
              modelId: p.modelId,
              supportsMultimodal: p.supportsMultimodal,
              imageInput: p.imageInput,
              rawEndpoint: p.rawEndpoint,
              apiKeyConfigured: p.apiKey.length > 0,
            })),
          };
        }
        if (action === "exportSyncProvider") {
          const id = String(body.providerId ?? "");
          const found = deviceProviders.get(id);
          if (!found) throw new Error("Provider not found.");
          return { ...found };
        }
        if (action === "upsertSyncProvider") {
          const baseUrl = String(body.baseUrl ?? "").replace(/\/+$/, "");
          const modelId = String(body.modelId ?? "");
          let existing = [...deviceProviders.values()].find(
            (p) => p.baseUrl === baseUrl && p.modelId === modelId,
          );
          const actionKind = existing ? "overwritten" : "added";
          if (!existing) {
            existing = {
              id: `dev-${deviceProviders.size + 1}`,
              name: String(body.name ?? ""),
              baseUrl,
              modelId,
              apiKey: "",
              supportsMultimodal: false,
              imageInput: "url",
              rawEndpoint: false,
            };
            deviceProviders.set(existing.id, existing);
          }
          existing.name = String(body.name ?? existing.name);
          existing.supportsMultimodal = body.supportsMultimodal === true;
          existing.imageInput = body.imageInput === "base64" || body.imageInput === "file" || body.imageInput === "url"
            ? body.imageInput
            : existing.imageInput;
          existing.rawEndpoint = body.rawEndpoint === true;
          if (typeof body.apiKey === "string" && body.apiKey.trim()) {
            existing.apiKey = body.apiKey.trim();
          }
          return { id: existing.id, action: actionKind };
        }
        if (action === "removeSyncProvider") {
          const baseUrl = String(body.baseUrl ?? "").replace(/\/+$/, "");
          const modelId = String(body.modelId ?? "");
          for (const [id, p] of deviceProviders) {
            if (p.baseUrl === baseUrl && p.modelId === modelId) {
              deviceProviders.delete(id);
              return { removed: true, id };
            }
          }
          return { removed: false };
        }
        throw new Error(`unknown action: ${action}`);
      },
    });

    const created = store.addProviders([{
      name: "Hub GPT",
      modelId: "gpt-5",
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      supportsMultimodal: true,
      multimodalSource: "manual",
    }]);
    const hubId = created.providers[0]!.id;
    const session = createSessionToken("tester");

    const server = createServer((req, res) => {
      void endpoints.handle(new URL(req.url ?? "/", "http://localhost").pathname, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const base = `http://127.0.0.1:${port}`;
    const headers = { "content-type": "application/json", "x-auth-token": session.token };

    try {
      const preview = await (await fetch(`${base}/api/console/token-hub/devices/dev-1/sync-preview`, { headers })).json() as {
        supportsSync: boolean;
        hubProviders: Array<{ id: string; match: string }>;
        deviceProviders: Array<{ id: string; match: string; apiKey?: string }>;
      };
      assert.equal(preview.supportsSync, true);
      assert.equal(preview.hubProviders[0]!.match, "add");
      assert.equal(preview.deviceProviders[0]!.match, "add");
      assert.equal("apiKey" in (preview.deviceProviders[0] ?? {}), false);

      const pushed = await (await fetch(`${base}/api/console/token-hub/devices/dev-1/push`, {
        method: "POST",
        headers,
        body: JSON.stringify({ providerId: hubId }),
      })).json() as { action: string; snapshot: { deviceProviderIds: Record<string, string[]> } };
      assert.equal(pushed.action, "added");
      assert.deepEqual(pushed.snapshot.deviceProviderIds["dev-1"], [hubId]);
      assert.equal([...deviceProviders.values()].some((p) => p.modelId === "gpt-5" && p.apiKey === API_KEY), true);
      assert.equal(JSON.stringify(pushed).includes(API_KEY), false);

      const pulled = await (await fetch(`${base}/api/console/token-hub/devices/dev-1/pull`, {
        method: "POST",
        headers,
        body: JSON.stringify({ providerId: "dev-p1" }),
      })).json() as { action: string; providerId: string; snapshot: { providers: Array<{ modelId: string; apiKey?: string }> } };
      assert.equal(pulled.action, "added");
      assert.equal(pulled.snapshot.providers.some((p) => p.modelId === "claude-4-sonnet"), true);
      assert.equal(JSON.stringify(pulled).includes("sk-device-secret"), false);

      const removed = await (await fetch(`${base}/api/console/token-hub/devices/dev-1/remove`, {
        method: "POST",
        headers,
        body: JSON.stringify({ providerId: hubId }),
      })).json() as { removed: boolean };
      assert.equal(removed.removed, true);
      assert.equal([...deviceProviders.values()].some((p) => p.modelId === "gpt-5"), false);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
