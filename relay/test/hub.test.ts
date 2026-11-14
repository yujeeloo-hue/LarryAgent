import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { startRelay, type RelayHandle } from "../src/index.js";
import { createSessionToken } from "../src/auth.js";
import type { ServerToViewerMsg, ServerToDeviceMsg } from "../src/protocol.js";

let relay: RelayHandle;
let dataDir: string;
let apiKey: string;
let apiKeyId: string;

const KEY_DEVICE = { deviceId: "dev-1", name: "Test MacBook", platform: "darwin", version: "0.7.3" };

function wsUrl(path: string): string {
  return `ws://127.0.0.1:${relay.port}${path}`;
}

function connectDevice(key = apiKey): Promise<WebSocket> {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(wsUrl("/ws/device"), { headers: { authorization: `Bearer ${key}` } });
    ws.once("open", () => resolveP(ws));
    ws.once("error", rejectP);
  });
}

function connectDeviceWith(headers: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(wsUrl("/ws/device"), { headers });
    ws.once("open", () => resolveP(ws));
    ws.once("error", rejectP);
  });
}

function connectViewer(): Promise<WebSocket> {
  return new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(wsUrl("/ws/viewer"));
    ws.once("open", () => resolveP(ws));
    ws.once("error", rejectP);
  });
}

function nextMsg<T>(ws: WebSocket, predicate: (msg: T) => boolean, timeoutMs = 3000): Promise<T> {
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      rejectP(new Error("timeout waiting for message"));
    }, timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      const msg = JSON.parse(String(raw)) as T;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolveP(msg);
      }
    };
    ws.on("message", onMessage);
  });
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

function closeWs(ws: WebSocket | null | undefined): Promise<void> {
  if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolveP) => {
    ws.once("close", () => resolveP());
    ws.close();
    setTimeout(() => {
      ws.terminate();
      resolveP();
    }, 300);
  });
}

describe("relay hub", () => {
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    relay = await startRelay({ port: 0, dataDir });
    // Deterministic fresh key per test run (the migrated "Default" key stays untouched).
    const rec = relay.store.createKey("Test Key");
    apiKey = rec.key;
    apiKeyId = rec.id;
  });

  afterEach(async () => {
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects a device with a bad api key", async () => {
    const ws = new WebSocket(wsUrl("/ws/device"), { headers: { authorization: "Bearer wrong" } });
    const code = await new Promise<number>((resolveP) => {
      ws.once("close", (c) => resolveP(Number(c)));
    });
    assert.equal(code, 4001);
  });

  it("completes device hello and reports presence to viewer", async () => {
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    const welcome = await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");
    assert.ok(welcome);

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");
    send(viewer, { type: "devices" });
    const list = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "devices");
    assert.ok(list.type === "devices");
    const found = list.devices.find((d) => d.deviceId === KEY_DEVICE.deviceId);
    assert.ok(found?.online, "device should be online");
    assert.equal(found?.name, "Test MacBook");

    await closeWs(device);
    await closeWs(viewer);
  });

  it("persists hello.caps as device capabilities (stream cap stripped)", async () => {
    const device = await connectDevice();
    send(device, {
      type: "hello",
      device: { ...KEY_DEVICE, deviceId: "dev-caps", platform: "darwin arm64" },
      caps: ["e2ee-v1", "maintenance"],
    });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");
    send(viewer, { type: "devices" });
    const list = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "devices");
    assert.ok(list.type === "devices");
    const found = list.devices.find((d) => d.deviceId === "dev-caps");
    assert.deepEqual(found?.caps, ["maintenance"], "capability caps survive the broadcast");

    // An older build reconnecting without caps must not wipe them.
    send(device, { type: "hello", device: { ...KEY_DEVICE, deviceId: "dev-caps", platform: "darwin arm64" } });
    const after = await nextMsg<ServerToViewerMsg>(
      viewer,
      (m) => m.type === "devices" && m.devices.find((d) => d.deviceId === "dev-caps") !== undefined,
    );
    assert.ok(after.type === "devices");
    assert.deepEqual(
      after.devices.find((d) => d.deviceId === "dev-caps")?.caps,
      ["maintenance"],
    );

    await closeWs(device);
    await closeWs(viewer);
  });

  it("broadcasts the device busy count to viewers", async () => {
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");

    // Busy-count change → devices broadcast carries runningSessions.
    const busyP = nextMsg<ServerToViewerMsg>(viewer, (m) =>
      m.type === "devices" && m.devices.find((d) => d.deviceId === KEY_DEVICE.deviceId)?.runningSessions === 2,
    );
    send(device, { type: "status", runningSessions: 2 });
    const busy = await busyP;
    assert.ok(busy.type === "devices");

    // A no-change repeat must not rebroadcast (quiet within a short window).
    await assert.rejects(
      nextMsg<ServerToViewerMsg>(
        viewer,
        (m) => m.type === "devices" && m.devices.find((d) => d.deviceId === KEY_DEVICE.deviceId)?.runningSessions === 2,
        400,
      ),
      /timeout/,
    );

    // Back to idle → 0.
    const idleP = nextMsg<ServerToViewerMsg>(viewer, (m) =>
      m.type === "devices" && m.devices.find((d) => d.deviceId === KEY_DEVICE.deviceId)?.runningSessions === 0,
    );
    send(device, { type: "status", runningSessions: 0 });
    await idleP;

    await closeWs(device);
    await closeWs(viewer);
  });

  it("broadcasts device maintenance state without touching the busy count", async () => {
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");

    const find = (m: ServerToViewerMsg) =>
      m.type === "devices" ? m.devices.find((d) => d.deviceId === KEY_DEVICE.deviceId) : undefined;

    // Establish a busy count first so the "must not reset" assertion can bite.
    const busyP = nextMsg<ServerToViewerMsg>(viewer, (m) => find(m)?.runningSessions === 2);
    send(device, { type: "status", runningSessions: 2 });
    await busyP;

    // Maintenance-only push (no runningSessions field): busy count stays,
    // maintenance lands in the devices broadcast.
    const queuedP = nextMsg<ServerToViewerMsg>(viewer, (m) => find(m)?.maintenance?.phase === "queued");
    send(device, { type: "status", maintenance: { phase: "queued", id: "u1", source: "https://example.test/a.tar.gz", ts: 1 } });
    const queued = await queuedP;
    const afterQueue = find(queued);
    assert.equal(afterQueue?.maintenance?.id, "u1");
    assert.equal(afterQueue?.runningSessions, 2, "absent runningSessions must not reset the busy count");

    // Identical repeat → no rebroadcast (quiet window).
    await assert.rejects(
      nextMsg<ServerToViewerMsg>(viewer, (m) => find(m)?.maintenance?.phase === "queued" && find(m)?.maintenance?.ts === 1, 400),
      /timeout/,
    );
    send(device, { type: "status", maintenance: { phase: "queued", id: "u1", source: "https://example.test/a.tar.gz", ts: 1 } });

    // Phase change → broadcast; both fields coexist.
    const doneP = nextMsg<ServerToViewerMsg>(viewer, (m) => find(m)?.maintenance?.phase === "done");
    send(device, { type: "status", runningSessions: 1, maintenance: { phase: "done", id: "u1", version: "1.3.1", ts: 2 } });
    const done = await doneP;
    const afterDone = find(done);
    assert.equal(afterDone?.maintenance?.version, "1.3.1");
    assert.equal(afterDone?.runningSessions, 1);

    await closeWs(device);
    await closeWs(viewer);
  });

  it("fans device events out to subscribed viewers only", async () => {
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const subbed = await connectViewer();
    send(subbed, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(subbed, (m) => m.type === "authOk");
    send(subbed, { type: "subscribe", deviceId: KEY_DEVICE.deviceId });

    const other = await connectViewer();
    send(other, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(other, (m) => m.type === "authOk");

    send(device, { type: "event", sessionId: "s1", event: { type: "text", text: "hi" } });

    const got = await nextMsg<ServerToViewerMsg>(subbed, (m) => m.type === "event");
    assert.equal(got.type, "event");
    if (got.type === "event") {
      assert.equal(got.deviceId, KEY_DEVICE.deviceId);
      assert.equal(got.sessionId, "s1");
    }

    // Unsubscribed viewer must NOT receive the event within a short window.
    await assert.rejects(
      nextMsg<ServerToViewerMsg>(other, (m) => m.type === "event", 400),
      /timeout/,
    );

    await closeWs(device);
    await closeWs(subbed);
    await closeWs(other);
  });

  it("pushes viewer presence to devices on subscribe and disconnect", async () => {
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    const welcome = await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");
    assert.equal(welcome.type === "welcome" ? welcome.viewers : undefined, 0);

    const viewerA = await connectViewer();
    send(viewerA, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewerA, (m) => m.type === "authOk");
    send(viewerA, { type: "subscribe", deviceId: KEY_DEVICE.deviceId });
    const one = await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "presence" && m.viewers === 1);
    assert.ok(one.type === "presence" && one.viewers === 1);

    const viewerB = await connectViewer();
    send(viewerB, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewerB, (m) => m.type === "authOk");
    send(viewerB, { type: "subscribe", deviceId: KEY_DEVICE.deviceId });
    const two = await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "presence" && m.viewers === 2);
    assert.ok(two.type === "presence" && two.viewers === 2);

    await closeWs(viewerB);
    const backToOne = await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "presence" && m.viewers === 1);
    assert.ok(backToOne.type === "presence" && backToOne.viewers === 1);

    await closeWs(device);
    await closeWs(viewerA);
  });

  it("hands presence across devices when a viewer switches", async () => {
    const deviceA = await connectDevice();
    send(deviceA, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(deviceA, (m) => m.type === "welcome");
    const deviceB = await connectDevice();
    send(deviceB, { type: "hello", device: { deviceId: "dev-2", name: "Other Mac", platform: "darwin", version: "0.7.3" } });
    await nextMsg<ServerToDeviceMsg>(deviceB, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");

    send(viewer, { type: "subscribe", deviceId: KEY_DEVICE.deviceId });
    const aOne = await nextMsg<ServerToDeviceMsg>(deviceA, (m) => m.type === "presence" && m.viewers === 1);
    assert.ok(aOne.type === "presence");

    // Switch: A drops to 0, B rises to 1.
    send(viewer, { type: "subscribe", deviceId: "dev-2" });
    const aZero = await nextMsg<ServerToDeviceMsg>(deviceA, (m) => m.type === "presence" && m.viewers === 0);
    assert.ok(aZero.type === "presence");
    const bOne = await nextMsg<ServerToDeviceMsg>(deviceB, (m) => m.type === "presence" && m.viewers === 1);
    assert.ok(bOne.type === "presence");

    await closeWs(deviceA);
    await closeWs(deviceB);
    await closeWs(viewer);
  });

  it("reports pre-subscribed viewers in the device welcome", async () => {
    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");
    // Console left open on the device page while the device is offline.
    send(viewer, { type: "subscribe", deviceId: KEY_DEVICE.deviceId });

    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    const welcome = await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");
    assert.equal(welcome.type === "welcome" ? welcome.viewers : undefined, 1);

    await closeWs(device);
    await closeWs(viewer);
  });

  it("routes a viewer request through to the device and back", async () => {
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");

    send(viewer, { type: "req", requestId: "r1", deviceId: KEY_DEVICE.deviceId, action: "listSessions" });
    const deviceReq = await nextMsg<ServerToDeviceMsg & { requestId?: string }>(device, (m) => m.type === "req");
    assert.equal(deviceReq.action, "listSessions");
    assert.ok(deviceReq.requestId?.startsWith("v1-r1"));

    send(device, { type: "res", requestId: deviceReq.requestId!, ok: true, result: [{ id: "s1" }] });
    const res = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "res");
    assert.ok(res.type === "res" && res.ok);
    assert.deepEqual((res as { result: unknown }).result, [{ id: "s1" }]);

    await closeWs(device);
    await closeWs(viewer);
  });

  it("answers device-offline immediately for unknown devices", async () => {
    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");

    send(viewer, { type: "req", requestId: "r2", deviceId: "ghost", action: "getSession", payload: { sessionId: "x" } });
    const res = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "res");
    assert.ok(res.type === "res" && !res.ok);
    if (res.type === "res" && !res.ok) assert.match(res.error, /offline/);

    await closeWs(viewer);
  });

  it("rotating a key kicks its devices and invalidates the old key", async () => {
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");

    // A viewer authenticated with the *other* key must survive the rotate.
    const keysJson = JSON.parse(readFileSync(join(dataDir, "keys.json"), "utf8")) as { keys: { name: string; key: string }[] };
    const defaultKey = keysJson.keys.find((k) => k.name === "Default")!.key;
    const defaultViewer = await connectViewer();
    send(defaultViewer, { type: "auth", apiKey: defaultKey });
    await nextMsg<ServerToViewerMsg>(defaultViewer, (m) => m.type === "authOk");

    send(viewer, { type: "rotateKey", keyId: apiKeyId });
    const rotated = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "keyRotated");
    assert.ok(rotated.type === "keyRotated" && rotated.key.startsWith("jbr_"));

    // Device got kicked.
    const kick = await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "kick");
    assert.ok(kick.type === "kick");

    // Old key can no longer authenticate a fresh connection.
    const stale = await connectViewer();
    send(stale, { type: "auth", apiKey });
    await new Promise<void>((resolveP) => stale.once("close", () => resolveP()));

    // New key works.
    const fresh = await connectViewer();
    send(fresh, { type: "auth", apiKey: rotated.type === "keyRotated" ? rotated.key : "" });
    await nextMsg<ServerToViewerMsg>(fresh, (m) => m.type === "authOk");

    await closeWs(device);
    await closeWs(viewer);
    await closeWs(fresh);

    // The other-key viewer was never kicked: it still answers requests.
    send(defaultViewer, { type: "devices" });
    const stillAlive = await nextMsg<ServerToViewerMsg>(defaultViewer, (m) => m.type === "devices");
    assert.ok(stillAlive.type === "devices");
    await closeWs(defaultViewer);
  });

  it("replacing a device socket kicks the old one with code 4409", async () => {
    const a = await connectDevice();
    send(a, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(a, (m) => m.type === "welcome");

    const b = await connectDevice();
    const closedA = new Promise<{ code: number; reason: string }>((resolveP) => {
      a.once("close", (code: number, reason: Buffer) => {
        resolveP({ code, reason: reason.toString() });
      });
    });
    // Attach before b's hello — the kick lands synchronously with it.
    const kickP = nextMsg<ServerToDeviceMsg & { reason?: string }>(a, (m) => m.type === "kick");
    send(b, { type: "hello", device: KEY_DEVICE });
    const kick = await kickP;
    await nextMsg<ServerToDeviceMsg>(b, (m) => m.type === "welcome");
    assert.equal(kick.reason, "replaced by new connection");
    const close = await closedA;
    assert.equal(close.code, 4409);
    assert.equal(close.reason, "replaced by new connection");

    await closeWs(b);
  });

  it("labels devices with the key they registered under", async () => {
    const deviceA = await connectDevice(apiKey);
    send(deviceA, { type: "hello", device: { ...KEY_DEVICE, deviceId: "dev-a", name: "Work Mac" } });
    await nextMsg<ServerToDeviceMsg>(deviceA, (m) => m.type === "welcome");

    const keysJson = JSON.parse(readFileSync(join(dataDir, "keys.json"), "utf8")) as { keys: { name: string; key: string }[] };
    const defaultKey = keysJson.keys.find((k) => k.name === "Default")!.key;
    const deviceB = await connectDevice(defaultKey);
    send(deviceB, { type: "hello", device: { ...KEY_DEVICE, deviceId: "dev-b", name: "Home Mac" } });
    await nextMsg<ServerToDeviceMsg>(deviceB, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");
    send(viewer, { type: "devices" });
    const list = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "devices");
    assert.ok(list.type === "devices");
    const a = list.devices.find((d) => d.deviceId === "dev-a");
    const b = list.devices.find((d) => d.deviceId === "dev-b");
    assert.equal(a?.keyName, "Test Key");
    assert.equal(b?.keyName, "Default");

    await closeWs(deviceA);
    await closeWs(deviceB);
    await closeWs(viewer);
  });

  it("reveals a key's plaintext to the admin console only", async () => {
    // A plain API-key viewer must not read plaintext keys.
    const kv = await connectViewer();
    send(kv, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(kv, (m) => m.type === "authOk");
    send(kv, { type: "revealKey", keyId: apiKeyId });
    const denied = await nextMsg<ServerToViewerMsg>(kv, (m) => m.type === "error");
    assert.ok(denied.type === "error");
    if (denied.type === "error") assert.match(denied.message, /admin-console/);

    // A session-token (admin console) viewer gets the plaintext back.
    const { token } = createSessionToken("admin");
    const admin = await connectViewer();
    send(admin, { type: "auth", sessionToken: token });
    await nextMsg<ServerToViewerMsg>(admin, (m) => m.type === "authOk");
    send(admin, { type: "revealKey", keyId: apiKeyId });
    const revealed = await nextMsg<ServerToViewerMsg>(admin, (m) => m.type === "keyRevealed");
    assert.ok(revealed.type === "keyRevealed");
    if (revealed.type === "keyRevealed") assert.equal(revealed.key, apiKey);

    // Unknown key id errors out instead of leaking anything.
    send(admin, { type: "revealKey", keyId: "nope" });
    const err = await nextMsg<ServerToViewerMsg>(admin, (m) => m.type === "error");
    assert.ok(err.type === "error");
    if (err.type === "error") assert.match(err.message, /no such key/);

    await closeWs(kv);
    await closeWs(admin);
  });

  it("creates keys from the viewer and the new key authenticates", async () => {
    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");

    // Register the keys-broadcast listener BEFORE createKey: keyCreated and
    // the keys broadcast can arrive in one chunk, and a listener attached
    // after `await` would miss the second message (ws emits synchronously).
    const keysP = nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "keys");
    send(viewer, { type: "createKey", name: "Office" });
    const created = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "keyCreated");
    assert.ok(created.type === "keyCreated");
    assert.equal(created.summary.name, "Office");
    assert.ok(created.key.startsWith("jbr_"));

    // Broadcast refresh arrives too.
    const keysMsg = await keysP;
    assert.ok(keysMsg.type === "keys");
    assert.equal(keysMsg.keys.length, 3); // Default + Test Key + Office

    // The fresh key authenticates a viewer.
    const other = await connectViewer();
    send(other, { type: "auth", apiKey: created.key });
    const ok = await nextMsg<ServerToViewerMsg>(other, (m) => m.type === "authOk");
    assert.ok(ok.type === "authOk");
    if (ok.type === "authOk") assert.equal(ok.keyName, "Office");

    await closeWs(viewer);
    await closeWs(other);
  });

  it("refuses deleting the last key and deletes a key with its devices", async () => {
    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");

    const device = await connectDevice(apiKey);
    send(device, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    // Delete the "Test Key" — its device gets kicked.
    const keysAfterDelete = nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "keys");
    send(viewer, { type: "deleteKey", keyId: apiKeyId });
    const kick = await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "kick");
    assert.ok(kick.type === "kick");
    await keysAfterDelete;

    // Only "Default" remains: deleting it must be refused.
    send(viewer, { type: "deleteKey", keyId: relay.store.keySummaries()[0]!.id });
    const err = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "error");
    assert.ok(err.type === "error");
    if (err.type === "error") assert.match(err.message, /last key/);

    await closeWs(device);
    await closeWs(viewer);
  });

  it("blocks a device from connecting", async () => {
    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");

    // Register device first, then block it.
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");
    send(viewer, { type: "blockDevice", deviceId: KEY_DEVICE.deviceId, blocked: true });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "kick");
    await closeWs(device);

    await new Promise((r) => setTimeout(r, 100));
    const retry = await connectDevice();
    send(retry, { type: "hello", device: KEY_DEVICE });
    const code = await new Promise<number>((resolveP) => retry.once("close", (c) => resolveP(Number(c))));
    assert.equal(code, 4001);

    await closeWs(viewer);
  });

  it("writes audit entries for mutating actions", async () => {
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");

    send(viewer, {
      type: "req",
      requestId: "r3",
      deviceId: KEY_DEVICE.deviceId,
      action: "startTurn",
      payload: { sessionId: "s1", text: "hello world" },
    });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "req");
    // createWorkspace is mutating too (audit + prompt log exempt).
    send(viewer, {
      type: "req",
      requestId: "r4",
      deviceId: KEY_DEVICE.deviceId,
      action: "createWorkspace",
      payload: { name: "PiBot", path: "/Users/x/Developer/PiBot" },
    });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "req" && m.action === "createWorkspace");
    // browseDir is read-only — no audit row.
    send(viewer, {
      type: "req",
      requestId: "r5",
      deviceId: KEY_DEVICE.deviceId,
      action: "browseDir",
      payload: { path: "/Users/x" },
    });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "req" && m.action === "browseDir");
    await new Promise((r) => setTimeout(r, 100));

    send(viewer, { type: "audit" });
    const audit = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "audit");
    assert.ok(audit.type === "audit");
    const actions = audit.logs.map((l) => l.action);
    assert.ok(actions.includes("startTurn"), `startTurn audited, got: ${actions.join(",")}`);
    assert.ok(actions.includes("createWorkspace"), "createWorkspace audited");
    assert.ok(!actions.includes("browseDir"), "browseDir is read-only — never audited");
    assert.ok(actions.includes("hello"));
    // createWorkspace audit detail summarizes name + path.
    const cw = audit.logs.find((l) => l.action === "createWorkspace");
    assert.match(cw?.detail ?? "", /PiBot/);

    await closeWs(device);
    await closeWs(viewer);
  });

  it("relays an 8 MB attachment-sized payload without dropping the frame", async () => {
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");

    // 8 MiB of binary → ~11.2 MB of base64, same shape uploadAttachment sends.
    const data = Buffer.alloc(8 * 1024 * 1024, 7).toString("base64");
    send(viewer, {
      type: "req",
      requestId: "r-att",
      deviceId: KEY_DEVICE.deviceId,
      action: "uploadAttachment",
      payload: { sessionId: "s1", name: "big.bin", data },
    });
    const req = await nextMsg<ServerToDeviceMsg>(
      device,
      (m) => m.type === "req" && m.action === "uploadAttachment",
      10_000,
    );
    assert.ok(req.type === "req");
    const payload = req.payload as { name: string; data: string };
    assert.equal(payload.name, "big.bin");
    assert.equal(payload.data, data, "attachment bytes must arrive intact");

    await closeWs(device);
    await closeWs(viewer);
  });

  it("keeps serving after an oversized WS frame instead of crashing", async () => {
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    // A frame beyond MAX_WS_PAYLOAD_BYTES used to escape as an unhandled
    // 'error' event and kill the whole hub process (systemd crash loop).
    const oversize = "x".repeat(33 * 1024 * 1024);
    device.send(oversize);
    const closed = await new Promise<number>((resolveP) => {
      device.once("close", (c) => resolveP(Number(c)));
    });
    assert.equal(closed, 1009);

    // The hub must still be alive and fully functional for other clients.
    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");
    send(viewer, { type: "serverInfo" });
    const info = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "serverInfo");
    assert.ok(info.type === "serverInfo");

    await closeWs(viewer);
  });

  it("captures device connection IP and User-Agent into the registry", async () => {
    // Last X-Forwarded-For hop wins (Caddy appends it); UA travels as-is.
    const device = await connectDeviceWith({
      authorization: `Bearer ${apiKey}`,
      "x-forwarded-for": "203.0.113.7",
      "user-agent": "LarryAgent/0.8.8",
    });
    send(device, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");
    await closeWs(device);
    await new Promise((r) => setTimeout(r, 100));

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");
    send(viewer, { type: "devices" });
    const list = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "devices");
    assert.ok(list.type === "devices");
    const found = list.devices.find((d) => d.deviceId === KEY_DEVICE.deviceId);
    assert.equal(found?.ip, "203.0.113.7");
    assert.equal(found?.ua, "LarryAgent/0.8.8");
    assert.equal(found?.ipHistory?.length, 1);
    assert.equal(found?.ipHistory?.[0]?.ip, "203.0.113.7");

    // Second connection from a new IP → newest-first history, both entries.
    const device2 = await connectDeviceWith({
      authorization: `Bearer ${apiKey}`,
      "x-forwarded-for": "198.51.100.9",
    });
    send(device2, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device2, (m) => m.type === "welcome");
    await closeWs(device2);
    await new Promise((r) => setTimeout(r, 100));

    send(viewer, { type: "devices" });
    const list2 = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "devices");
    assert.ok(list2.type === "devices");
    const after = list2.devices.find((d) => d.deviceId === KEY_DEVICE.deviceId);
    assert.equal(after?.ip, "198.51.100.9");
    assert.equal(after?.ua, "LarryAgent/0.8.8", "UA stays when a UA-less client reconnects");
    assert.deepEqual(
      after?.ipHistory?.map((h) => h.ip),
      ["198.51.100.9", "203.0.113.7"],
    );

    // Same-IP reconnect must merge into one history entry (no duplicates).
    const device3 = await connectDeviceWith({
      authorization: `Bearer ${apiKey}`,
      "x-forwarded-for": "198.51.100.9",
    });
    send(device3, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device3, (m) => m.type === "welcome");
    await closeWs(device3);
    await new Promise((r) => setTimeout(r, 100));

    send(viewer, { type: "devices" });
    const list3 = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "devices");
    assert.ok(list3.type === "devices");
    const merged = list3.devices.find((d) => d.deviceId === KEY_DEVICE.deviceId);
    assert.equal(merged?.ipHistory?.length, 2);

    await closeWs(viewer);
  });

  it("logs full prompt text with device and source attribution", async () => {
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");

    const longText = "帮我整理今天的会议纪要，重点是：1) 项目进度 2) 风险项 3) 下周计划。" + "详细".repeat(60);
    send(viewer, {
      type: "req",
      requestId: "r-p1",
      deviceId: KEY_DEVICE.deviceId,
      action: "startTurn",
      payload: { sessionId: "s1", text: longText },
    });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "req");
    // User answers are prompts too.
    send(viewer, {
      type: "req",
      requestId: "r-p2",
      deviceId: KEY_DEVICE.deviceId,
      action: "respondUserAsk",
      payload: { sessionId: "s1", requestId: "ask-1", answer: "按方案 B 继续" },
    });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "req");
    // Non-text actions must not create prompt entries.
    send(viewer, { type: "req", requestId: "r-p3", deviceId: KEY_DEVICE.deviceId, action: "cancelTurn", payload: { sessionId: "s1" } });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "req");
    await new Promise((r) => setTimeout(r, 100));

    send(viewer, { type: "prompts" });
    const res = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "prompts");
    assert.ok(res.type === "prompts");
    assert.equal(res.logs.length, 2, "only text-bearing actions become prompt entries");

    const newest = res.logs[0]!;
    assert.equal(newest.action, "respondUserAsk");
    assert.equal(newest.text, "按方案 B 继续");
    assert.equal(newest.deviceId, KEY_DEVICE.deviceId);
    assert.equal(newest.deviceName, KEY_DEVICE.name);
    assert.equal(newest.keyName, "Test Key");
    assert.equal(newest.actor, "Test Key", "api-key viewers are attributed by key name");
    assert.equal(newest.sessionId, "s1");

    const first = res.logs[1]!;
    assert.equal(first.action, "startTurn");
    assert.equal(first.text, longText, "full prompt text survives untruncated");

    // Persisted to prompts.jsonl for the console card across restarts.
    const onDisk = readFileSync(join(dataDir, "prompts.jsonl"), "utf8").split("\n").filter(Boolean);
    assert.equal(onDisk.length, 2);

    await closeWs(device);
    await closeWs(viewer);
  });

  it("normalizes devices.json records written before ipHistory existed", async () => {
    const { writeFileSync } = await import("node:fs");
    const legacyDir = mkdtempSync(join(tmpdir(), "relay-legacy-"));
    try {
      writeFileSync(
        join(legacyDir, "devices.json"),
        JSON.stringify({
          devices: [
            { deviceId: "old-1", name: "Old Box", platform: "linux", version: "0.5.0", online: false, firstSeen: 1, lastSeen: 2, blocked: false },
          ],
        }),
      );
      const { RelayStore } = await import("../src/store.js");
      const store = new RelayStore(legacyDir);
      const summaries = store.deviceSummaries();
      assert.equal(summaries.length, 1);
      assert.deepEqual(summaries[0]?.ipHistory, [], "missing ipHistory normalizes to []");
      assert.equal(summaries[0]?.ip, undefined);
    } finally {
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});

describe("relay hub e2ee v1", () => {
  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "relay-test-"));
    relay = await startRelay({ port: 0, dataDir });
    const rec = relay.store.createKey("Test Key");
    apiKey = rec.key;
    apiKeyId = rec.id;
  });

  afterEach(async () => {
    await relay.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("seals req/res end-to-end while prompts.jsonl keeps plaintext (storage by design)", async () => {
    const { FrameCipher, deriveStreamKey } = await import("../src/streamCipher.ts");
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE, caps: ["e2ee-v1"] });
    const welcome = await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");
    assert.deepEqual((welcome as { caps?: string[] }).caps, ["e2ee-v1"], "relay advertises e2ee in welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey, caps: ["e2ee-v1"] });
    const authOk = await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");
    assert.ok((authOk as { caps?: string[] }).caps?.includes("e2ee-v1"), "authOk advertises e2ee");
    send(viewer, { type: "subscribe", deviceId: KEY_DEVICE.deviceId });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "presence");

    // Viewer seals the bare payload with the same stream key it derives from its API key.
    const key = deriveStreamKey(apiKey);
    const v2r = new FrameCipher(key, "v2r");
    const r2v = new FrameCipher(key, "r2v");
    send(viewer, { type: "req", requestId: "r1", deviceId: KEY_DEVICE.deviceId, action: "startTurn", enc: v2r.seal({ sessionId: "s1", text: "秘密 prompt 🐶" }), sessionId: "s1" });

    // Device receives a sealed req (r2d) — unseal locally with the same key.
    const d2r = new FrameCipher(key, "d2r");
    const r2d = new FrameCipher(key, "r2d");
    const reqMsg = await nextMsg<ServerToDeviceMsg & { enc?: unknown }>(device, (m) => m.type === "req");
    assert.equal(reqMsg.action, "startTurn", "action stays in the clear for audit");
    assert.deepEqual(r2d.open(reqMsg.enc)?.value, { sessionId: "s1", text: "秘密 prompt 🐶" });

    send(device, { type: "res", requestId: reqMsg.requestId, ok: true, enc: d2r.seal({ result: { fine: true } }) });
    const resMsg = await nextMsg<ServerToViewerMsg & { enc?: unknown }>(viewer, (m) => m.type === "res");
    assert.equal(resMsg.ok, true);
    assert.deepEqual((r2v.open(resMsg.enc)?.value as { result?: unknown }).result, { fine: true });

    // Storage by design: the unsealed prompt landed in prompts.jsonl in full.
    send(viewer, { type: "prompts" });
    const prompts = await nextMsg<ServerToViewerMsg & { logs?: Array<{ text: string; sessionId?: string }> }>(viewer, (m) => m.type === "prompts");
    assert.equal(prompts.logs?.[0]?.text, "秘密 prompt 🐶");
    assert.equal(prompts.logs?.[0]?.sessionId, "s1");

    await closeWs(device);
    await closeWs(viewer);
  });

  it("seals events to capable viewers and falls back to plaintext for old viewers", async () => {
    const { FrameCipher, deriveStreamKey } = await import("../src/streamCipher.ts");
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE, caps: ["e2ee-v1"] });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const newViewer = await connectViewer();
    send(newViewer, { type: "auth", apiKey, caps: ["e2ee-v1"] });
    await nextMsg<ServerToViewerMsg>(newViewer, (m) => m.type === "authOk");
    send(newViewer, { type: "subscribe", deviceId: KEY_DEVICE.deviceId });

    const oldViewer = await connectViewer();
    send(oldViewer, { type: "auth", apiKey }); // no caps — pre-1.5 cached console
    await nextMsg<ServerToViewerMsg>(oldViewer, (m) => m.type === "authOk");
    send(oldViewer, { type: "subscribe", deviceId: KEY_DEVICE.deviceId });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "presence" && m.viewers === 2);

    const key = deriveStreamKey(apiKey);
    const d2r = new FrameCipher(key, "d2r");
    const r2v = new FrameCipher(key, "r2v");
    send(device, { type: "event", enc: d2r.seal({ sessionId: "s9", event: { type: "message_delta", text: "hi" } }) });

    const sealed = await nextMsg<ServerToViewerMsg & { enc?: unknown }>(newViewer, (m) => m.type === "event");
    const inner = r2v.open(sealed.enc)?.value as { sessionId?: string; event?: { type?: string } };
    assert.equal(inner.sessionId, "s9");
    assert.equal(inner.event?.type, "message_delta");

    const plain = await nextMsg<ServerToViewerMsg & { sessionId?: string }>(oldViewer, (m) => m.type === "event");
    assert.equal(plain.sessionId, "s9", "old viewer still gets plaintext");

    await closeWs(device);
    await closeWs(newViewer);
    await closeWs(oldViewer);
  });

  it("delivers the derived streamKey to console-session viewers on subscribe", async () => {
    const { deriveStreamKey } = await import("../src/streamCipher.ts");
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE, caps: ["e2ee-v1"] });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    const { token } = createSessionToken("admin");
    send(viewer, { type: "auth", sessionToken: token, caps: ["e2ee-v1"] });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");
    send(viewer, { type: "subscribe", deviceId: KEY_DEVICE.deviceId });

    const keyMsg = await nextMsg<ServerToViewerMsg & { key?: string }>(viewer, (m) => m.type === "streamKey");
    assert.equal(keyMsg.key, deriveStreamKey(apiKey).toString("base64"), "console viewer receives the derived key");

    await closeWs(device);
    await closeWs(viewer);
  });

  it("rejects a tampered sealed req with an error instead of relaying it", async () => {
    const { FrameCipher, deriveStreamKey } = await import("../src/streamCipher.ts");
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE, caps: ["e2ee-v1"] });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey, caps: ["e2ee-v1"] });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");
    send(viewer, { type: "subscribe", deviceId: KEY_DEVICE.deviceId });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "presence");

    const v2r = new FrameCipher(deriveStreamKey(apiKey), "v2r");
    const env = v2r.seal({ payload: { text: "x" } });
    const corrupted = Buffer.from(env.c, "base64");
    corrupted[0] ^= 0xff;
    send(viewer, { type: "req", requestId: "bad", deviceId: KEY_DEVICE.deviceId, action: "startTurn", enc: { n: env.n, c: corrupted.toString("base64") } });

    const res = await nextMsg<ServerToViewerMsg & { error?: string }>(viewer, (m) => m.type === "res");
    assert.equal(res.ok, false);
    assert.match(String(res.error), /unreadable/);

    await closeWs(device);
    await closeWs(viewer);
  });

  it("seals payload-less requests without crashing (regression: listSessions killed the relay)", async () => {
    const { FrameCipher, deriveStreamKey } = await import("../src/streamCipher.ts");
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE, caps: ["e2ee-v1"] });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "welcome");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey, caps: ["e2ee-v1"] });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");
    send(viewer, { type: "subscribe", deviceId: KEY_DEVICE.deviceId });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "presence");

    // Plaintext req with NO payload — hub must seal {} toward the capable
    // device. This used to call seal(undefined) → Buffer.from(undefined)
    // → uncaught TypeError → the whole relay process died.
    send(viewer, { type: "req", requestId: "np", deviceId: KEY_DEVICE.deviceId, action: "listSessions" });
    const reqMsg = await nextMsg<ServerToDeviceMsg & { enc?: unknown }>(device, (m) => m.type === "req");
    const key = deriveStreamKey(apiKey);
    const r2d = new FrameCipher(key, "r2d");
    assert.deepEqual(r2d.open(reqMsg.enc)?.value, {}, "empty payload seals as {}");

    // Relay is still alive: another plain request round-trips.
    send(device, { type: "res", requestId: reqMsg.requestId, ok: true, enc: new FrameCipher(key, "d2r").seal({ result: [1, 2] }) });
    const res = await nextMsg<ServerToViewerMsg & { enc?: unknown }>(viewer, (m) => m.type === "res");
    const r2v = new FrameCipher(key, "r2v");
    assert.deepEqual((r2v.open(res.enc)?.value as { result?: unknown }).result, [1, 2]);

    await closeWs(device);
    await closeWs(viewer);
  });

  it("keeps the plaintext path for pre-1.3 devices (no caps → no ciphers)", async () => {
    const device = await connectDevice();
    send(device, { type: "hello", device: KEY_DEVICE }); // legacy: no caps
    const welcome = await nextMsg<ServerToDeviceMsg & { caps?: string[] }>(device, (m) => m.type === "welcome");
    assert.deepEqual(welcome.caps, ["e2ee-v1"], "relay always advertises its caps; the device decides whether to seal");

    const viewer = await connectViewer();
    send(viewer, { type: "auth", apiKey, caps: ["e2ee-v1"] });
    await nextMsg<ServerToViewerMsg>(viewer, (m) => m.type === "authOk");
    send(viewer, { type: "subscribe", deviceId: KEY_DEVICE.deviceId });
    await nextMsg<ServerToDeviceMsg>(device, (m) => m.type === "presence");

    send(device, { type: "event", sessionId: "s1", event: { type: "ping" } });
    // capable viewer on a legacy device: relay re-seals toward it
    const sealed = await nextMsg<ServerToViewerMsg & { enc?: unknown }>(viewer, (m) => m.type === "event");
    assert.ok(sealed.enc, "relay re-seals plaintext events for capable viewers");

    // legacy device also receives plaintext req (no r2d)
    send(viewer, { type: "req", requestId: "q1", deviceId: KEY_DEVICE.deviceId, action: "listSessions" });
    const req = await nextMsg<ServerToDeviceMsg & { enc?: unknown }>(device, (m) => m.type === "req");
    assert.equal(req.enc, undefined, "legacy device gets plaintext req");

    await closeWs(device);
    await closeWs(viewer);
  });
});
