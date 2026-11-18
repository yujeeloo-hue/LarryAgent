import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SKILL_CATALOG_HEADER, buildSkillCatalogNote } from "./catalogNote.js";

describe("buildSkillCatalogNote", () => {
  it("returns null without enabled skills", () => {
    assert.equal(buildSkillCatalogNote([]), null);
  });

  it("lists name and one-line description", () => {
    const text = buildSkillCatalogNote([
      { name: "pdf-export", description: "Export\n  reports to PDF." },
    ]);
    assert.equal(text, `${SKILL_CATALOG_HEADER}\n- pdf-export: Export reports to PDF.`);
  });

  it("clips long descriptions and caps the list", () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({
      name: `skill-${i}`,
      description: "x".repeat(400),
    }));
    const text = buildSkillCatalogNote(entries)!;
    assert.ok(text.length <= 3_100);
    assert.match(text, /more — use search_skills/);
    assert.ok(!text.includes("x".repeat(200)));
  });

  it("tags project-scoped skills", () => {
    const text = buildSkillCatalogNote([
      { name: "universal", description: "Everywhere." },
      { name: "jb-only", description: "JellyBot only.", project: "jellybot" },
    ])!;
    assert.match(text, /^- universal: Everywhere\.$/m);
    assert.match(text, /^- jb-only \[jellybot\]: JellyBot only\.$/m);
  });
});
