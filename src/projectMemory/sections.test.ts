import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applySectionUpdate,
  extractDocEntries,
  isLegacyProjectBody,
  parseProjectSections,
  synthesizeRecentSection,
} from "./sections.js";

describe("applySectionUpdate", () => {
  it("replaces a section body", () => {
    const body = applySectionUpdate(
      "# Project\n\n## Basics\n\nold",
      "basics",
      "new basics",
      "replace",
    );
    const parsed = parseProjectSections(body);
    assert.equal(parsed.sections.basics, "new basics");
  });

  it("appends within a section on merge", () => {
    let body = "# Project\n\n## Conventions\n\n- first";
    body = applySectionUpdate(body, "conventions", "- second", "merge");
    const parsed = parseProjectSections(body);
    assert.ok(parsed.sections.conventions.includes("- first"));
    assert.ok(parsed.sections.conventions.includes("- second"));
  });

  it("fills missing sections canonically", () => {
    const body = applySectionUpdate(
      "# Project\n\n## Basics\n\ntext",
      "docs_guide",
      "- note",
      "replace",
    );
    const parsed = parseProjectSections(body);
    assert.equal(parsed.sections.docs_guide, "- note");
    assert.equal(parsed.sections.basics, "text");
    for (const id of ["structure", "conventions", "recent"] as const) {
      assert.equal(parsed.sections[id], "_Empty._");
    }
  });
});

describe("five-section parsing", () => {
  it("splits all five canonical headings", () => {
    const parsed = parseProjectSections(
      [
        "# Demo",
        "",
        "## Basics",
        "b1",
        "",
        "## Structure",
        "s1",
        "",
        "## Conventions",
        "c1",
        "",
        "## Docs Guide",
        "d1",
        "",
        "## Recent",
        "r1",
      ].join("\n"),
    );
    assert.equal(parsed.preamble, "# Demo");
    assert.equal(parsed.sections.basics, "b1");
    assert.equal(parsed.sections.structure, "s1");
    assert.equal(parsed.sections.conventions, "c1");
    assert.equal(parsed.sections.docs_guide, "d1");
    assert.equal(parsed.sections.recent, "r1");
  });

  it("detects legacy four-section bodies", () => {
    assert.ok(isLegacyProjectBody("# P\n\n## Overview\n\nx\n\n## Work log\n\n- a"));
    assert.ok(!isLegacyProjectBody("# P\n\n## Basics\n\nx"));
  });
});

describe("docs entries + recent synthesis", () => {
  it("extracts bullets top-to-bottom with cap", () => {
    const body = "# T\n\n> rule\n\n- a\n- b\n\n- c\nplain line\n";
    assert.deepEqual(extractDocEntries(body), ["- a", "- b", "- c"]);
    assert.deepEqual(extractDocEntries(body, 2), ["- a", "- b"]);
  });

  it("synthesizes the recent mirror with fixed counts", () => {
    const worklog = ["- w1", "- w2", "- w3", "- w4"].join("\n");
    const handoff = ["- h1", "- h2"].join("\n");
    const pitfalls = ["- p1", "- p2", "- p3", "- p4", "- p5"].join("\n");
    const recent = synthesizeRecentSection({ worklogBody: worklog, handoffBody: handoff, pitfallsBody: pitfalls });
    assert.ok(recent.includes("Worklog (latest 3 · complete log: docs/WORKLOG.md):"));
    assert.ok(recent.includes("- w1"));
    assert.ok(recent.includes("- w3"));
    assert.ok(!recent.includes("- w4"));
    assert.ok(recent.includes("Handoff (latest 3 · complete log: docs/HANDOFF.md):"));
    assert.ok(recent.includes("- h1"));
    assert.ok(recent.includes("Pitfalls (latest 10 · complete log: docs/PITFALLS.md):"));
    assert.ok(recent.includes("- p5"));
    assert.ok(recent.includes("docs/STYLE.md and docs/DEPLOY.md"));
    assert.ok(recent.includes("do not hand-edit"));
  });

  it("renders placeholders when logs are empty", () => {
    const recent = synthesizeRecentSection({
      worklogBody: "",
      handoffBody: "",
      pitfallsBody: "",
    });
    assert.ok(recent.includes("- (none)"));
  });
});
