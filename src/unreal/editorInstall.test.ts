import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { McpManager, type McpServerProbe } from "../mcp/manager.js";
import type { McpServerConfig } from "../toolsConfig/types.js";
import {
  isUnrealEditorMcpConnected,
  listUnrealEditors,
  onUnrealEditorBindingsChanged,
  resetUnrealEditorBindings,
} from "./editorBinding.js";
import { bindUnrealEditorSession, installUnrealEditorMcp } from "./editorInstall.js";
import { projectFileKey } from "./editorProtocol.js";
import { textResult } from "../tools/pathUtil.js";
import { ToolReturnCode } from "../session/returnCodes.js";

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe("unreal editor mcp recognition", { concurrency: false }, () => {
test("a capabilities payload with the wrong protocol does not bind", async () => {
  resetUnrealEditorBindings();
  try {
    await bindUnrealEditorSession(
      "vendor",
      ["unreal_editor_capabilities"],
      () => Promise.resolve(textResult(JSON.stringify({
        protocol: "vendor-mcp",
        protocolVersion: 1,
        projectFile: "E:/NF/Game.uproject",
        engineVersion: "5.7.1",
        ready: true,
        capabilities: ["references", "open"],
      }), ToolReturnCode.Success)),
      () => true,
    );
    assert.equal(listUnrealEditors().length, 0);
  } finally {
    resetUnrealEditorBindings();
  }
});

test("a compliant session marks only its project and loses the binding on close", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "unreal-editor-mcp-"));
  const sdk = join(repoRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
  const sdkUrl = (file: string): string => pathToFileURL(join(sdk, file)).href;
  const projectFile = join(dir, "Game.uproject");
  const otherWorkspace = join(dir, "Other");
  await mkdir(otherWorkspace);
  await writeFile(projectFile, "{}");
  await writeFile(join(otherWorkspace, "Game.uproject"), "{}");
  const payload = JSON.stringify({
    protocol: "unreal-editor",
    protocolVersion: 1,
    projectFile,
    engineVersion: "5.7.1",
    ready: true,
    capabilities: ["references", "open"],
  });
  const script = join(dir, "server.mjs");
  await writeFile(
    script,
    [
      `import { Server } from ${JSON.stringify(sdkUrl("server/index.js"))};`,
      `import { StdioServerTransport } from ${JSON.stringify(sdkUrl("server/stdio.js"))};`,
      `import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdkUrl("types.js"))};`,
      `const server = new Server({ name: "editor", version: "0.0.0" }, { capabilities: { tools: {} } });`,
      `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [`,
      `{ name: "ping", description: "Ping", inputSchema: { type: "object", properties: {} } },`,
      `{ name: "unreal_editor_capabilities", description: "Capabilities", inputSchema: { type: "object", properties: {} } },`,
      `{ name: "unreal_editor_find_references", description: "Find", inputSchema: { type: "object", properties: {} } },`,
      `{ name: "unreal_editor_open", description: "Open", inputSchema: { type: "object", properties: {} } },`,
      `] }));`,
      `server.setRequestHandler(CallToolRequestSchema, async (request) => {`,
      `  if (request.params.name === "ping") {`,
      `    setTimeout(() => process.exit(0), 25);`,
      `    return { content: [{ type: "text", text: "closing" }] };`,
      `  }`,
      `  if (request.params.name !== "unreal_editor_capabilities") {`,
      `    return { isError: true, content: [{ type: "text", text: "unexpected" }] };`,
      `  }`,
      `  return { content: [{ type: "text", text: ${JSON.stringify(payload)} }] };`,
      `});`,
      `await server.connect(new StdioServerTransport());`,
      `setInterval(() => {}, 1 << 30);`,
    ].join("\n"),
    "utf8",
  );
  const manager = new McpManager();
  resetUnrealEditorBindings();
  installUnrealEditorMcp(manager);
  const changes: boolean[] = [];
  let onClose: (() => void) | undefined;
  const unsubscribe = onUnrealEditorBindingsChanged(() => {
    const connected = isUnrealEditorMcpConnected(dir);
    changes.push(connected);
    if (!connected) onClose?.();
  });
  const config: McpServerConfig = {
    id: "editor-test",
    name: "Editor",
    enabled: true,
    transport: { type: "stdio", command: process.execPath, args: [script] },
  };
  try {
    assert.equal(isUnrealEditorMcpConnected(dir), false);
    await manager.reconcile([config]);
    const runtime = manager.getRuntime("editor-test");
    assert.equal(runtime?.status, "connected", runtime?.errorMessage ?? "not connected");
    assert.deepEqual(runtime?.tools.map((tool) => tool.name), ["ping"]);
    const bound = listUnrealEditors().find((item) => item.serverId === "editor-test");
    assert.ok(bound);
    assert.equal(bound.ready, true);
    assert.equal(bound.engineVersion, "5.7.1");
    assert.equal(bound.projectKey, projectFileKey(projectFile));
    assert.equal(isUnrealEditorMcpConnected(dir), true);
    assert.equal(isUnrealEditorMcpConnected(otherWorkspace), false);
    await manager.setEnabled("editor-test", false);
    assert.equal(isUnrealEditorMcpConnected(dir), false);

    await manager.setEnabled("editor-test", true);
    const closed = new Promise<void>((resolve) => { onClose = resolve; });
    await manager.callTool("editor-test", "ping", {});
    await closed;
    assert.equal(manager.getRuntime("editor-test")?.status, "disconnected");
    assert.equal(listUnrealEditors().some((item) => item.serverId === "editor-test"), false);
    assert.deepEqual(changes, [true, false, true, false]);
  } finally {
    unsubscribe();
    resetUnrealEditorBindings();
    await manager.reconcile([]);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an HTTP pull session keeps probing until bound, then reconnects once the editor is lost", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let probe: McpServerProbe | null = null;
  const manager = new McpManager();
  t.mock.method(manager, "setMcpServerProbe", (value: McpServerProbe | null) => { probe = value; });
  installUnrealEditorMcp(manager);
  const installedProbe = probe as McpServerProbe | null;
  assert.ok(installedProbe);
  const payload = JSON.stringify({
    protocol: "unreal-editor",
    protocolVersion: 1,
    projectFile: "E:/NF/Game.uproject",
    engineVersion: "5.7.1",
    ready: false,
    capabilities: ["references", "open"],
  });
  let current = true;
  let responds = false;
  let queries = 0;
  let reconnects = 0;
  const recheck = async () => {
    t.mock.timers.tick(5_000);
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  resetUnrealEditorBindings();
  try {
    await installedProbe.onConnected({
      serverId: "http",
      toolNames: ["unreal_editor_capabilities"],
      serverCapabilities: { tools: {} },
      callTool: async () => {
        queries += 1;
        return responds ? textResult(payload, ToolReturnCode.Success) : textResult("offline", ToolReturnCode.GenericFailure);
      },
      stillCurrent: () => current,
      transport: "http",
      reconnect: () => { reconnects += 1; },
    });
    assert.deepEqual(listUnrealEditors(), []);
    await recheck();
    assert.equal(reconnects, 0, "a never-bound server is only probed, not reconnected");
    responds = true;
    await recheck();
    assert.equal(listUnrealEditors()[0]?.ready, false, "a valid session is connected even while loading");
    responds = false;
    await recheck();
    assert.deepEqual(listUnrealEditors(), []);
    assert.equal(reconnects, 1, "losing a bound editor rebuilds the MCP connection");
    await recheck();
    await recheck();
    assert.equal(queries, 4, "the old connection stops probing after asking to reconnect");
  } finally {
    current = false;
    installedProbe.onDisconnected("http");
    resetUnrealEditorBindings();
  }
});

const PUSH_STATUS = {
  protocol: "unreal-editor",
  protocolVersion: 1,
  projectFile: "E:/NF/Game.uproject",
  engineVersion: "5.7.1",
  ready: false,
  capabilities: ["references", "open", "status_push"],
  heartbeatIntervalMs: 1_000,
};

function captureProbe(t: TestContext): McpServerProbe {
  let probe: McpServerProbe | null = null;
  const manager = new McpManager();
  t.mock.method(manager, "setMcpServerProbe", (value: McpServerProbe | null) => { probe = value; });
  installUnrealEditorMcp(manager);
  const installed = probe as McpServerProbe | null;
  assert.ok(installed?.onNotification);
  return installed;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

test("a push server binds from its handshake, follows status pushes, and never polls", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const probe = captureProbe(t);
  let current = true;
  let queries = 0;
  let responds = true;
  let reconnects = 0;
  const capabilities = JSON.stringify({ ...PUSH_STATUS, ready: true });
  resetUnrealEditorBindings();
  try {
    await probe.onConnected({
      serverId: "push",
      toolNames: ["unreal_editor_capabilities"],
      serverCapabilities: { experimental: { "unreal-editor": PUSH_STATUS } },
      callTool: async () => {
        queries += 1;
        return responds
          ? textResult(capabilities, ToolReturnCode.Success)
          : textResult("offline", ToolReturnCode.GenericFailure);
      },
      stillCurrent: () => current,
      transport: "http",
      reconnect: () => { reconnects += 1; },
    });
    assert.equal(queries, 0, "the handshake binds without a tool call");
    assert.equal(listUnrealEditors()[0]?.ready, false);
    assert.equal(listUnrealEditors()[0]?.source, "push");

    probe.onNotification!("push", "notifications/unreal-editor/status", { ...PUSH_STATUS, ready: true });
    assert.equal(listUnrealEditors()[0]?.ready, true);

    for (let i = 0; i < 5; i += 1) {
      t.mock.timers.tick(2_000);
      probe.onNotification!("push", "notifications/unreal-editor/status", { ...PUSH_STATUS, ready: true });
      await flush();
    }
    assert.equal(queries, 0, "heartbeats keep the 5 s probe and the watchdog quiet");

    probe.onNotification!("push", "notifications/unreal-editor/status", { ready: true });
    t.mock.timers.tick(2_999);
    await flush();
    assert.equal(queries, 0, "an invalid status does not count as a heartbeat but waits the full timeout");
    t.mock.timers.tick(1);
    await flush();
    assert.equal(queries, 1, "a missed heartbeat window triggers exactly one capabilities call");
    assert.equal(listUnrealEditors()[0]?.ready, true);

    responds = false;
    t.mock.timers.tick(3_000);
    await flush();
    assert.equal(queries, 2);
    assert.deepEqual(listUnrealEditors(), [], "a failed rescue drops the binding");
    assert.equal(reconnects, 1, "a failed rescue rebuilds the MCP connection");
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(queries, 2, "no polling after the binding is dropped");

    probe.onNotification!("push", "notifications/unreal-editor/status", { ...PUSH_STATUS, ready: true });
    assert.equal(listUnrealEditors().length, 1, "a later status re-binds");

    probe.onNotification!("push", "notifications/unreal-editor/status", { ...PUSH_STATUS, shuttingDown: true });
    assert.deepEqual(listUnrealEditors(), []);
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(queries, 2, "shutdown stops the watchdog");
  } finally {
    current = false;
    probe.onDisconnected("push");
    resetUnrealEditorBindings();
  }
});

test("a status pushed before the handshake finishes wins over the declared snapshot", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const probe = captureProbe(t);
  resetUnrealEditorBindings();
  try {
    probe.onNotification!("early", "notifications/unreal-editor/status", { ...PUSH_STATUS, ready: true });
    assert.deepEqual(listUnrealEditors(), []);
    await probe.onConnected({
      serverId: "early",
      toolNames: ["unreal_editor_capabilities"],
      serverCapabilities: { experimental: { "unreal-editor": PUSH_STATUS } },
      callTool: async () => textResult("unexpected", ToolReturnCode.GenericFailure),
      stillCurrent: () => true,
      transport: "stdio",
      reconnect: () => {},
    });
    assert.equal(listUnrealEditors()[0]?.ready, true);
  } finally {
    probe.onDisconnected("early");
    resetUnrealEditorBindings();
  }
});

test("a declaration without the capabilities tool or status_push falls back to pull mode", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const probe = captureProbe(t);
  let queries = 0;
  const pullPayload = JSON.stringify({ ...PUSH_STATUS, capabilities: ["references", "open"] });
  resetUnrealEditorBindings();
  try {
    await probe.onConnected({
      serverId: "nopush",
      toolNames: ["unreal_editor_capabilities"],
      serverCapabilities: {
        experimental: { "unreal-editor": { ...PUSH_STATUS, capabilities: ["references", "open"] } },
      },
      callTool: async () => {
        queries += 1;
        return textResult(pullPayload, ToolReturnCode.Success);
      },
      stillCurrent: () => true,
      transport: "http",
      reconnect: () => {},
    });
    assert.equal(queries, 1);
    assert.equal(listUnrealEditors()[0]?.source, "probe");
    probe.onNotification!("nopush", "notifications/unreal-editor/status", { ...PUSH_STATUS, ready: true });
    assert.equal(listUnrealEditors()[0]?.ready, false, "pull servers ignore status pushes");
    t.mock.timers.tick(5_000);
    await flush();
    assert.equal(queries, 2, "pull servers keep the 5 s probe");

    probe.onDisconnected("nopush");
    await probe.onConnected({
      serverId: "notool",
      toolNames: [],
      serverCapabilities: { experimental: { "unreal-editor": PUSH_STATUS } },
      callTool: async () => textResult("unexpected", ToolReturnCode.GenericFailure),
      stillCurrent: () => true,
      transport: "stdio",
      reconnect: () => {},
    });
    assert.deepEqual(listUnrealEditors(), []);
  } finally {
    probe.onDisconnected("nopush");
    probe.onDisconnected("notool");
    resetUnrealEditorBindings();
  }
});

function startHttpEditor(port: number, mode: "push" | "pull"): Promise<HttpServer> {
  const status = mode === "push"
    ? PUSH_STATUS
    : { ...PUSH_STATUS, ready: true, capabilities: ["references", "open"] };
  const http = createServer(async (req, res) => {
    const server = new Server(
      { name: "editor", version: "0.0.0" },
      { capabilities: mode === "push" ? { tools: {}, experimental: { "unreal-editor": status } } : { tools: {} } },
    );
    const tool = (name: string) => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [tool("unreal_editor_capabilities"), tool("unreal_editor_find_references"), tool("unreal_editor_open")],
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: JSON.stringify(status) }],
    }));
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport as Parameters<Server["connect"]>[0]);
    let body = "";
    for await (const chunk of req) body += chunk;
    await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
  });
  return new Promise((resolve) => http.listen(port, "127.0.0.1", () => resolve(http)));
}

function stopHttpEditor(http: HttpServer): Promise<void> {
  http.closeAllConnections();
  return new Promise((resolve) => http.close(() => resolve()));
}

test("an HTTP editor that starts late, then restarts as another build, is picked up without a manual refresh", { timeout: 30_000 }, async () => {
  const placeholder = await startHttpEditor(0, "pull");
  const port = (placeholder.address() as AddressInfo).port;
  await stopHttpEditor(placeholder);

  const manager = new McpManager({ retryBaseMs: 50, retryMaxMs: 200 });
  resetUnrealEditorBindings();
  installUnrealEditorMcp(manager);
  const waitFor = async (check: () => boolean, label: string, ms = 10_000): Promise<void> => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  };
  const bound = () => listUnrealEditors().find((item) => item.serverId === "late-editor");
  let editor: HttpServer | null = null;
  try {
    await manager.reconcile([{
      id: "late-editor",
      name: "Editor",
      enabled: true,
      transport: { type: "http", url: `http://127.0.0.1:${port}/mcp` },
    }]);
    assert.equal(manager.getRuntime("late-editor")?.status, "error");

    editor = await startHttpEditor(port, "push");
    await waitFor(() => bound()?.source === "push", "push binding after a late start");

    await stopHttpEditor(editor);
    editor = null;
    await waitFor(() => !bound(), "binding dropped after heartbeats stop");

    editor = await startHttpEditor(port, "pull");
    await waitFor(() => bound()?.source === "probe", "re-handshake with the new build");
    assert.equal(manager.getRuntime("late-editor")?.status, "connected");
  } finally {
    await manager.reconcile([]);
    if (editor) await stopHttpEditor(editor);
    resetUnrealEditorBindings();
  }
});

test("a stdio push server binds from its handshake and refreshes tools on list_changed", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "unreal-editor-push-"));
  const sdk = join(repoRoot, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm");
  const sdkUrl = (file: string): string => pathToFileURL(join(sdk, file)).href;
  const projectFile = join(dir, "Game.uproject");
  await writeFile(projectFile, "{}");
  const status = { ...PUSH_STATUS, projectFile, heartbeatIntervalMs: 60_000 };
  const script = join(dir, "server.mjs");
  await writeFile(
    script,
    [
      `import { Server } from ${JSON.stringify(sdkUrl("server/index.js"))};`,
      `import { StdioServerTransport } from ${JSON.stringify(sdkUrl("server/stdio.js"))};`,
      `import { CallToolRequestSchema, ListToolsRequestSchema } from ${JSON.stringify(sdkUrl("types.js"))};`,
      `const status = ${JSON.stringify(status)};`,
      `const server = new Server({ name: "editor", version: "0.0.0" }, { capabilities: { tools: { listChanged: true }, experimental: { "unreal-editor": status } } });`,
      `const tool = (name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } });`,
      `const tools = [tool("make_ready"), tool("add_tool"), tool("unreal_editor_capabilities"), tool("unreal_editor_find_references"), tool("unreal_editor_open")];`,
      `server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));`,
      `server.setRequestHandler(CallToolRequestSchema, async (request) => {`,
      `  if (request.params.name === "make_ready") {`,
      `    await server.notification({ method: "notifications/unreal-editor/status", params: { ...status, ready: true } });`,
      `    return { content: [{ type: "text", text: "ok" }] };`,
      `  }`,
      `  if (request.params.name === "add_tool") {`,
      `    tools.push(tool("extra"));`,
      `    await server.sendToolListChanged();`,
      `    return { content: [{ type: "text", text: "ok" }] };`,
      `  }`,
      `  return { isError: true, content: [{ type: "text", text: "unexpected" }] };`,
      `});`,
      `await server.connect(new StdioServerTransport());`,
      `setInterval(() => {}, 1 << 30);`,
    ].join("\n"),
    "utf8",
  );
  const manager = new McpManager();
  resetUnrealEditorBindings();
  installUnrealEditorMcp(manager);
  const waitFor = async (check: () => boolean, label: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  };
  const config: McpServerConfig = {
    id: "push-editor",
    name: "Editor",
    enabled: true,
    transport: { type: "stdio", command: process.execPath, args: [script] },
  };
  try {
    await manager.reconcile([config]);
    const runtime = manager.getRuntime("push-editor");
    assert.equal(runtime?.status, "connected", runtime?.errorMessage ?? "not connected");
    const bound = listUnrealEditors().find((item) => item.serverId === "push-editor");
    assert.equal(bound?.source, "push", "bound from the handshake though the capabilities tool errors");
    assert.equal(bound?.ready, false);
    assert.equal(isUnrealEditorMcpConnected(dir), true);

    await manager.callTool("push-editor", "make_ready", {});
    await waitFor(() => listUnrealEditors()[0]?.ready === true, "ready push");

    await manager.callTool("push-editor", "add_tool", {});
    await waitFor(
      () => (manager.getRuntime("push-editor")?.tools ?? []).some((item) => item.name === "extra"),
      "tool list refresh",
    );
    assert.equal(listUnrealEditors()[0]?.ready, true, "a tool refresh keeps the pushed state");
  } finally {
    resetUnrealEditorBindings();
    await manager.reconcile([]);
    await rm(dir, { recursive: true, force: true });
  }
});
});
