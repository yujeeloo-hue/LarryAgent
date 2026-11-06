/**
 * Pure parser tests for `svn status` / `svn diff` / `svn commit` output —
 * no `svn` binary required (this machine has none; CI fixtures must too).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickScheduledAddAncestors, topMostPaths } from "./commit.js";
import {
  parseSvnCommitRevision,
  parseSvnDiffCounts,
  parseSvnStatus,
  parseSvnUpdateSummary,
} from "./parseSvn.js";

describe("parseSvnStatus", () => {
  it("maps plain status letters to kinds", () => {
    const out = parseSvnStatus(
      [
        "M       src/foo.ts",
        "A       src/new.ts",
        "D       src/gone.ts",
        "R       src/replaced.ts",
        "C       src/conflict.ts",
        "!       src/missing.ts",
        "?       untracked-dir",
      ].join("\n"),
    );
    assert.deepEqual(
      out.map((e) => [e.path, e.kind]),
      [
        ["src/foo.ts", "modified"],
        ["src/new.ts", "added"],
        ["src/gone.ts", "deleted"],
        ["src/replaced.ts", "replaced"],
        ["src/conflict.ts", "conflicted"],
        ["src/missing.ts", "missing"],
        ["untracked-dir", "untracked"],
      ],
    );
  });

  it("uses column 2 when column 1 is blank (props-only modification)", () => {
    const out = parseSvnStatus(" M      src/props-only.ts");
    assert.equal(out.length, 1);
    assert.equal(out[0]!.kind, "modified");
    assert.equal(out[0]!.path, "src/props-only.ts");
  });

  it("handles combined columns (MM) and scheduled-move suffix (+)", () => {
    const out = parseSvnStatus("MM      src/both.ts\nA  +    src/moved.ts");
    assert.equal(out[0]!.kind, "modified");
    assert.equal(out[0]!.path, "src/both.ts");
    assert.equal(out[1]!.kind, "added");
    assert.equal(out[1]!.path, "src/moved.ts");
  });

  it("skips externals (X), ignored (I), move annotations (>) and blanks", () => {
    const out = parseSvnStatus(
      [
        "X       external-dir",
        "I       ignored.log",
        "M       src/foo.ts",
        ">        moved to src/bar.ts",
        "",
        "Performing status on external item at 'external-dir':",
      ].join("\n"),
    );
    assert.deepEqual(out.map((e) => e.path), ["src/foo.ts"]);
  });

  it("strips CR from CRLF output", () => {
    const out = parseSvnStatus("M       src/foo.ts\r\n?       new\r\n");
    assert.deepEqual(
      out.map((e) => [e.path, e.kind]),
      [
        ["src/foo.ts", "modified"],
        ["new", "untracked"],
      ],
    );
  });
});

describe("parseSvnDiffCounts", () => {
  const CONTENT_DIFF = [
    "Index: src/foo.ts",
    "===================================================================",
    "--- src/foo.ts\t(revision 7)",
    "+++ src/foo.ts\t(working copy)",
    "@@ -1,4 +1,6 @@",
    " context line",
    "-removed line",
    "+added line",
    "+another added line",
    "-second removed line",
  ].join("\n");

  it("counts +/- lines per Index section", () => {
    const map = parseSvnDiffCounts(CONTENT_DIFF);
    const foo = map.get("src/foo.ts");
    assert.ok(foo);
    assert.equal(foo.insertions, 2);
    assert.equal(foo.deletions, 2);
    assert.equal(foo.hasContent, true);
    assert.equal(foo.binary, false);
  });

  it("skips property-change sections entirely", () => {
    const out = [
      CONTENT_DIFF,
      "",
      "Property changes on: src/foo.ts",
      "___________________________________________________________________",
      "Modified: svn:eol-style",
      "## -1 +1 ##",
      "+native",
      "-lf",
      "",
      "Index: src/props-only.ts",
      "===================================================================",
      "--- src/props-only.ts\t(revision 7)",
      "+++ src/props-only.ts\t(working copy)",
      "",
      "Property changes on: src/props-only.ts",
      "___________________________________________________________________",
      "Added: svn:mime-type",
      "## -0,0 +1 ##",
      "+application/octet-stream",
    ].join("\n");
    const map = parseSvnDiffCounts(out);
    assert.equal(map.get("src/foo.ts")!.insertions, 2);
    assert.equal(map.get("src/foo.ts")!.deletions, 2);
    // Property +/− lines and the ## hunk must not leak into counts.
    const propsOnly = map.get("src/props-only.ts")!;
    assert.equal(propsOnly.insertions, 0);
    assert.equal(propsOnly.deletions, 0);
    assert.equal(propsOnly.hasContent, false);
  });

  it("flags binary files via the marker line", () => {
    const out = [
      "Index: assets/logo.png",
      "===================================================================",
      "Cannot display: file marked as a binary type.",
      "svn:mime-type = application/octet-stream",
      "",
      "Index: src/foo.ts",
      "===================================================================",
      "--- src/foo.ts\t(revision 7)",
      "+++ src/foo.ts\t(working copy)",
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    const map = parseSvnDiffCounts(out);
    assert.equal(map.get("assets/logo.png")!.binary, true);
    assert.equal(map.get("assets/logo.png")!.hasContent, false);
    assert.equal(map.get("src/foo.ts")!.binary, false);
  });

  it("returns an empty map for empty diff output", () => {
    assert.equal(parseSvnDiffCounts("").size, 0);
    assert.equal(parseSvnDiffCounts("\n").size, 0);
  });

  it("does not count diff content that appears before any Index header", () => {
    const map = parseSvnDiffCounts("+stray\n-stray2\n");
    assert.equal(map.size, 0);
  });
});

describe("parseSvnCommitRevision", () => {
  it("extracts r<N> from commit output", () => {
    const out = [
      "Sending        src/foo.ts",
      "Transmitting file data .done",
      "Committing transaction ...",
      "Committed revision 42.",
    ].join("\n");
    assert.equal(parseSvnCommitRevision(out), "r42");
  });

  it("returns null when no committed marker exists (e.g. post-commit hook noise)", () => {
    assert.equal(parseSvnCommitRevision("Sending        a\n"), null);
    assert.equal(parseSvnCommitRevision(""), null);
  });
});

describe("topMostPaths", () => {
  it("keeps only top-most unversioned entries", () => {
    assert.deepEqual(
      topMostPaths([
        "newdir/sub/b.ts",
        "newdir",
        "other.ts",
        "newdir/sub",
      ]),
      ["newdir", "other.ts"],
    );
  });

  it("returns sorted output and handles single entries", () => {
    assert.deepEqual(topMostPaths(["b/a", "a"]), ["a", "b/a"]);
    assert.deepEqual(topMostPaths(["solo"]), ["solo"]);
    assert.deepEqual(topMostPaths([]), []);
  });

  it("does not treat sibling prefixes as ancestors", () => {
    assert.deepEqual(
      topMostPaths(["new", "new-file.ts"]),
      ["new", "new-file.ts"],
    );
  });
});

describe("parseSvnUpdateSummary", () => {
  it("summarizes a plain update", () => {
    const out = [
      "Updating '.':",
      "U    src/foo.cpp",
      "A    src/bar.cpp",
      "D    src/old.cpp",
      "Updated to revision 12345.",
    ].join("\n");
    const summary = parseSvnUpdateSummary(out);
    assert.equal(summary.revision, "12345");
    assert.equal(summary.alreadyCurrent, false);
    assert.equal(summary.changedCount, 3);
    assert.equal(summary.conflictCount, 0);
    assert.equal(summary.text, "Updated to revision 12345 · 3 path(s)");
  });

  it("reports an already-current working copy without a path count", () => {
    const summary = parseSvnUpdateSummary(
      "Updating 'src/foo.cpp':\nAt revision 999.\n",
    );
    assert.equal(summary.alreadyCurrent, true);
    assert.equal(summary.changedCount, 0);
    assert.equal(summary.text, "Already at revision 999");
  });

  it("prefers svn's conflict summary over the per-line markers", () => {
    const out = [
      "Updating '.':",
      "C    src/clash.cpp",
      "Updated to revision 20.",
      "Summary of conflicts:",
      "  Text conflicts: 1",
      "  Tree conflicts: 2",
    ].join("\n");
    const summary = parseSvnUpdateSummary(out);
    assert.equal(summary.conflictCount, 3);
    assert.equal(
      summary.text,
      "Updated to revision 20 · 1 path(s) · 3 conflict(s)",
    );
  });

  it("counts property-column actions and conflicts", () => {
    const summary = parseSvnUpdateSummary(
      ["Updating '.':", " U   src/props.cpp", " C   src/prop-clash.cpp"].join(
        "\n",
      ),
    );
    assert.equal(summary.changedCount, 2);
    assert.equal(summary.conflictCount, 1);
    assert.equal(summary.revision, null);
    assert.equal(summary.text, "Update finished · 2 path(s) · 1 conflict(s)");
  });
});

describe("pickScheduledAddAncestors", () => {
  it("returns added parents of a target, shallowest first", () => {
    assert.deepEqual(
      pickScheduledAddAncestors(
        ["newdir", "newdir/sub", "elsewhere"],
        ["newdir/sub/file.ts"],
      ),
      ["newdir", "newdir/sub"],
    );
  });

  it("ignores the target itself and unrelated added paths", () => {
    assert.deepEqual(
      pickScheduledAddAncestors(["newdir", "other"], ["newdir"]),
      [],
    );
  });

  it("does not treat sibling prefixes as parents", () => {
    assert.deepEqual(
      pickScheduledAddAncestors(["new"], ["new-file.ts"]),
      [],
    );
  });

  it("normalizes windows separators on both sides", () => {
    assert.deepEqual(
      pickScheduledAddAncestors(["newdir\\sub"], ["newdir\\sub\\file.ts"]),
      ["newdir/sub"],
    );
  });
});
