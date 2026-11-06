/**
 * agentd tools persistence wiring: after wireToolsConfigPersistence(),
 * agent-driven mutations (create_mcp_server, skill enable toggles) must land
 * in tools.json under the configured root — not just in memory. Without this
 * wiring the Pi node silently loses MCP servers on restart.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureToolsConfigRoot } from "../toolsConfig/store.js";
import { TOOLS_CONFIG_FILE } from "../toolsConfig/types.js";
import { configureSkillsRoot, skillManager } from "../skills/index.js";
import { mcpManager } from "../mcp/index.js";
import { wireToolsConfigPersistence } from "./toolsPersistence.js";

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jb-agentd-persist-"));
  configureToolsConfigRoot(root);
  configureSkillsRoot(join(root, "skills"));
  wireToolsConfigPersistence();
  return root;
}

function readToolsConfig(root: string): Record<string, unknown> {
  const file = join(root, TOOLS_CONFIG_FILE);
  assert.ok(existsSync(file), `${TOOLS_CONFIG_FILE} written`);
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
}

test("mcpManager.upsertServer persists into tools.json after wiring", async () => {
  const root = freshRoot();
  const runtime = await mcpManager.upsertServer({
    name: "Demo MCP",
    enabled: false, // no connection attempt in tests
    transport: { type: "stdio", command: "echo", args: ["mcp"] },
  });
  assert.equal(runtime.status, "disconnected");

  const config = readToolsConfig(root);
  const servers = config.mcpServers as Array<Record<string, unknown>>;
  assert.equal(servers.length, 1);
  assert.equal(servers[0]!.name, "Demo MCP");
  assert.equal(servers[0]!.enabled, false);
  assert.deepEqual((servers[0]!.transport as Record<string, unknown>).args, ["mcp"]);
});

test("skillManager.setEnabled persists into tools.json after wiring", async () => {
  const root = freshRoot();
  const skill = await skillManager.upsertSkill({
    name: "demo-skill",
    description: "Demo skill for persistence wiring",
    body: "---\nname: demo-skill\n---\nDemo body.",
  });
  const updated = await skillManager.setEnabled(skill.id, false);

  assert.equal(updated.enabled, false);
  const config = readToolsConfig(root);
  const skills = config.skills as Array<Record<string, unknown>>;
  assert.equal(skills.length, 1);
  assert.equal(skills[0]!.name, "demo-skill");
  assert.equal(skills[0]!.enabled, false);
});
