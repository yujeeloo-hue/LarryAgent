import assert from "node:assert/strict";
import { test } from "node:test";
import { postNotification } from "./notificationCenter.js";
import {
  attachNotificationCenterRendererBridge,
  NC_RENDERER_EVENT_ALLOWLIST,
} from "./rendererBridge.js";

test("forwards allowlisted events with the {eventName, params} payload shape", () => {
  const forwarded: unknown[] = [];
  const detach = attachNotificationCenterRendererBridge((payload) =>
    forwarded.push(payload),
  );
  try {
    postNotification({
      eventName: "mcp/server_status",
      params: { serverId: "s1", status: "connected" },
      sender: {},
    });
    postNotification({
      eventName: "tools/config_changed",
      params: { section: "skills" },
      sender: {},
    });
    assert.equal(forwarded.length, 2);
    assert.deepEqual(forwarded[0], {
      eventName: "mcp/server_status",
      params: { serverId: "s1", status: "connected" },
    });
    assert.deepEqual(forwarded[1], {
      eventName: "tools/config_changed",
      params: { section: "skills" },
    });
  } finally {
    detach();
  }
});

test("drops unlisted events (prefix tricks included)", () => {
  const forwarded: unknown[] = [];
  const detach = attachNotificationCenterRendererBridge((payload) =>
    forwarded.push(payload),
  );
  try {
    postNotification({
      eventName: "notifications/message",
      params: { serverId: "s", serverName: "S", data: {} },
      sender: {},
    });
    postNotification({
      eventName: "mcp/server_status-evil",
      params: {},
      sender: {},
    });
    assert.equal(forwarded.length, 0);
  } finally {
    detach();
  }
});

test("detach stops forwarding", () => {
  const forwarded: unknown[] = [];
  const detach = attachNotificationCenterRendererBridge((payload) =>
    forwarded.push(payload),
  );
  detach();
  postNotification({
    eventName: "mcp/server_status",
    params: { status: "disconnected" },
    sender: {},
  });
  assert.equal(forwarded.length, 0);
});

test("allowlist set is pinned to the two bridged event names", () => {
  assert.deepEqual([...NC_RENDERER_EVENT_ALLOWLIST].sort(), [
    "mcp/server_status",
    "tools/config_changed",
  ]);
});
