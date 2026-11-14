import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterCatalogForProject,
  isSkillVisibleInProject,
  listCatalogProjects,
  normalizeSkillProject,
  skillProjectKey,
  skillProjectLabel,
} from "./projectScope.js";

describe("normalizeSkillProject", () => {
  it("treats blank and wildcard forms as universal", () => {
    for (const raw of [undefined, null, "", "   ", "*", "ALL", "Universal"]) {
      assert.equal(normalizeSkillProject(raw), "");
    }
  });

  it("slugifies folder names", () => {
    assert.equal(normalizeSkillProject("JellyBot"), "jellybot");
    assert.equal(normalizeSkillProject("  my project "), "my-project");
    assert.equal(normalizeSkillProject("path/to"), "path-to");
    assert.equal(normalizeSkillProject("-dot-"), "dot");
  });
});

describe("skillProjectKey", () => {
  it("uses the last path segment", () => {
    assert.equal(skillProjectKey("/Users/youyee/Developer/JellyBot"), "jellybot");
    assert.equal(skillProjectKey("/Users/youyee/Developer/JellyBot/"), "jellybot");
    assert.equal(skillProjectKey("  /a/b/DailyWork  "), "dailywork");
    assert.equal(skillProjectKey("C:\\work\\ETHub"), "ethub");
  });

  it("returns empty for unusable paths", () => {
    for (const raw of [undefined, "", "/", "//", "~/", ".."]) {
      assert.equal(skillProjectKey(raw), "");
    }
  });
});

describe("isSkillVisibleInProject", () => {
  it("shows universal skills everywhere", () => {
    assert.equal(isSkillVisibleInProject(undefined, "jellybot"), true);
    assert.equal(isSkillVisibleInProject("", "dailywork"), true);
  });

  it("scopes project skills to their own project", () => {
    assert.equal(isSkillVisibleInProject("jellybot", "jellybot"), true);
    assert.equal(isSkillVisibleInProject("JellyBot", "jellybot"), true);
    assert.equal(isSkillVisibleInProject("jellybot", "dailywork"), false);
  });

  it("filters nothing without a project key", () => {
    assert.equal(isSkillVisibleInProject("jellybot", ""), true);
    assert.equal(isSkillVisibleInProject("jellybot", undefined), true);
  });
});

describe("filterCatalogForProject", () => {
  const entries = [
    { name: "universal-one" },
    { name: "jb-one", project: "jellybot" },
    { name: "dw-one", project: "dailywork" },
  ];

  it("keeps universal plus the current project", () => {
    assert.deepEqual(
      filterCatalogForProject(entries, "jellybot").map((e) => e.name),
      ["universal-one", "jb-one"],
    );
    assert.deepEqual(
      filterCatalogForProject(entries, "dailywork").map((e) => e.name),
      ["universal-one", "dw-one"],
    );
  });

  it("keeps everything for an unscoped session", () => {
    assert.equal(filterCatalogForProject(entries, "").length, 3);
  });
});

describe("skillProjectLabel / listCatalogProjects", () => {
  it("labels universal skills", () => {
    assert.equal(skillProjectLabel(undefined), "Universal");
    assert.equal(skillProjectLabel("jellybot"), "jellybot");
  });

  it("lists distinct project slugs", () => {
    const entries: { name: string; project?: string }[] = [
      { project: "jellybot", name: "a" },
      { project: "JellyBot", name: "b" },
      { name: "c" },
      { project: "dailywork", name: "d" },
    ];
    assert.deepEqual(listCatalogProjects(entries), ["dailywork", "jellybot"]);
  });
});
