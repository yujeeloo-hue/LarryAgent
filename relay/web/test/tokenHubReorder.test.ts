import assert from "node:assert/strict";
import test from "node:test";
import {
  TokenHubController,
  type DeviceSyncPreview,
  type TokenHubProvider,
} from "../src/TokenHubController.js";

const realFetch = globalThis.fetch;
const apiRoot = "http://relay.test/api/console/token-hub";
type Change = "snapshot" | "provider-order";
type Snapshot = DeviceSyncPreview["snapshot"];
type Call = { path: string; method: string; body: unknown };
type Reply = { status?: number; payload: unknown };

function provider(id: string): TokenHubProvider {
  return {
    id, name: `Provider ${id}`, modelId: `model-${id}`, baseUrl: "https://models.example/v1",
    apiKeyConfigured: true, supportsMultimodal: false, multimodalSource: "manual",
    imageInput: "url", createdAt: 1,
  };
}

function snapshot(ids = ["a", "b", "c"]): Snapshot {
  return { providers: ids.map(provider), deviceProviderIds: { mac: ["a", "c"] } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(respond: (call: Call) => Reply | Promise<Reply>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      path: String(input).slice(apiRoot.length),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    };
    calls.push(call);
    const reply = await respond(call);
    return new Response(JSON.stringify(reply.payload), {
      status: reply.status ?? 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  const controller = new TokenHubController({
    apiBase: () => "http://relay.test/", sessionToken: () => "session-1",
  });
  return { controller, calls };
}

test.afterEach(() => { globalThis.fetch = realFetch; });

test("reordering posts the complete order, preserves selection, and emits only provider-order", async () => {
  const server = snapshot();
  const reordered = snapshot(["c", "a", "b"]);
  const { controller, calls } = setup(({ path }) => ({ payload: path === "" ? server : reordered }));
  const events: Change[] = [];
  controller.subscribe((change) => events.push(change));
  await controller.refresh();
  controller.selectProvider("b");
  assert.deepEqual(events, ["snapshot", "snapshot"]);
  events.length = 0;

  await controller.reorderProviders(["c", "a", "b"]);

  assert.deepEqual(calls[1], {
    path: "/providers/reorder", method: "POST", body: { providerIds: ["c", "a", "b"] },
  });
  assert.deepEqual(controller.getSnapshot().providers.map(({ id }) => id), ["c", "a", "b"]);
  assert.equal(controller.getSnapshot().selectedProviderId, "b");
  assert.deepEqual(controller.getSnapshot().deviceProviderIds, server.deviceProviderIds);
  assert.deepEqual(events, ["provider-order"]);
  assert.equal(controller.isProviderOrderSaving(), false);
});

test("duplicate, omitted, and unknown IDs reject before any request or state change", async () => {
  const { controller, calls } = setup(() => ({ payload: snapshot() }));
  await controller.refresh();
  controller.selectProvider("c");
  const before = controller.getSnapshot();
  const events: Change[] = [];
  controller.subscribe((change) => events.push(change));

  for (const ids of [["a", "a", "c"], ["a", "b"], ["a", "b", "unknown"], ["a", "b", "c", "unknown"]]) {
    await assert.rejects(() => controller.reorderProviders(ids));
    assert.deepEqual(controller.getSnapshot(), before);
    assert.equal(controller.isProviderOrderSaving(), false);
  }
  assert.equal(calls.length, 1);
  assert.deepEqual(events, []);
});

test("dropping a provider back into the same order is a no-op", async () => {
  const { controller, calls } = setup(() => ({ payload: snapshot() }));
  await controller.refresh();
  const events: Change[] = [];
  controller.subscribe((change) => events.push(change));

  await controller.reorderProviders(["a", "b", "c"]);

  assert.equal(calls.length, 1);
  assert.deepEqual(events, []);
  assert.equal(controller.isProviderOrderSaving(), false);
  assert.deepEqual(controller.getSnapshot().providers.map(({ id }) => id), ["a", "b", "c"]);
});

test("only one order can save at a time and pending state does not notify or replace the snapshot", async () => {
  const response = deferred<Reply>();
  const { controller, calls } = setup(({ path }) => path === ""
    ? { payload: snapshot() }
    : response.promise);
  await controller.refresh();
  const before = controller.getSnapshot();
  const events: Change[] = [];
  controller.subscribe((change) => events.push(change));

  const pending = controller.reorderProviders(["c", "a", "b"]);
  assert.equal(controller.isProviderOrderSaving(), true);
  assert.deepEqual(controller.getSnapshot(), before);
  assert.deepEqual(events, []);
  await assert.rejects(() => controller.reorderProviders(["b", "c", "a"]));
  assert.equal(calls.length, 2);
  assert.equal(controller.isProviderOrderSaving(), true);
  assert.deepEqual(events, []);

  // The user can select another provider while the request is in flight.
  controller.selectProvider("b");
  assert.deepEqual(events, ["snapshot"]);
  events.length = 0;

  response.resolve({ payload: snapshot(["c", "a", "b"]) });
  await pending;
  assert.equal(controller.isProviderOrderSaving(), false);
  assert.equal(controller.getSnapshot().selectedProviderId, "b");
  assert.deepEqual(events, ["provider-order"]);
});

test("a failed save preserves the old snapshot without notifying and can be retried", async () => {
  let saves = 0;
  const { controller } = setup(({ path }) => {
    if (path === "") return { payload: snapshot() };
    saves++;
    return saves === 1
      ? { status: 503, payload: { error: "storage_unavailable" } }
      : { payload: snapshot(["b", "a", "c"]) };
  });
  await controller.refresh();
  controller.selectProvider("c");
  const before = controller.getSnapshot();
  const events: Change[] = [];
  controller.subscribe((change) => events.push(change));

  await assert.rejects(() => controller.reorderProviders(["b", "a", "c"]), /storage_unavailable/);
  assert.equal(controller.isProviderOrderSaving(), false);
  assert.deepEqual(controller.getSnapshot(), before);
  assert.deepEqual(events, []);

  await controller.reorderProviders(["b", "a", "c"]);
  assert.equal(controller.isProviderOrderSaving(), false);
  assert.deepEqual(controller.getSnapshot().providers.map(({ id }) => id), ["b", "a", "c"]);
  assert.equal(controller.getSnapshot().selectedProviderId, "c");
  assert.deepEqual(events, ["provider-order"]);
  assert.equal(saves, 2);
});

test("a cached device preview follows the saved Hub order while retaining its device rows and matches", async () => {
  const server = snapshot();
  const local = {
    ...provider("local-id"), modelId: "model-b", rawEndpoint: false, match: "overwrite" as const,
  };
  const devicePreview: DeviceSyncPreview = {
    deviceOnline: true, supportsSync: true, snapshot: server,
    hubProviders: server.providers.map((item) => ({ ...item, match: "add" })),
    deviceProviders: [local],
  };
  const { controller, calls } = setup(({ path }) => ({
    payload: path.endsWith("/sync-preview") ? devicePreview : snapshot(["c", "b", "a"]),
  }));
  await controller.loadDeviceSyncPreview("mac");
  const before = controller.getDeviceSyncPreview("mac")!;
  assert.deepEqual(before.hubProviders.map(({ id }) => id), ["a", "b", "c"]);

  await controller.reorderProviders(["c", "b", "a"]);

  const after = controller.getDeviceSyncPreview("mac")!;
  assert.deepEqual(after.hubProviders.map(({ id }) => id), ["c", "b", "a"]);
  assert.deepEqual(after.hubProviders.map(({ match }) => match), ["add", "overwrite", "add"]);
  assert.deepEqual(after.deviceProviders, before.deviceProviders);
  assert.equal(calls.filter(({ path }) => path.endsWith("/sync-preview")).length, 1);
});
