import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { filterSkillCatalog, searchSkillsHandler } from "./searchSkills.js";
import type { SkillCatalogEntry } from "../../skills/types.js";
import {
  configureSkillPersistence,
  configureSkillsRoot,
  skillManager,
} from "../../skills/manager.js";
import { configureToolsConfigRoot, patchToolsConfig } from "../../toolsConfig/store.js";
import type { ToolExecuteContext } from "../types.js";

const catalog: SkillCatalogEntry[] = [
  { name: "pdf-export", description: "Convert markdown notes to PDF." },
  { name: "futu-quotes", description: "Fetch stock quotes via OpenD." },
  { name: "commit-style", description: "Write conventional commit messages." },
];

describe("filterSkillCatalog", () => {
  it("lists all when query is empty", () => {
    const hits = filterSkillCatalog(catalog, "", 16);
    assert.deepEqual(
      hits.map((h) => h.name),
      ["pdf-export", "futu-quotes", "commit-style"],
    );
  });

  it("AND-matches name and description", () => {
    const byName = filterSkillCatalog(catalog, "pdf", 8);
    assert.deepEqual(
      byName.map((h) => h.name),
      ["pdf-export"],
    );
    const byDesc = filterSkillCatalog(catalog, "opend quotes", 8);
    assert.deepEqual(
      byDesc.map((h) => h.name),
      ["futu-quotes"],
    );
    assert.deepEqual(filterSkillCatalog(catalog, "pdf opend", 8), []);
  });

  it("prefers name hits and respects limit", () => {
    const hits = filterSkillCatalog(
      [
        { name: "notes", description: "pdf helper" },
        { name: "pdf-export", description: "other" },
      ],
      "pdf",
      1,
    );
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.name, "pdf-export");
  });
});

const ROOTS: string[] = [];

afterEach(async () => {
  for (const root of ROOTS) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
  ROOTS.length = 0;
});

function ctx(workspacePath: string): ToolExecuteContext {
  return { workspacePath } as unknown as ToolExecuteContext;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

async function seedScopedLibrary(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jb-search-skills-"));
  ROOTS.push(root);
  configureToolsConfigRoot(root);
  configureSkillsRoot(join(root, "skills"));
  configureSkillPersistence(async (skills) => {
    await patchToolsConfig({ skills });
  });
  await skillManager.startFromSettings([]);
  await skillManager.upsertSkill({
    name: "universal-helper",
    description: "Works in every project.",
    body: "x",
    enabled: true,
  });
  await skillManager.upsertSkill({
    name: "jellybot-package",
    description: "JellyBot release pipeline.",
    body: "x",
    enabled: true,
    project: "jellybot",
  });
}

describe("searchSkillsHandler project scope", () => {
  it("hides other projects' skills by default", async () => {
    await seedScopedLibrary();
    const result = await searchSkillsHandler({}, ctx("/work/DailyWork"));
    const text = textOf(result);
    assert.match(text, /universal-helper/);
    assert.doesNotMatch(text, /jellybot-package/);
    assert.match(text, /scope:"all"/);
  });

  it("shows the current project's own skills", async () => {
    await seedScopedLibrary();
    const text = textOf(await searchSkillsHandler({}, ctx("/work/JellyBot")));
    assert.match(text, /universal-helper/);
    assert.match(text, /jellybot-package \[jellybot\]/);
  });

  it('includes every project with scope:"all"', async () => {
    await seedScopedLibrary();
    const text = textOf(
      await searchSkillsHandler({ scope: "all" }, ctx("/work/DailyWork")),
    );
    assert.match(text, /jellybot-package \[jellybot\]/);
    assert.doesNotMatch(text, /scope:"all"/);
  });
});
