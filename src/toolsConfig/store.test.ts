import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  configureToolsConfigRoot,
  loadToolsConfig,
  patchToolsConfig,
  readToolsConfig,
  writeToolsConfig,
} from "./store.js";
import type { SkillConfig } from "./types.js";

const ROOTS: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jb-toolsconfig-"));
  ROOTS.push(root);
  configureToolsConfigRoot(root);
  return root;
}

afterEach(async () => {
  for (const root of ROOTS) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  ROOTS.length = 0;
});

function skill(id: string, name: string): SkillConfig {
  return { id, name, enabled: true };
}

describe("toolsConfig store read-failure protection", () => {
  it("returns empty config for missing file (ENOENT)", async () => {
    await freshRoot();
    const config = await loadToolsConfig();
    assert.deepEqual(config.skills, []);
    assert.deepEqual(config.mcpServers, []);
  });

  it("quarantines corrupted tools.json and starts from defaults", async () => {
    const root = await freshRoot();
    await writeFile(join(root, "tools.json"), "{not json", "utf8");

    const config = await loadToolsConfig();
    assert.deepEqual(config.skills, []);

    const entries = await readdir(root);
    const quarantined = entries.find((e) => e.startsWith("tools.json.corrupt-"));
    assert.ok(quarantined, `expected a quarantine file, got: ${entries.join(", ")}`);
    assert.ok(!entries.includes("tools.json"), "original corrupt file should be renamed away");
    const content = await readFile(join(root, quarantined!), "utf8");
    assert.equal(content, "{not json");

    // After quarantine the store starts fresh and writes work.
    await patchToolsConfig({ skills: [skill("id-1", "alpha")] });
    const reread = await readToolsConfig();
    assert.deepEqual(reread.skills.map((s) => s.name), ["alpha"]);
  });

  it("throws on systemic IO errors instead of caching empty defaults", async () => {
    const root = await freshRoot();
    // A directory where the file should be makes readFile fail with EISDIR.
    await mkdir(join(root, "tools.json"));
    await assert.rejects(() => loadToolsConfig());
  });

  it("patch preserves unrelated keys (skills untouched by mcp patch)", async () => {
    await freshRoot();
    await writeToolsConfig({
      version: 1,
      mcpServers: [],
      skills: [skill("id-1", "alpha")],
      toolPermissionOverrides: {},
      toolOfferOverrides: {},
      toolDisplayOverrides: {},
      toolOfferAutoBaseline: [],
    });
    await patchToolsConfig({ toolOfferAutoBaseline: ["run_shell"] });
    const config = await readToolsConfig();
    assert.deepEqual(config.skills.map((s) => s.name), ["alpha"]);
    assert.deepEqual(config.toolOfferAutoBaseline, ["run_shell"]);
  });
});
