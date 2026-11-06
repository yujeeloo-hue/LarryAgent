import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterSkillCatalog } from "./searchSkills.js";
import type { SkillCatalogEntry } from "../../skills/types.js";

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
