import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  configureSkillPersistence,
  configureSkillsRoot,
  skillManager,
} from "./manager.js";
import {
  configureToolsConfigRoot,
  patchToolsConfig,
  readToolsConfig,
  writeToolsConfig,
} from "../toolsConfig/store.js";
import type { SkillConfig } from "../toolsConfig/types.js";

const ROOTS: string[] = [];

/** Fresh userData-like root wired for both tools.json and skills/. */
async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jb-skills-"));
  ROOTS.push(root);
  configureToolsConfigRoot(root);
  configureSkillsRoot(join(root, "skills"));
  configureSkillPersistence(async (skills) => {
    await patchToolsConfig({ skills });
  });
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

async function writeSkillDir(
  root: string,
  name: string,
  validSlug = true,
): Promise<void> {
  const dir = join(root, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    validSlug
      ? `---\nname: ${name}\ndescription: Test skill ${name}.\n---\n\nBody of ${name}.\n`
      : "no frontmatter body",
    "utf8",
  );
}

describe("SkillManager.persistMerged", () => {
  it("preserves disk-only registry entries when persisting runtime state", async () => {
    const root = await freshRoot();
    await writeSkillDir(root, "alpha");
    await writeToolsConfig({
      version: 1,
      mcpServers: [],
      skills: [skill("id-alpha", "alpha"), skill("id-beta", "beta")],
      toolPermissionOverrides: {},
      toolOfferOverrides: {},
      toolDisplayOverrides: {},
      toolOfferAutoBaseline: [],
      shellSafety: { enabled: true, fatalPolicy: "ask" },
    });

    // Hydration loss: startFromSettings only saw alpha.
    await skillManager.startFromSettings([skill("id-alpha", "alpha")]);

    // Any runtime mutation persists…
    await skillManager.setEnabled("id-alpha", false);

    const persisted = (await readToolsConfig()).skills;
    assert.deepEqual(
      persisted.map((s) => `${s.name}:${s.enabled}`).sort(),
      ["alpha:false", "beta:true"],
      "disk-only entry beta must survive the persist",
    );
  });

  it("does not resurrect a removed skill from the on-disk registry", async () => {
    const root = await freshRoot();
    await writeSkillDir(root, "alpha");
    await writeSkillDir(root, "beta");
    await writeToolsConfig({
      version: 1,
      mcpServers: [],
      skills: [skill("id-alpha", "alpha"), skill("id-beta", "beta")],
      toolPermissionOverrides: {},
      toolOfferOverrides: {},
      toolDisplayOverrides: {},
      toolOfferAutoBaseline: [],
      shellSafety: { enabled: true, fatalPolicy: "ask" },
    });
    await skillManager.startFromSettings([
      skill("id-alpha", "alpha"),
      skill("id-beta", "beta"),
    ]);

    await skillManager.removeSkill("id-beta");

    const persisted = (await readToolsConfig()).skills;
    assert.deepEqual(persisted.map((s) => s.name), ["alpha"]);
  });
});

describe("SkillManager project scope", () => {
  async function writeScopedSkillDir(
    root: string,
    name: string,
    project?: string,
  ): Promise<void> {
    const dir = join(root, "skills", name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Test skill ${name}.\n${project ? `project: ${project}\n` : ""}---\n\nBody of ${name}.\n`,
      "utf8",
    );
  }

  it("stores a new skill's project in the index and SKILL.md", async () => {
    const root = await freshRoot();
    await skillManager.startFromSettings([]);

    const record = await skillManager.upsertSkill({
      name: "jb-thing",
      description: "JellyBot-only helper.",
      body: "Do the thing.",
      enabled: true,
      project: "JellyBot",
    });

    assert.equal(record.project, "jellybot");
    const skillMd = await readFile(join(root, "skills", "jb-thing", "SKILL.md"), "utf8");
    assert.match(skillMd, /^project: jellybot$/m);
    const persisted = (await readToolsConfig()).skills;
    assert.equal(persisted[0]!.project, "jellybot");
    assert.deepEqual(
      skillManager.listEnabledCatalog().map((e) => `${e.name}:${e.project ?? "*"}`),
      ["jb-thing:jellybot"],
    );
  });

  it("keeps the project on update unless explicitly cleared", async () => {
    await freshRoot();
    await skillManager.startFromSettings([]);
    const created = await skillManager.upsertSkill({
      name: "scoped",
      description: "Scoped.",
      body: "x",
      enabled: true,
      project: "jellybot",
    });

    const kept = await skillManager.upsertSkill({
      id: created.id,
      name: "scoped",
      description: "Scoped.",
      body: "y",
      enabled: true,
    });
    assert.equal(kept.project, "jellybot");

    const cleared = await skillManager.upsertSkill({
      id: created.id,
      name: "scoped",
      description: "Scoped.",
      body: "z",
      enabled: true,
      project: "*",
    });
    assert.equal(cleared.project, undefined);
  });

  it("adopts a hand-edited frontmatter project on load", async () => {
    const root = await freshRoot();
    await writeScopedSkillDir(root, "hand-edited", "dailywork");
    await writeToolsConfig({
      version: 1,
      mcpServers: [],
      skills: [skill("id-hand", "hand-edited")],
      toolPermissionOverrides: {},
      toolOfferOverrides: {},
      toolDisplayOverrides: {},
      toolOfferAutoBaseline: [],
      shellSafety: { enabled: true, fatalPolicy: "ask" },
    });

    await skillManager.startFromSettings([skill("id-hand", "hand-edited")]);
    assert.equal(skillManager.listRecords()[0]!.project, "dailywork");
  });

  it("keeps an index-only project when the frontmatter has no key", async () => {
    const root = await freshRoot();
    await writeScopedSkillDir(root, "index-only");
    await writeToolsConfig({
      version: 1,
      mcpServers: [],
      skills: [{ ...skill("id-only", "index-only"), project: "jellybot" }],
      toolPermissionOverrides: {},
      toolOfferOverrides: {},
      toolDisplayOverrides: {},
      toolOfferAutoBaseline: [],
      shellSafety: { enabled: true, fatalPolicy: "ask" },
    });

    await skillManager.startFromSettings([
      { ...skill("id-only", "index-only"), project: "jellybot" },
    ]);
    assert.equal(skillManager.listRecords()[0]!.project, "jellybot");
  });
});

describe("SkillManager.reconcileOrphans", () => {
  it("re-registers orphaned skill directories and persists the registry", async () => {
    const root = await freshRoot();
    await writeSkillDir(root, "alpha"); // registered
    await writeSkillDir(root, "orphan-one"); // on disk, not in registry
    await mkdir(join(root, "skills", "not-a-skill"), { recursive: true }); // no SKILL.md
    await writeToolsConfig({
      version: 1,
      mcpServers: [],
      skills: [skill("id-alpha", "alpha")],
      toolPermissionOverrides: {},
      toolOfferOverrides: {},
      toolDisplayOverrides: {},
      toolOfferAutoBaseline: [],
      shellSafety: { enabled: true, fatalPolicy: "ask" },
    });
    await skillManager.startFromSettings([skill("id-alpha", "alpha")]);

    const recovered = await skillManager.reconcileOrphans();
    assert.deepEqual(recovered.map((s) => s.name), ["orphan-one"]);
    assert.equal(recovered[0]!.enabled, true);
    assert.equal(recovered[0]!.description, "Test skill orphan-one.");

    const persisted = (await readToolsConfig()).skills;
    assert.deepEqual(
      persisted.map((s) => s.name).sort(),
      ["alpha", "orphan-one"],
    );
    assert.deepEqual(
      skillManager.listRecords().map((s) => s.name),
      ["alpha", "orphan-one"],
    );

    // Idempotent: nothing left to recover.
    const again = await skillManager.reconcileOrphans();
    assert.deepEqual(again, []);
  });

  it("skips orphan directories with invalid slugs", async () => {
    const root = await freshRoot();
    // Uppercase/underscore slug fails SKILL_NAME_RE.
    const bad = join(root, "skills", "Bad_Name");
    await mkdir(bad, { recursive: true });
    await writeFile(
      join(bad, "SKILL.md"),
      "---\nname: Bad_Name\ndescription: x\n---\n\nbody",
      "utf8",
    );
    await skillManager.startFromSettings([]);

    const recovered = await skillManager.reconcileOrphans();
    assert.deepEqual(recovered, []);
    assert.deepEqual(skillManager.listRecords(), []);
  });
});
