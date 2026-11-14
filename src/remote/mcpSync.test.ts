/**
 * mcpSync — the device half of the Relay MCP Hub. List/export strip env and
 * header values; upsert matches by name, keeps device ids and blank-to-keeps
 * secrets; remove also clears the mcp__ tool overrides.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureToolsConfigRoot, patchToolsConfig } from "../toolsConfig/store.js";
import { TOOLS_CONFIG_FILE } from "../toolsConfig/types.js";
import { mcpManager } from "../mcp/index.js";
import { loadToolPermissionOverrides } from "../tools/config.js";
import { loadToolOfferOverrides } from "../tools/offerConfig.js";
import { loadToolDisplayOverrides } from "../tools/displayConfig.js";
import {
  exportSyncMcpServer,
  listSyncMcpServers,
  mcpSyncMatchKey,
  removeSyncMcpServer,
  upsertSyncMcpServer,
} from "./mcpSync.js";

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jb-mcp-sync-"));
  configureToolsConfigRoot(root);
  return root;
}

function readToolsConfig(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, TOOLS_CONFIG_FILE), "utf8")) as Record<string, unknown>;
}

const SECRET = "mcp-env-secret-value";

test("listSyncMcpServers strips env/header values and carries runtime status", async () => {
  const root = freshRoot();
  await mcpManager.upsertServer({
    name: "Files",
    enabled: false,
    transport: { type: "stdio", command: "npx", args: ["-y", "fs"], env: { FS_KEY: SECRET } },
  });
  await mcpManager.upsertServer({
    name: "Remote",
    enabled: false,
    transport: { type: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
  });
  const listed = listSyncMcpServers();
  assert.equal(listed.length, 2);
  const files = listed.find((server) => server.name === "Files")!;
  assert.equal(files.transport.type, "stdio");
  assert.equal((files.transport as { command: string }).command, "npx");
  assert.equal("env" in files.transport, false);
  assert.equal(files.secretConfigured, true);
  assert.equal(files.status, "disconnected");
  const remote = listed.find((server) => server.name === "Remote")!;
  assert.equal("headers" in remote.transport, false);
  assert.equal(JSON.stringify(listed).includes(SECRET), false);
  void root;
});

test("exportSyncMcpServer includes secrets; upsert matches by name with blank-to-keep", async () => {
  const root = freshRoot();
  const created = await mcpManager.upsertServer({
    name: "Device Server",
    enabled: false,
    transport: { type: "http", url: "https://old.example/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
  });

  const exported = exportSyncMcpServer(created.id);
  assert.equal(exported.name, "Device Server");
  assert.deepEqual(exported.transport.headers, { Authorization: `Bearer ${SECRET}` });
  assert.throws(() => exportSyncMcpServer("missing"), /not found/i);

  // Upsert a NEW server by name (device-side merge has nothing to keep).
  const added = await upsertSyncMcpServer({
    name: "Hub Server",
    enabled: false,
    transport: { type: "stdio", command: "uvx", args: ["srv"], env: { NEW_KEY: "fresh" } },
  });
  assert.equal(added.action, "added");

  // Overwrite by name (case/space-insensitive): url updates, blank header
  // value keeps the stored secret.
  const overwritten = await upsertSyncMcpServer({
    name: "  device SERVER ",
    enabled: false,
    transport: { type: "http", url: "https://new.example/mcp", headers: { Authorization: "" } },
  });
  assert.equal(overwritten.action, "overwritten");
  assert.equal(overwritten.id, created.id, "matching rows keep the device id");
  const after = mcpManager.getConfigs().find((server) => server.id === created.id)!;
  assert.equal(after.transport.url, "https://new.example/mcp");
  assert.deepEqual(after.transport.headers, { Authorization: `Bearer ${SECRET}` });

  // A fresh add with blank values stores them blank.
  const blank = await upsertSyncMcpServer({
    name: "Blank",
    enabled: false,
    transport: { type: "http", url: "https://blank.example/mcp", headers: { Authorization: "" } },
  });
  const blankConfig = mcpManager.getConfigs().find((server) => server.id === blank.id)!;
  assert.equal(blankConfig.transport.headers?.Authorization ?? "", "");

  assert.rejects(() => upsertSyncMcpServer({ name: "  ", enabled: false, transport: { type: "http", url: "https://x.example" } }), /name/i);
  void root;
});

test("removeSyncMcpServer removes config plus mcp__ tool overrides", async () => {
  const root = freshRoot();
  const server = await mcpManager.upsertServer({
    name: "Cleanup",
    enabled: false,
    transport: { type: "stdio", command: "cleanup-bin" },
  });
  const toolName = `mcp__${server.id}__read_file`;
  await patchToolsConfig({
    mcpServers: mcpManager.getConfigs(),
    toolPermissionOverrides: { [toolName]: 1, get_current_time: 0 },
    toolOfferOverrides: { [toolName]: true },
    toolDisplayOverrides: { [toolName]: false },
  });
  // App startup loads the persisted overrides into the in-memory maps — the
  // clear-with-prefix helpers operate on those, not the JSON on disk.
  const persisted = readToolsConfig(root);
  loadToolPermissionOverrides(persisted.toolPermissionOverrides as Record<string, number>);
  loadToolOfferOverrides(persisted.toolOfferOverrides as Record<string, boolean>);
  loadToolDisplayOverrides(persisted.toolDisplayOverrides as Record<string, boolean>);

  const removed = await removeSyncMcpServer(server.id);
  assert.deepEqual(removed, { removed: true, id: server.id });
  assert.equal(mcpManager.getConfigs().some((item) => item.id === server.id), false);

  const config = readToolsConfig(root);
  const overrides = config.toolPermissionOverrides as Record<string, unknown>;
  assert.equal(toolName in overrides, false);
  assert.equal("get_current_time" in overrides, true, "unrelated overrides survive");
  assert.equal(toolName in (config.toolOfferOverrides as Record<string, unknown>), false);
  assert.equal(toolName in (config.toolDisplayOverrides as Record<string, unknown>), false);

  const again = await removeSyncMcpServer(server.id);
  assert.deepEqual(again, { removed: false });
});

test("mcpSyncMatchKey is the shared name identity", () => {
  assert.equal(mcpSyncMatchKey("  GitHub MCP "), mcpSyncMatchKey("github mcp"));
  assert.notEqual(mcpSyncMatchKey("github"), mcpSyncMatchKey("gitlab"));
});
