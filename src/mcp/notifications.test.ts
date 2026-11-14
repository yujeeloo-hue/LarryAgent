import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  addNotificationListener,
  type NotificationCenterEvent,
} from "../events/notificationCenter.js";
import { attachMcpNotificationForwarder } from "./notifications.js";

describe("attachMcpNotificationForwarder", () => {
  it("forwards standard and custom server notifications as NotificationCenter events", async () => {
    const client = new Client(
      { name: "jellybot-test", version: "0.0.0" },
      { capabilities: {} },
    );
    const server = new Server(
      { name: "test-server", version: "0.0.0" },
      // logging capability is required by the SDK to send
      // notifications/message (assertNotificationCapability).
      { capabilities: { logging: {} } },
    );
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    const sender = { tag: "mcp-manager" };
    const received: NotificationCenterEvent[] = [];
    const unsubscribe = addNotificationListener((event) =>
      received.push(event),
    );
    attachMcpNotificationForwarder(client, {
      serverId: "srv-1",
      serverName: "Test Server",
      sender,
    });

    try {
      await Promise.all([
        client.connect(clientTransport),
        server.connect(serverTransport),
      ]);

      // Standard method via the generic notification() path — the
      // sendLoggingMessage convenience wrapper debounces by default in
      // SDK 1.29 and may never emit; notification() delivers synchronously.
      await server.notification({
        method: "notifications/message",
        params: { level: "info", logger: "test", data: "hello" },
      });
      await server.notification({
        method: "notifications/jellybot/demo",
        params: { payload: 42 },
      });

      assert.equal(received.length, 2);
      const standard = received[0];
      const custom = received[1];
      if (!standard || !custom) throw new Error("missing events");

      // Standard method: raw MCP method kept as eventName, params nested
      // under data, origin fields flat, sender passed through by reference.
      assert.equal(standard.eventName, "notifications/message");
      assert.deepEqual(standard.params, {
        serverId: "srv-1",
        serverName: "Test Server",
        data: { level: "info", logger: "test", data: "hello" },
      });
      assert.strictEqual(standard.sender, sender);

      // Custom (non-spec) method reaches the fallback path unchanged.
      assert.equal(custom.eventName, "notifications/jellybot/demo");
      assert.deepEqual(custom.params, {
        serverId: "srv-1",
        serverName: "Test Server",
        data: { payload: 42 },
      });
      assert.strictEqual(custom.sender, sender);
    } finally {
      unsubscribe();
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
});
