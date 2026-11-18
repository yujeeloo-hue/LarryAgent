import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import AdmZip from "adm-zip";
import {
  configureSkillPersistence,
  configureSkillsRoot,
  skillManager,
} from "../skills/index.js";
import { configureToolsConfigRoot, patchToolsConfig } from "../toolsConfig/store.js";
import {
  exportSyncSkill,
  listSyncSkills,
  removeSyncSkill,
  upsertSyncSkill,
} from "./skillSync.js";

const ROOTS: string[] = [];

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jb-skill-sync-"));
  ROOTS.push(root);
  configureToolsConfigRoot(root);
  configureSkillsRoot(join(root, "skills"));
  configureSkillPersistence(async (skills) => {
    await patchToolsConfig({ skills });
  });
  await skillManager.startFromSettings([]);
  return root;
}

afterEach(async () => {
  for (const root of ROOTS) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  ROOTS.length = 0;
});

function zipOf(files: Record<string, string | Buffer>): string {
  const zip = new AdmZip();
  for (const [path, content] of Object.entries(files)) {
    zip.addFile(path, Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8"));
  }
  return zip.toBuffer().toString("base64");
}

describe("skillSync list", () => {
  it("reports metadata without body", async () => {
    await freshRoot();
    const record = await skillManager.upsertSkill({
      name: "alpha",
      description: "Alpha skill.",
      body: "Do the alpha thing.",
      enabled: true,
      files: [{ path: "notes.md", content: "hello" }],
    });

    const rows = listSyncSkills();
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0], {
      id: record.id,
      name: "alpha",
      enabled: true,
      description: "Alpha skill.",
      fileCount: 1,
    });
    assert.equal("body" in (rows[0] as object), false);
  });
});

describe("skillSync export/upsert", () => {
  it("round-trips a package including binary files, byte for byte", async () => {
    const root = await freshRoot();
    const binary = randomBytes(512);
    const record = await skillManager.upsertSkill({
      name: "beta",
      description: "Beta skill.",
      body: "Beta body.",
      enabled: true,
      files: [{ path: "data/blob.bin", content: "" }],
    });
    await writeFile(join(record.directory, "data", "blob.bin"), binary);
    await skillManager.reloadFromDisk();

    const exported = exportSyncSkill(record.id);
    assert.equal(exported.name, "beta");
    assert.ok(exported.zipBase64.length > 0);

    await removeSyncSkill(record.id);
    assert.equal(listSyncSkills().length, 0);

    const result = await upsertSyncSkill({
      name: exported.name,
      enabled: true,
      description: exported.description,
      zipBase64: exported.zipBase64,
    });
    assert.equal(result.action, "added");
    assert.equal(result.fileCount, 1);

    const restored = await readFile(
      join(root, "skills", "beta", "data", "blob.bin"),
    );
    assert.deepEqual(restored, binary);
    const body = await readFile(join(root, "skills", "beta", "SKILL.md"), "utf8");
    assert.match(body, /Beta body\./);
  });

  it("replaces the directory wholesale (mirror overwrite keeps the device id)", async () => {
    const root = await freshRoot();
    const record = await skillManager.upsertSkill({
      name: "gamma",
      description: "Gamma skill.",
      body: "Old body.",
      enabled: true,
      files: [{ path: "old.md", content: "old" }],
    });

    const incoming = zipOf({
      "SKILL.md": "---\nname: gamma\ndescription: Gamma skill.\n---\n\nNew body.\n",
      "new.md": "new",
    });
    const result = await upsertSyncSkill({
      name: "gamma",
      enabled: false,
      description: "Gamma skill.",
      zipBase64: incoming,
    });

    assert.equal(result.action, "overwritten");
    assert.equal(result.id, record.id);
    assert.equal(result.fileCount, 1);
    await assert.rejects(readFile(join(root, "skills", "gamma", "old.md")));
    assert.equal(
      await readFile(join(root, "skills", "gamma", "new.md"), "utf8"),
      "new",
    );
    const rows = listSyncSkills();
    assert.equal(rows[0]?.enabled, false);
  });

  it("leaves the existing package usable when the incoming zip is invalid", async () => {
    const root = await freshRoot();
    await skillManager.upsertSkill({
      name: "delta",
      description: "Delta skill.",
      body: "Delta body.",
      enabled: true,
      files: [{ path: "keep.md", content: "keep" }],
    });

    await assert.rejects(
      upsertSyncSkill({
        name: "delta",
        enabled: true,
        description: "",
        zipBase64: zipOf({ "SKILL.md": "no frontmatter, no description" }),
      }),
      /description/i,
    );

    assert.equal(
      await readFile(join(root, "skills", "delta", "keep.md"), "utf8"),
      "keep",
    );
    assert.equal(listSyncSkills().length, 1);
  });

  it("rejects a package whose skill name does not match", async () => {
    await freshRoot();
    await assert.rejects(
      upsertSyncSkill({
        name: "epsilon",
        enabled: true,
        description: "Epsilon.",
        zipBase64: zipOf({
          "SKILL.md": "---\nname: other\ndescription: Other.\n---\n\nBody.\n",
        }),
      }),
    );
  });

  it("rejects oversized packages in both directions", async () => {
    const root = await freshRoot();
    const record = await skillManager.upsertSkill({
      name: "big",
      description: "Big skill.",
      body: "Big body.",
      enabled: true,
    });
    await mkdir(join(record.directory, "assets"), { recursive: true });
    await writeFile(join(record.directory, "assets", "random.bin"), randomBytes(9 * 1024 * 1024));
    await skillManager.reloadFromDisk();

    assert.throws(() => exportSyncSkill(record.id), /too large/i);
    await assert.rejects(
      upsertSyncSkill({
        name: "big",
        enabled: true,
        description: "Big skill.",
        zipBase64: Buffer.alloc(9 * 1024 * 1024, 1).toString("base64"),
      }),
      /too large/i,
    );
    assert.equal(listSyncSkills().length, 1);
  });
});

describe("skillSync remove", () => {
  it("reports missing skills and deletes real ones", async () => {
    const root = await freshRoot();
    assert.deepEqual(await removeSyncSkill("nope"), { removed: false });

    const record = await skillManager.upsertSkill({
      name: "zeta",
      description: "Zeta skill.",
      body: "Zeta body.",
      enabled: true,
    });
    assert.deepEqual(await removeSyncSkill(record.id), { removed: true, id: record.id });
    await assert.rejects(readFile(join(root, "skills", "zeta", "SKILL.md")));
  });
});
