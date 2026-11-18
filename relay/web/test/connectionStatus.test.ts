import assert from "node:assert/strict";
import test from "node:test";
import { connectionStatus, type ConnectionState } from "../src/connectionStatus.js";

const encrypted: ConnectionState = { socket: "online", e2ee: "on", e2eeTitle: "Stream encrypted (E2EE v1)" };

test("disconnect and reconnect cannot keep a stale green shield or online count", () => {
  const online = connectionStatus(encrypted, 3);
  assert.equal(online.shield, "on");
  assert.equal(online.count, "3 devices online");
  const offline = connectionStatus({ ...encrypted, socket: "offline" }, 3);
  assert.equal(offline.shield, "off");
  assert.equal(offline.count, "");
  assert.match(offline.title, /Offline/);
  const reconnecting = connectionStatus({ ...encrypted, socket: "connecting" }, 3);
  assert.equal(reconnecting.shield, "wait");
  assert.equal(reconnecting.status, "Connecting…");
  assert.equal(reconnecting.count, "");
  assert.equal(connectionStatus(encrypted, 1).count, "1 device online");
});

test("a connected socket is green only after encryption is active", () => {
  const pending = connectionStatus({ socket: "online", e2ee: "", e2eeTitle: "" }, 0);
  assert.equal(pending.status, "Connected");
  assert.equal(pending.count, "0 devices online");
  assert.equal(pending.shield, "wait");
  assert.match(pending.title, /waiting for stream encryption/);
  const error = connectionStatus({ socket: "online", e2ee: "err", e2eeTitle: "Unreadable frame" }, 3);
  assert.equal(error.shield, "err");
  assert.equal(error.title, "Unreadable frame");
});
