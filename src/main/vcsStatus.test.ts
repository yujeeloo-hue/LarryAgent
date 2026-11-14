/**
 * Pure parser tests for the Dev Mode VCS badges — no subprocess involved.
 * Perf contract reminder: status-only (see vcsStatus.ts header).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseGitZ,
  parseSvnBadges,
  parseUnifiedDiff,
} from "./vcsStatus.js";

test("parseGitZ maps porcelain XY pairs to badge letters", () => {
  const out = [
    " M src/a.cs", // worktree modified
    "M  src/b.cs", // staged modified
    "A  src/c.cs", // added (staged)
    "D  src/d.cs", // deleted (staged)
    " D src/e.cs", // deleted (worktree)
    "?? new.ts", // untracked
    "!! ignored.log", // ignored — skipped
  ].join("\0");
  const entries = parseGitZ(out);
  assert.deepEqual(entries, [
    { path: "src/a.cs", status: "M" },
    { path: "src/b.cs", status: "M" },
    { path: "src/c.cs", status: "A" },
    { path: "src/d.cs", status: "D" },
    { path: "src/e.cs", status: "D" },
    { path: "new.ts", status: "U" },
  ]);
});

test("parseGitZ collapses conflict pairs to C and skips rename sources", () => {
  const out = [
    "UU src/merge.cs", // both-modified conflict
    "AA src/twin.cs", // both-added conflict
    "R  src/renamed.cs", // rename → next NUL part is the OLD path
    "src/original.cs",
    "DD src/gone.cs", // both-deleted conflict
  ].join("\0");
  const entries = parseGitZ(out);
  assert.deepEqual(entries, [
    { path: "src/merge.cs", status: "C" },
    { path: "src/twin.cs", status: "C" },
    { path: "src/renamed.cs", status: "M" },
    { path: "src/gone.cs", status: "C" },
  ]);
});

test("parseSvnBadges maps status letters, skips externals and clean", () => {
  const out = [
    "M       src/a.cs",
    "A       src/new.cs",
    "D       src/old.cs",
    "!       src/missing.cs",
    "?       untracked-dir",
    "C       src/conflict.cs",
    "X       external/dir",
    "        untouched.cs",
  ].join("\n");
  const entries = parseSvnBadges(out);
  assert.deepEqual(entries, [
    { path: "src/a.cs", status: "M" },
    { path: "src/new.cs", status: "A" },
    { path: "src/old.cs", status: "D" },
    { path: "src/missing.cs", status: "D" },
    { path: "untracked-dir", status: "U" },
    { path: "src/conflict.cs", status: "C" },
  ]);
});

test("parseUnifiedDiff classifies added / modified / deleted runs", () => {
  const out = [
    "diff --git a/x b/x",
    "index 1a2b3c..4d5e6f 100644",
    "--- a/x",
    "+++ b/x",
    "@@ -10,4 +10,7 @@ void f() {",
    " context",
    "+added1",
    "+added2",
    " context",
    "-gone1",
    "-gone2",
    "+replaced",
    " context",
    "@@ -40,2 +43,1 @@ void g() {",
    " ctx",
    "-onlyDeleted",
    " ctx",
  ].join("\n");
  const { lines, deleted } = parseUnifiedDiff(out);
  assert.deepEqual(lines, [
    { line: 11, kind: "A" },
    { line: 12, kind: "A" },
    { line: 14, kind: "M" },
  ]);
  assert.deepEqual(deleted, [{ beforeLine: 44, count: 1 }]);
});

test("parseUnifiedDiff delete-at-top anchors to line 1", () => {
  const out = [
    "@@ -1,2 +1,1 @@",
    "-removedHeader",
    " kept",
  ].join("\n");
  const { lines, deleted } = parseUnifiedDiff(out);
  assert.deepEqual(lines, []);
  assert.deepEqual(deleted, [{ beforeLine: 1, count: 1 }]);
});
