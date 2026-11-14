import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { addNotificationListener } from "../events/notificationCenter.js";
import type { McpServerConfig } from "../toolsConfig/types.js";
import { McpManager } from "./manager.js";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

type StatusEvent = {
  eventName: string;
  params: {
    serverId?: unknown;
    serverName?: unknown;
    status?: unknown;
    errorMessage?: unknown;
  };
  sender: unknown;
};

function collectStatusEvents(): {
  events: StatusEvent[];
  unsubscribe: () => void;
} {
  const events: StatusEvent[] = [];
  const unsubscribe = addNotificationListener((event) => {
    if (event.eventName === "mcp/server_status") {
      events.push(event as StatusEvent);
    }
  });
  return { events, unsubscribe };
}

test("connect failure posts connecting → error with errorMessage (sender = manager)", async () => {
  const manager = new McpManager();
  const { events, unsubscribe } = collectStatusEvents();
  try {
    const config: McpServerConfig = {
      id: "srv-fail",
      name: "Fail",
      enabled: true,
      transport: { type: "stdio", command: "/nonexistent/jellybot-test-command" },
    };
    await manager.reconcile([config]);
    assert.equal(events.length, 2);
    assert.deepEqual(events[0]?.params, {
      serverId: "srv-fail",
      serverName: "Fail",
      status: "connecting",
    });
    assert.equal(events[1]?.params.status, "error");
    assert.equal(
      typeof events[1]?.params.errorMessage,
      "string",
    );
    assert.strictEqual(events[1]?.sender, manager);
  } finally {
    unsubscribe();
    await manager.reconcile([]);
  }
});

test("connect success posts connecting → connected; disable posts disconnected", { timeout: 30000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "jb-mcp-status-"));
  const sdk = join(
    repoRoot,
    "node_modules",
    "@modelcontextprotocol",
    "sdk",
    "dist",
    "esm",
  );
  const script = join(dir, "server.mjs");
  await writeFile(
    script,
    [
      `import { Server } from ${JSON.stringify(join(sdk, "server", "index.js"))};`,
      `import { StdioServerTransport } from ${JSON.stringify(join(sdk, "server", "stdio.js"))};`,
      `import { ListToolsRequestSchema } from ${JSON.stringify(join(sdk, "types.js"))};`,
      `const server = new Server({ name: "status-test", version: "0.0.0" }, { capabilities: { tools: {} } });`,
      `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));`,
      `await server.connect(new StdioServerTransport());`,
      `setInterval(() => {}, 1 << 30); // keep the stdio server alive`,
    ].join("\n"),
    "utf8",
  );
  const manager = new McpManager();
  const { events, unsubscribe } = collectStatusEvents();
  try {
    const config: McpServerConfig = {
      id: "srv-ok",
      name: "Ok",
      enabled: true,
      transport: { type: "stdio", command: process.execPath, args: [script] },
    };
    await manager.reconcile([config]);
    assert.deepEqual(
      events.map((e) => e.params.status),
      ["connecting", "connected"],
    );
    assert.deepEqual(events[1]?.params, {
      serverId: "srv-ok",
      serverName: "Ok",
      status: "connected",
    });
    await manager.setEnabled("srv-ok", false);
    assert.equal(events.length, 3);
    assert.deepEqual(events[2]?.params, {
      serverId: "srv-ok",
      serverName: "Ok",
      status: "disconnected",
    });
  } finally {
    unsubscribe();
    await manager.reconcile([]);
    await rm(dir, { recursive: true, force: true });
  }
});
