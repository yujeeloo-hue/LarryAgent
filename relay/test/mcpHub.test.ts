/**
 * MCP Hub — AES-256-GCM transports in SQLite, console API never returns
 * env/header values; device push/pull mirror the Token Hub flows.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createSessionToken } from "../src/auth.ts";
import { decryptHubSecret, encryptHubSecret } from "../src/tokenHubCipher.ts";
import { createMcpHubEndpoints } from "../src/mcpHubEndpoints.ts";
import { McpHubStore, normalizeMcpHubTransport } from "../src/mcpHubStore.ts";

const ENV_VALUE = "super-secret-env-value-do-not-store-plain";
const HEADER_VALUE = "Bearer super-secret-header-value";
const COMMAND = "npx";
const MCP_URL = "https://mcp.example.com/mcp";

function tempDataDir(): string {
  return mkdtempSync(join(tmpdir(), "jellybot-mcp-hub-"));
}

describe("mcp hub cipher", () => {
  it("round-trips a scoped secret and rejects cross-scope or swapped-id decryption", () => {
    const key = randomBytes(32);
    const sealed = encryptHubSecret(key, "mcp-hub", "server-a", ENV_VALUE);
    assert.equal(decryptHubSecret(key, "mcp-hub", "server-a", sealed.nonce, sealed.cipherText), ENV_VALUE);
    // Token-hub scope ciphertext is not readable as mcp-hub (AAD binding).
    const tokenSealed = encryptHubSecret(key, "token-hub", "server-a", ENV_VALUE);
    assert.throws(() => decryptHubSecret(key, "mcp-hub", "server-a", tokenSealed.nonce, tokenSealed.cipherText));
    assert.throws(() => decryptHubSecret(key, "mcp-hub", "server-b", sealed.nonce, sealed.cipherText));
  });
});

describe("mcp hub transport normalization", () => {
  it("trims commands/args and rejects unusable transports", () => {
    const stdio = normalizeMcpHubTransport({
      type: "stdio", command: "  npx  ", args: [" -y ", "", "server"], env: { A: "1", " ": "drop", B: 2 as unknown as string },
    });
    assert.deepEqual(stdio, { type: "stdio", command: "npx", args: ["-y", "server"], env: { A: "1" } });
    const http = normalizeMcpHubTransport({ type: "http", url: ` ${MCP_URL} `, headers: { "x-api-key": "k" } });
    assert.deepEqual(http, { type: "http", url: MCP_URL, headers: { "x-api-key": "k" } });
    assert.throws(() => normalizeMcpHubTransport({ type: "stdio", command: "" }));
    assert.throws(() => normalizeMcpHubTransport({ type: "stdio" }));
    assert.throws(() => normalizeMcpHubTransport({ type: "http", url: "not a url" }));
    assert.throws(() => normalizeMcpHubTransport({ type: "ssh" }));
    assert.throws(() => normalizeMcpHubTransport(null));
  });
});

describe("mcp hub store", () => {
  it("keeps env/header values out of the database file", () => {
    const dir = tempDataDir();
    const store = new McpHubStore(dir);
    try {
      assert.equal(store.available, true);
      assert.equal(statSync(join(dir, "mcp-hub.key")).mode & 0o777, 0o600);
      const snapshot = store.addServers([
        { name: "filesystem", transport: { type: "stdio", command: COMMAND, env: { FS_KEY: ENV_VALUE } } },
        { name: "remote", enabled: false, transport: { type: "http", url: MCP_URL, headers: { Authorization: HEADER_VALUE } } },
      ]);
      assert.equal(snapshot.servers.length, 2);
      const [stdio, http] = snapshot.servers;
      assert.deepEqual(stdio!.transport, { type: "stdio", command: COMMAND, envKeys: ["FS_KEY"] });
      assert.equal(stdio!.secretConfigured, true);
      assert.equal(stdio!.enabled, true);
      assert.deepEqual(http!.transport, { type: "http", url: MCP_URL, headerKeys: ["Authorization"] });
      assert.equal(http!.enabled, false);
      const raw = readFileSync(store.dbPath);
      assert.equal(raw.includes(ENV_VALUE), false);
      assert.equal(raw.includes(HEADER_VALUE), false);
      const transfer = store.getTransfer(stdio!.id);
      assert.deepEqual(transfer.transport.env, { FS_KEY: ENV_VALUE });
      assert.equal(JSON.stringify(snapshot).includes(ENV_VALUE), false);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("upserts by name and reorders atomically", () => {
    const dir = tempDataDir();
    const store = new McpHubStore(dir);
    try {
      const first = store.addServers([{ name: "Alpha", transport: { type: "stdio", command: "a" } }]);
      const alphaId = first.servers[0]!.id;
      const upserted = store.upsertByMatch({
        name: "ALPHA ", enabled: false, transport: { type: "http", url: MCP_URL },
      });
      assert.equal(upserted.action, "overwritten");
      assert.equal(upserted.serverId, alphaId);
      const transfer = store.getTransfer(alphaId);
      assert.equal(transfer.enabled, false);
      assert.equal(transfer.transport.type, "http");

      const added = store.upsertByMatch({ name: "Beta", transport: { type: "stdio", command: "b" } });
      assert.equal(added.action, "added");

      const reordered = store.reorderServers([...store.snapshot().servers.map((s) => s.id)].reverse());
      assert.equal(reordered.servers.map((s) => s.name).join(","), "Beta,ALPHA");

      assert.throws(() => store.reorderServers([alphaId]), /Servers changed/);
      assert.throws(() => store.reorderServers([alphaId, alphaId]), /duplicate/);

      store.removeServer(alphaId);
      assert.equal(store.snapshot().servers.length, 1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("associates devices and survives restart", () => {
    const dir = tempDataDir();
    const first = new McpHubStore(dir);
    const snapshot = first.addServers([{ name: "Keep", transport: { type: "stdio", command: "k", env: { K: ENV_VALUE } } }]);
    const id = snapshot.servers[0]!.id;
    first.assignServer("dev-1", id);
    first.reorderServers([id]);
    first.close();
    const second = new McpHubStore(dir);
    try {
      const restored = second.snapshot();
      assert.deepEqual(restored.deviceServerIds["dev-1"], [id]);
      assert.deepEqual(restored.servers[0]!.transport, { type: "stdio", command: "k", envKeys: ["K"] });
      assert.deepEqual(second.getTransfer(id).transport.env, { K: ENV_VALUE });
    } finally {
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mcp hub endpoints", () => {
  it("requires a session token and never echoes secrets on snapshot", async () => {
    const dir = tempDataDir();
    const store = new McpHubStore(dir);
    store.addServers([{ name: "filesystem", transport: { type: "stdio", command: COMMAND, env: { FS_KEY: ENV_VALUE } } }]);
    const endpoints = createMcpHubEndpoints({ mcpHub: store });
    const server = createServer((req, res) => {
      void endpoints.handle(new URL(req.url ?? "/", "http://localhost").pathname, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    try {
      const anon = await fetch(`${base}/api/console/mcp-hub`);
      assert.equal(anon.status, 401);
      const headers = { "content-type": "application/json", "x-auth-token": createSessionToken("tester").token };
      const snapshot = await (await fetch(`${base}/api/console/mcp-hub`, { headers })).text();
      assert.equal(snapshot.includes(ENV_VALUE), false);
      assert.equal(snapshot.includes("envKeys"), true);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adds, patches with blank-to-keep env values, and deletes servers", async () => {
    const dir = tempDataDir();
    const store = new McpHubStore(dir);
    const endpoints = createMcpHubEndpoints({ mcpHub: store });
    const server = createServer((req, res) => {
      void endpoints.handle(new URL(req.url ?? "/", "http://localhost").pathname, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const headers = { "content-type": "application/json", "x-auth-token": createSessionToken("tester").token };
    try {
      const created = await (await fetch(`${base}/api/console/mcp-hub/servers`, {
        method: "POST", headers,
        body: JSON.stringify({ servers: [{ name: "filesystem", transport: { type: "stdio", command: COMMAND, env: { FS_KEY: ENV_VALUE } } }] }),
      })).json() as { servers: Array<{ id: string }> };
      const id = created.servers[0]!.id;

      // Blank env value keeps the stored secret; other fields update.
      const patched = await (await fetch(`${base}/api/console/mcp-hub/servers/${id}`, {
        method: "PATCH", headers,
        body: JSON.stringify({ transport: { type: "stdio", command: "uvx", env: { FS_KEY: "" } } }),
      })).json() as { servers: Array<{ transport: { envKeys?: string[] } }> };
      assert.deepEqual(patched.servers[0]!.transport.envKeys, ["FS_KEY"]);
      const transfer = store.getTransfer(id);
      assert.deepEqual(transfer.transport.env, { FS_KEY: ENV_VALUE });
      assert.equal(transfer.transport.command, "uvx");

      // Dropping the env key entirely clears it.
      await fetch(`${base}/api/console/mcp-hub/servers/${id}`, {
        method: "PATCH", headers,
        body: JSON.stringify({ transport: { type: "stdio", command: "uvx" } }),
      });
      assert.deepEqual(store.getTransfer(id).transport.env, undefined);

      const invalid = await fetch(`${base}/api/console/mcp-hub/servers`, {
        method: "POST", headers,
        body: JSON.stringify({ servers: [{ name: "bad", transport: { type: "stdio", command: "" } }] }),
      });
      assert.equal(invalid.status, 400);

      const missing = await fetch(`${base}/api/console/mcp-hub/servers/nope`, {
        method: "DELETE", headers,
      });
      assert.equal(missing.status, 404);

      const deleted = await fetch(`${base}/api/console/mcp-hub/servers/${id}`, { method: "DELETE", headers });
      assert.equal(deleted.status, 200);
      assert.equal(store.snapshot().servers.length, 0);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("previews, pushes, pulls and removes device MCP servers", async () => {
    const dir = tempDataDir();
    const store = new McpHubStore(dir);
    const deviceServers = new Map<string, {
      id: string; name: string; enabled: boolean;
      transport: Record<string, unknown>;
    }>();
    deviceServers.set("dev-s1", {
      id: "dev-s1", name: "Device Search", enabled: true,
      transport: { type: "http", url: "https://search.example/mcp", headers: { Authorization: HEADER_VALUE } },
    });
    const calls: Array<[string, unknown]> = [];
    let online = true;
    const endpoints = createMcpHubEndpoints({
      mcpHub: store,
      isDeviceOnline: () => online,
      callDevice: async (_deviceId, action, payload) => {
        const body = (payload ?? {}) as Record<string, unknown>;
        calls.push([action, body]);
        if (action === "listSyncMcpServers") {
          return {
            servers: [...deviceServers.values()].map((s) => ({
              id: s.id, name: s.name, enabled: s.enabled,
              transport: { type: s.transport.type, command: s.transport.command, url: s.transport.url },
              secretConfigured: true, status: "connected", toolCount: 7,
            })),
          };
        }
        if (action === "exportSyncMcpServer") {
          const found = deviceServers.get(String(body.serverId ?? ""));
          if (!found) throw new Error("MCP server not found.");
          return { name: found.name, enabled: found.enabled, transport: found.transport };
        }
        if (action === "upsertSyncMcpServer") {
          const name = String(body.name ?? "");
          let existing = [...deviceServers.values()].find((s) => s.name.toLowerCase() === name.toLowerCase());
          const actionKind = existing ? "overwritten" : "added";
          if (!existing) {
            existing = { id: `dev-s${deviceServers.size + 1}`, name, enabled: body.enabled !== false, transport: {} };
            deviceServers.set(existing.id, existing);
          }
          existing.enabled = body.enabled !== false;
          existing.transport = body.transport as Record<string, unknown>;
          return { id: existing.id, action: actionKind };
        }
        if (action === "removeSyncMcpServer") {
          const found = deviceServers.get(String(body.serverId ?? ""));
          if (!found) return { removed: false };
          deviceServers.delete(found.id);
          return { removed: true, id: found.id };
        }
        throw new Error(`unknown action: ${action}`);
      },
    });
    const created = store.addServers([
      { name: "Hub Files", transport: { type: "stdio", command: COMMAND, args: ["-y", "fs"], env: { FS_KEY: ENV_VALUE } } },
    ]);
    const hubId = created.servers[0]!.id;
    const server = createServer((req, res) => {
      void endpoints.handle(new URL(req.url ?? "/", "http://localhost").pathname, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const headers = { "content-type": "application/json", "x-auth-token": createSessionToken("tester").token };
    try {
      const preview = await (await fetch(`${base}/api/console/mcp-hub/devices/dev-1/sync-preview`, { headers })).json() as {
        supportsSync: boolean;
        hubServers: Array<{ id: string; match: string }>;
        deviceServers: Array<{ id: string; match: string; errorMessage?: string; toolCount?: number }>;
      };
      assert.equal(preview.supportsSync, true);
      assert.equal(preview.hubServers[0]!.match, "add");
      assert.equal(preview.deviceServers[0]!.match, "add");
      assert.equal(preview.deviceServers[0]!.toolCount, 7);

      const pushed = await (await fetch(`${base}/api/console/mcp-hub/devices/dev-1/push`, {
        method: "POST", headers, body: JSON.stringify({ serverId: hubId }),
      })).json() as { action: string; deviceServerId: string; snapshot: { deviceServerIds: Record<string, string[]> } };
      assert.equal(pushed.action, "added");
      assert.deepEqual(pushed.snapshot.deviceServerIds["dev-1"], [hubId]);
      const deviceCopy = [...deviceServers.values()].find((s) => s.name === "Hub Files")!;
      assert.deepEqual((deviceCopy.transport as { env?: Record<string, string> }).env, { FS_KEY: ENV_VALUE });
      assert.equal(JSON.stringify(pushed).includes(ENV_VALUE), false);

      // Same-name push reports overwritten.
      const pushedAgain = await (await fetch(`${base}/api/console/mcp-hub/devices/dev-1/push`, {
        method: "POST", headers, body: JSON.stringify({ serverId: hubId }),
      })).json() as { action: string };
      assert.equal(pushedAgain.action, "overwritten");

      const pulled = await (await fetch(`${base}/api/console/mcp-hub/devices/dev-1/pull`, {
        method: "POST", headers, body: JSON.stringify({ serverId: "dev-s1" }),
      })).json() as { action: string; serverId: string; snapshot: { servers: Array<{ name: string }> } };
      assert.equal(pulled.action, "added");
      const pulledRow = pulled.snapshot.servers.find((s) => s.name === "Device Search")!;
      assert.deepEqual(
        (store.getTransfer(pulled.serverId).transport as { headers?: Record<string, string> }).headers,
        { Authorization: HEADER_VALUE },
      );
      assert.equal(JSON.stringify(pulled).includes(HEADER_VALUE), false);

      const removed = await (await fetch(`${base}/api/console/mcp-hub/devices/dev-1/remove`, {
        method: "POST", headers, body: JSON.stringify({ serverId: "dev-s1" }),
      })).json() as { removed: boolean; snapshot: { deviceServerIds: Record<string, string[]> } };
      assert.equal(removed.removed, true);
      assert.equal([...deviceServers.values()].some((s) => s.name === "Device Search"), false);
      // Hub association for that name cleared; the pushed one survives.
      assert.deepEqual(removed.snapshot.deviceServerIds["dev-1"], [hubId]);

      // Offline devices refuse mutations with 409.
      online = false;
      const offline = await fetch(`${base}/api/console/mcp-hub/devices/dev-1/push`, {
        method: "POST", headers, body: JSON.stringify({ serverId: hubId }),
      });
      assert.equal(offline.status, 409);
      const offlinePreview = await (await fetch(`${base}/api/console/mcp-hub/devices/dev-1/sync-preview`, { headers })).json() as {
        deviceOnline: boolean; supportsSync: boolean;
      };
      assert.equal(offlinePreview.deviceOnline, false);
      assert.equal(offlinePreview.supportsSync, false);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports device_update_required for legacy devices", async () => {
    const dir = tempDataDir();
    const store = new McpHubStore(dir);
    const created = store.addServers([{ name: "Legacy Target", transport: { type: "stdio", command: "l" } }]);
    const hubId = created.servers[0]!.id;
    const endpoints = createMcpHubEndpoints({
      mcpHub: store,
      isDeviceOnline: () => true,
      callDevice: async (_deviceId, action) => {
        throw new Error(`unknown action: ${action}`);
      },
    });
    const server = createServer((req, res) => {
      void endpoints.handle(new URL(req.url ?? "/", "http://localhost").pathname, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
    const headers = { "content-type": "application/json", "x-auth-token": createSessionToken("tester").token };
    try {
      const preview = await fetch(`${base}/api/console/mcp-hub/devices/dev-1/sync-preview`, { headers });
      const body = await preview.json() as { supportsSync: boolean };
      assert.equal(body.supportsSync, false);

      const push = await fetch(`${base}/api/console/mcp-hub/devices/dev-1/push`, {
        method: "POST", headers, body: JSON.stringify({ serverId: hubId }),
      });
      assert.equal(push.status, 409);
      assert.equal(((await push.json()) as { error: string }).error, "device_update_required");
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
