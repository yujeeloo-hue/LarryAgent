import assert from "node:assert/strict";
import test from "node:test";
import {
  TokenHubController,
  type DeviceSyncPreview,
  type DeviceSyncProvider,
  type TokenHubProvider,
} from "../src/TokenHubController.js";

const realFetch = globalThis.fetch;
const apiRoot = "http://relay.test/api/console/token-hub";

type Snapshot = DeviceSyncPreview["snapshot"];
type Call = { path: string; method: string; body: unknown };
type Reply = { status?: number; payload: unknown };
type Handler = (call: Call) => Reply | Promise<Reply>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function hubProvider(id: string, modelId = id): TokenHubProvider {
  return {
    id, modelId, name: modelId, baseUrl: "https://models.example/v1",
    apiKeyConfigured: true, supportsMultimodal: false, multimodalSource: "manual",
    imageInput: "url", createdAt: 1,
  };
}

function deviceProvider(id: string, modelId = id): DeviceSyncProvider {
  return {
    ...hubProvider(id, modelId), rawEndpoint: false, match: "add",
  };
}

function snapshot(providers: TokenHubProvider[] = []): Snapshot {
  return { providers, deviceProviderIds: {} };
}

function preview(
  deviceProviders: DeviceSyncProvider[], server = snapshot(), deviceOnline = true,
): DeviceSyncPreview {
  return {
    deviceOnline, supportsSync: deviceOnline, deviceProviders, snapshot: server,
    hubProviders: server.providers.map((provider) => ({ ...provider, match: "add" })),
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
  const controller = new TokenHubController({
    apiBase: () => "http://relay.test/", sessionToken: () => "session-1",
  });
  return { controller, calls };
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test("device previews include local-only providers and isolate each device's cached list", async () => {
  const inHub = hubProvider("hub-1", "shared-model");
  const server = snapshot([inHub]);
  server.deviceProviderIds = { mac: [inHub.id] };
  const { controller } = setup(({ path }) => ({
    payload: path.includes("/mac/")
      ? preview([deviceProvider("local-1"), deviceProvider("shared-1", "shared-model")], server)
      : preview([deviceProvider("pc-1")], server),
  }));

  const mac = await controller.loadDeviceSyncPreview("mac");
  await controller.loadDeviceSyncPreview("pc");
  assert.deepEqual(mac.deviceProviders.map((provider) => provider.id), ["local-1", "shared-1"]);
  assert.equal(mac.deviceProviders[0]!.match, "add");
  assert.equal(mac.deviceProviders[1]!.match, "overwrite");
  assert.equal(mac.hubProviders[0]!.match, "overwrite");
  assert.deepEqual(controller.getDeviceSyncPreview("pc")!.deviceProviders.map((provider) => provider.id), ["pc-1"]);

  mac.deviceProviders[0]!.name = "changed by caller";
  mac.snapshot.deviceProviderIds.mac!.push("made-up");
  const cached = controller.getDeviceSyncPreview("mac")!;
  cached.deviceProviders.splice(0);
  cached.hubProviders[0]!.name = "also changed";
  assert.equal(controller.getDeviceSyncPreview("mac")!.deviceProviders[0]!.name, "local-1");
  assert.equal(controller.getDeviceSyncPreview("mac")!.hubProviders[0]!.name, "shared-model");
  assert.deepEqual(controller.getDeviceSyncPreview("mac")!.snapshot.deviceProviderIds.mac, ["hub-1"]);
  assert.equal(controller.getDeviceSyncPreview("unknown"), null);
});

test("same-device preview requests share one round trip while different devices can load independently", async () => {
  const macReply = deferred<Reply>();
  const { controller, calls } = setup(({ path }) => path.includes("/mac/")
    ? macReply.promise
    : { payload: preview([deviceProvider("pc-1")]) });

  const first = controller.loadDeviceSyncPreview("mac");
  const second = controller.loadDeviceSyncPreview("mac");
  assert.equal(first, second);
  assert.equal(controller.getSyncPending("mac"), "preview");
  await controller.loadDeviceSyncPreview("pc");
  assert.equal(controller.getSyncPending("pc"), null);
  macReply.resolve({ payload: preview([deviceProvider("mac-1")]) });
  await first;
  assert.equal(calls.filter(({ path }) => path === "/devices/mac/sync-preview").length, 1);
  assert.equal(controller.getSyncPending("mac"), null);
  assert.equal(controller.getDeviceSyncPreview("mac")!.deviceProviders[0]!.id, "mac-1");
});

test("an offline preview preserves the last real device list and marks it offline", async () => {
  let online = true;
  const server = snapshot([hubProvider("hub-1")]);
  const { controller } = setup(() => ({
    payload: preview(online ? [deviceProvider("local-1"), deviceProvider("local-2")] : [], server, online),
  }));
  await controller.loadDeviceSyncPreview("mac");
  online = false;
  const offline = await controller.loadDeviceSyncPreview("mac");

  assert.equal(offline.deviceOnline, false);
  assert.deepEqual(offline.deviceProviders.map(({ id }) => id), ["local-1", "local-2"]);
  assert.equal(controller.getDeviceSyncPreview("mac")!.deviceOnline, false);
  assert.equal(controller.getSyncPending("mac"), null);
  assert.equal(controller.getSyncError("mac"), null);
});

test("a device disconnect during a preview takes precedence over the older online response", async () => {
  const response = deferred<Reply>();
  const { controller } = setup(() => response.promise);
  controller.setDeviceOnline("mac", true);
  const pending = controller.loadDeviceSyncPreview("mac");
  controller.setDeviceOnline("mac", false);
  response.resolve({ payload: preview([deviceProvider("local-1")]) });

  const result = await pending;
  assert.equal(result.deviceOnline, false);
  assert.equal(controller.getDeviceSyncPreview("mac")!.deviceOnline, false);
  assert.deepEqual(result.deviceProviders.map(({ id }) => id), ["local-1"]);
  // A later reconnect can make the retained list usable again.
  controller.setDeviceOnline("mac", true);
  assert.equal(controller.getDeviceSyncPreview("mac")!.deviceOnline, true);
});

test("copying one device row updates Relay identity matches and only that row's operation state", async () => {
  const local = deviceProvider("local-1", "custom-model");
  // Matching tolerates the same URL spelling differences as the server.
  local.baseUrl = "HTTPS://MODELS.EXAMPLE/v1///";
  const copied = hubProvider("new-hub-id", "custom-model");
  let server = snapshot();
  const { controller, calls } = setup(({ path, body }) => {
    if (path.endsWith("/pull")) {
      assert.deepEqual(body, { providerId: "local-1" });
      server = snapshot([copied]);
      return { payload: { action: "added", snapshot: server } };
    }
    return { payload: preview([local, deviceProvider("local-2")], server) };
  });
  await controller.loadDeviceSyncPreview("mac");
  assert.deepEqual(await controller.pullProviderFromDevice("mac", "local-1"), { action: "add" });

  const actual = controller.getDeviceSyncPreview("mac")!;
  assert.deepEqual(actual.deviceProviders.map((provider) => provider.match), ["overwrite", "add"]);
  assert.equal(actual.hubProviders[0]!.match, "overwrite");
  assert.equal(controller.getSnapshot().providers[0]!.id, "new-hub-id");
  assert.deepEqual(controller.getDeviceOperation("mac", "pull", "local-1"), { status: "done", action: "add" });
  assert.equal(controller.getDeviceOperation("mac", "pull", "local-2"), null);
  const operation = controller.getDeviceOperation("mac", "pull", "local-1")!;
  operation.status = "failed";
  assert.equal(controller.getDeviceOperation("mac", "pull", "local-1")!.status, "done");
  assert.deepEqual(calls.map(({ method, path }) => `${method} ${path}`), [
    "GET /devices/mac/sync-preview", "POST /devices/mac/pull", "GET /devices/mac/sync-preview",
  ]);
});

test("Add from Hub refreshes the actual device list, and deletion sends the precise device provider ID", async () => {
  const hub = hubProvider("hub-1", "shared-model");
  const server = snapshot([hub]);
  let device = [deviceProvider("local-only"), deviceProvider("same-model-other-id", "shared-model")];
  const { controller, calls } = setup(({ path, body }) => {
    if (path.endsWith("/push")) {
      assert.deepEqual(body, { providerId: "hub-1" });
      device = [...device, deviceProvider("new-device-id", "shared-model")];
      return { payload: { action: "added", deviceProviderId: "new-device-id", snapshot: server } };
    }
    if (path.endsWith("/remove")) {
      assert.deepEqual(body, { deviceProviderId: "new-device-id" });
      device = device.filter(({ id }) => id !== "new-device-id");
      return { payload: { removed: true, snapshot: server } };
    }
    return { payload: preview(device, server) };
  });
  await controller.loadDeviceSyncPreview("mac");
  await controller.pushProviderToDevice("mac", "hub-1");
  assert.deepEqual(controller.getDeviceSyncPreview("mac")!.deviceProviders.map(({ id }) => id), [
    "local-only", "same-model-other-id", "new-device-id",
  ]);
  assert.deepEqual(controller.getDeviceOperation("mac", "push", "hub-1"), { status: "done", action: "add" });
  await controller.removeProviderFromDevice("mac", "new-device-id");
  assert.deepEqual(controller.getDeviceSyncPreview("mac")!.deviceProviders.map(({ id }) => id), [
    "local-only", "same-model-other-id",
  ]);
  assert.equal(controller.getDeviceOperation("mac", "push", "hub-1"), null);
  assert.equal(controller.getDeviceOperation("mac", "remove", "new-device-id")!.status, "done");
  assert.equal(calls.filter(({ path }) => path.endsWith("/sync-preview")).length, 3);
});

test("a running row operation blocks other mutations and preview reloads for the same device", async () => {
  const mutation = deferred<Reply>();
  const server = snapshot([hubProvider("hub-1")]);
  const { controller, calls } = setup(({ path }) => path === "/devices/mac/pull"
    ? mutation.promise
    : { payload: preview([deviceProvider("local-1")], server) });
  await controller.loadDeviceSyncPreview("mac");
  const pending = controller.pullProviderFromDevice("mac", "local-1");
  assert.deepEqual(controller.getDeviceOperation("mac", "pull", "local-1"), { status: "pending" });
  await assert.rejects(controller.pushProviderToDevice("mac", "hub-1"), /still running/);
  await assert.rejects(controller.removeProviderFromDevice("mac", "local-1"), /still running/);
  await assert.rejects(controller.pullProviderFromDevice("mac", "local-2"), /still running/);
  await assert.rejects(controller.loadDeviceSyncPreview("mac"), /still running/);
  await controller.loadDeviceSyncPreview("pc");
  assert.equal(calls.filter(({ method }) => method === "POST").length, 1);
  mutation.resolve({ payload: { action: "overwritten", snapshot: server } });
  assert.deepEqual(await pending, { action: "overwrite" });
  assert.equal(controller.getSyncPending("mac"), null);
});

test("a successful Add remains successful when the follow-up read fails", async () => {
  const server = snapshot([hubProvider("hub-1")]);
  let committed = false;
  const { controller } = setup(({ path }) => {
    if (path.endsWith("/push")) {
      committed = true;
      return { payload: { action: "added", deviceProviderId: "added-device-id", snapshot: server } };
    }
    return committed
      ? { status: 504, payload: { error: "device_timeout" } }
      : { payload: preview([deviceProvider("existing-local")], server) };
  });
  await controller.loadDeviceSyncPreview("mac");
  assert.deepEqual(await controller.pushProviderToDevice("mac", "hub-1"), { action: "add" });
  assert.deepEqual(controller.getDeviceOperation("mac", "push", "hub-1"), { status: "done", action: "add" });
  assert.match(controller.getSyncError("mac")!, /Change saved.*Could not reload.*device_timeout/);
  assert.equal(controller.getSyncPending("mac"), null);
  assert.deepEqual(controller.getDeviceSyncPreview("mac")!.deviceProviders.map(({ id }) => id), [
    "existing-local", "added-device-id",
  ]);
});

test("a committed deletion stays removed from the cached list if reloading times out", async () => {
  let committed = false;
  const server = snapshot();
  const { controller } = setup(({ path }) => {
    if (path.endsWith("/remove")) {
      committed = true;
      return { payload: { removed: true, snapshot: server } };
    }
    return committed
      ? { status: 504, payload: { error: "device_timeout" } }
      : { payload: preview([deviceProvider("delete-me"), deviceProvider("keep-me")], server) };
  });
  await controller.loadDeviceSyncPreview("mac");
  await controller.removeProviderFromDevice("mac", "delete-me");
  assert.deepEqual(controller.getDeviceSyncPreview("mac")!.deviceProviders.map(({ id }) => id), ["keep-me"]);
  assert.equal(controller.getDeviceOperation("mac", "remove", "delete-me")!.status, "done");
  assert.match(controller.getSyncError("mac")!, /Change saved/);
});

test("a failed row operation can be retried and clears its previous failure", async () => {
  let attempts = 0;
  const retry = deferred<Reply>();
  const server = snapshot();
  const { controller } = setup(({ path }) => {
    if (!path.endsWith("/pull")) return { payload: preview([deviceProvider("local-1")], server) };
    attempts++;
    return attempts === 1
      ? { status: 502, payload: { error: "device_offline", detail: "Device disconnected." } }
      : retry.promise;
  });
  await controller.loadDeviceSyncPreview("mac");
  await assert.rejects(controller.pullProviderFromDevice("mac", "local-1"), /Device disconnected/);
  assert.deepEqual(controller.getDeviceOperation("mac", "pull", "local-1"), {
    status: "failed", error: "Device disconnected.",
  });
  const pending = controller.pullProviderFromDevice("mac", "local-1");
  assert.deepEqual(controller.getDeviceOperation("mac", "pull", "local-1"), { status: "pending" });
  assert.equal(controller.getSyncError("mac"), null);
  retry.resolve({ payload: { action: "added", snapshot: server } });
  await pending;
  assert.deepEqual(controller.getDeviceOperation("mac", "pull", "local-1"), { status: "done", action: "add" });
  assert.equal(controller.getSyncError("mac"), null);
  assert.equal(attempts, 2);
});
