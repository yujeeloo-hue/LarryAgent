import assert from "node:assert/strict";
import test from "node:test";
import {
  McpHubController,
  type DeviceSyncMcpPreview,
  type DeviceSyncMcpServer,
  type McpHubServer,
} from "../src/McpHubController.js";

const realFetch = globalThis.fetch;
const apiRoot = "http://relay.test/api/console/mcp-hub";

type Snapshot = DeviceSyncMcpPreview["snapshot"];
type Call = { path: string; method: string; body: unknown };
type Reply = { status?: number; payload: unknown };
type Handler = (call: Call) => Reply | Promise<Reply>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let seq = 0;
function hubServer(id: string, name = id): McpHubServer {
  seq += 1;
  return {
    id, name, enabled: true, createdAt: seq,
    transport: { type: "stdio", command: "npx", args: ["-y", name] },
    secretConfigured: true,
  };
}

function deviceServer(id: string, name = id): DeviceSyncMcpServer {
  return {
    id, name, enabled: true,
    transport: { type: "stdio", command: "npx" },
    secretConfigured: false, status: "connected", toolCount: 3, match: "add",
  };
}

function snapshot(servers: McpHubServer[] = []): Snapshot {
  return { servers, deviceServerIds: {} };
}

function preview(deviceServers: DeviceSyncMcpServer[], server = snapshot(), deviceOnline = true): DeviceSyncMcpPreview {
  return {
    deviceOnline, supportsSync: deviceOnline, deviceServers, snapshot: server,
    hubServers: server.servers.map((server_) => ({ ...server_, match: "add" })),
  };
}

function setup(handler: Handler) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = {
      path: String(input).slice(apiRoot.length),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const reply = await handler(call);
    return new Response(JSON.stringify(reply.payload), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const controller = new McpHubController({
    apiBase: () => "http://relay.test/", sessionToken: () => "session-1",
  });
  return { controller, calls };
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test("device previews match servers by name in both directions", async () => {
  const inHub = hubServer("hub-1", "shared-server");
  const server = snapshot([inHub]);
  server.deviceServerIds = { mac: [inHub.id] };
  const { controller } = setup(({ path, method }) => {
    if (path === "/devices/mac/sync-preview" || path === "/devices/pc/sync-preview") {
      return {
        payload: path.includes("/mac/")
          ? preview([deviceServer("local-1"), deviceServer("shared-1", "Shared-Server")], server)
          : preview([deviceServer("pc-1")], server),
      };
    }
    if (path.startsWith("/servers/") && method === "DELETE") {
      return { payload: snapshot() };
    }
    return { status: 404, payload: { error: "not_found" } };
  });

  const mac = await controller.loadDeviceSyncPreview("mac");
  await controller.loadDeviceSyncPreview("pc");
  assert.equal(mac.deviceServers[0]!.match, "add");
  assert.equal(mac.deviceServers[1]!.match, "overwrite", "name matching is case-insensitive");
  assert.equal(mac.hubServers[0]!.match, "overwrite");
  assert.equal(controller.getDeviceSyncPreview("pc")!.deviceServers[0]!.match, "add");
  assert.equal(controller.getDeviceSyncPreview("unknown"), null);

  // Hub mutations recompute live matches without a device round trip.
  controller.selectServer(inHub.id);
  await controller.removeServer(inHub.id);
  const after = controller.getDeviceSyncPreview("mac")!;
  assert.equal(after.hubServers.length, 0);
  assert.equal(after.deviceServers[1]!.match, "add");
});

test("push/pull/remove flow through pending → done with reloaded device lists", async () => {
  const hub1 = hubServer("hub-1", "pushed-server");
  const hub2 = hubServer("hub-2", "copied-server");
  let server = snapshot([hub1]);
  const deviceServers: DeviceSyncMcpServer[] = [];
  const { controller, calls } = setup(({ path, method, body }) => {
    if (path === "/devices/mac/sync-preview") return { payload: preview(deviceServers, server) };
    if (path === "/devices/mac/push" && method === "POST") {
      assert.equal((body as { serverId: string }).serverId, "hub-1");
      deviceServers.push({ ...deviceServer("dev-p1", "pushed-server"), status: "connecting" });
      return { payload: { action: "added", deviceServerId: "dev-p1", snapshot: server } };
    }
    if (path === "/devices/mac/pull" && method === "POST") {
      assert.equal((body as { serverId: string }).serverId, "dev-s1");
      server = snapshot([hub1, hub2]);
      server.deviceServerIds = { mac: [hub1.id, hub2.id] };
      return { payload: { action: "added", serverId: hub2.id, snapshot: server } };
    }
    if (path === "/devices/mac/remove" && method === "POST") {
      assert.equal((body as { serverId: string }).serverId, "dev-s1");
      const index = deviceServers.findIndex((server_) => server_.id === "dev-s1");
      deviceServers.splice(index, 1);
      return { payload: { removed: true, deviceServerId: "dev-s1", snapshot: server } };
    }
    return { status: 404, payload: { error: "not_found" } };
  });

  await controller.refresh();
  await controller.loadDeviceSyncPreview("mac");

  const pushed = await controller.pushServerToDevice("mac", "hub-1");
  assert.deepEqual(pushed, { action: "add" });
  assert.equal(controller.getSyncPending("mac"), null);
  assert.equal(controller.getDeviceOperation("mac", "push", "hub-1")!.status, "done");
  const optimistic = controller.getDeviceSyncPreview("mac")!.deviceServers.find((server_) => server_.id === "dev-p1")!;
  assert.equal(optimistic.status, "connecting", "push adds an optimistic connecting row");

  deviceServers.push({ ...deviceServer("dev-s1", "copied-server") });
  const pulled = await controller.pullServerFromDevice("mac", "dev-s1");
  assert.deepEqual(pulled, { action: "add" });
  assert.equal(controller.getDeviceOperation("mac", "pull", "dev-s1")!.status, "done");
  assert.deepEqual(calls.filter(({ path }) => path.endsWith("/sync-preview")).length >= 3, true);

  await controller.removeServerFromDevice("mac", "dev-s1");
  assert.equal(controller.getDeviceSyncPreview("mac")!.deviceServers.some((server_) => server_.id === "dev-s1"), false);
  assert.match(controller.getSyncAnnouncement("mac"), /Deleted/);
});

test("failed operations surface the error and stay retryable; one op at a time per device", async () => {
  const hub1 = hubServer("hub-1", "failing-server");
  let fail = true;
  const { controller } = setup(({ path, method }) => {
    if (path === "/devices/mac/sync-preview") return { payload: preview([], snapshot([hub1])) };
    if (path === "/devices/mac/push" && method === "POST") {
      if (fail) return { status: 409, payload: { error: "device offline", detail: "device offline" } };
      return { payload: { action: "added", deviceServerId: "dev-x", snapshot: snapshot([hub1]) } };
    }
    return { status: 404, payload: { error: "not_found" } };
  });
  await controller.refresh();
  await controller.loadDeviceSyncPreview("mac");

  await assert.rejects(controller.pushServerToDevice("mac", "hub-1"), /device offline/);
  const failed = controller.getDeviceOperation("mac", "push", "hub-1")!;
  assert.equal(failed.status, "failed");
  assert.match(failed.error!, /device offline/);
  assert.equal(controller.getSyncPending("mac"), null);
  assert.match(controller.getSyncAnnouncement("mac"), /failing-server/);

  fail = false;
  const ok = await controller.pushServerToDevice("mac", "hub-1");
  assert.deepEqual(ok, { action: "add" });
  assert.equal(controller.getDeviceOperation("mac", "push", "hub-1")!.status, "done");
});

test("device_update_required replies degrade to an upgrade hint", async () => {
  const { controller } = setup(({ path }) => {
    if (path === "/devices/mac/sync-preview") {
      return { payload: { deviceOnline: true, supportsSync: false, hubServers: [], deviceServers: [], snapshot } };
    }
    return { status: 409, payload: { error: "device_update_required", detail: "Update this device to sync MCP servers remotely." } };
  });
  const previewed = await controller.loadDeviceSyncPreview("mac");
  assert.equal(previewed.supportsSync, false);
  await assert.rejects(controller.pushServerToDevice("mac", "hub-1"), /Update this device/);
});

test("reorder sends the full id list and keeps selection", async () => {
  const a = hubServer("a", "A");
  const b = hubServer("b", "B");
  let server = snapshot([a, b]);
  const { controller, calls } = setup(() => ({ payload: server }));
  await controller.refresh();
  controller.selectServer("b");
  server = snapshot([b, a]);
  await controller.reorderServers(["b", "a"]);
  const orderCall = calls.find(({ path, method }) => path === "/servers/reorder" && method === "POST");
  assert.deepEqual((orderCall!.body as { serverIds: string[] }).serverIds, ["b", "a"]);
  assert.equal(controller.getSnapshot().selectedServerId, "b");

  // No-op reorder skips the round trip; drift rejects locally.
  const before = calls.length;
  await controller.reorderServers(["b", "a"]);
  assert.equal(calls.length, before);
  await assert.rejects(controller.reorderServers(["a", "b", "ghost"]), /Servers changed/);
});

test("same-device preview requests share one round trip", async () => {
  const macReply = deferred<Reply>();
  const { controller, calls } = setup(({ path }) => path.includes("/mac/")
    ? macReply.promise
    : { payload: preview([deviceServer("pc-1")]) });
  const first = controller.loadDeviceSyncPreview("mac");
  const second = controller.loadDeviceSyncPreview("mac");
  assert.equal(first, second);
  assert.equal(controller.getSyncPending("mac"), "preview");
  await controller.loadDeviceSyncPreview("pc");
  macReply.resolve({ payload: preview([deviceServer("mac-1")]) });
  await first;
  assert.equal(calls.filter(({ path }) => path === "/devices/mac/sync-preview").length, 1);
});
