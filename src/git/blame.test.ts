/** Pure-parser tests for `git blame --line-porcelain` output. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGitBlamePorcelain, parseGitCommitMessages } from "./blame.js";

const FIXTURE = [
  "d29a7f1c0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b 1 1 1",
  "author You Yee",
  "author-mail <you@example.com>",
  "author-time 1737000000",
  "author-tz +0800",
  "committer You Yee",
  "committer-time 1737000000",
  "summary Add editor area",
  "filename src/a.ts",
  "\texport function main() {",
  "d29a7f1c0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b 2 2 1",
  "author You Yee",
  "author-mail <you@example.com>",
  "author-time 1737000000",
  "author-tz +0800",
  "committer You Yee",
  "committer-time 1737000000",
  "summary Add editor area",
  "filename src/a.ts",
  "\t  return;",
  "0000000000000000000000000000000000000000 3 3 1",
  "author Not Committed Yet",
  "author-mail <you@example.com>",
  "author-time 1737000600",
  "author-tz +0800",
  "committer Not Committed Yet",
  "committer-time 1737000600",
  "summary Version to commit",
  "filename src/a.ts",
  "\t}",
].join("\n");

describe("parseGitBlamePorcelain", () => {
  it("maps header blocks to per-line entries", () => {
    const out = parseGitBlamePorcelain(FIXTURE);
    assert.equal(out.length, 3);
    assert.deepEqual(
      out.map((e) => e.line),
      [1, 2, 3],
    );
    assert.equal(out[0]!.rev, "d29a7f1c0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b");
    assert.equal(out[0]!.author, "You Yee");
    assert.equal(out[0]!.time, 1737000000);
    assert.equal(out[0]!.summary, "Add editor area");
  });

  it("keeps the zero hash for uncommitted lines", () => {
    const out = parseGitBlamePorcelain(FIXTURE);
    assert.match(out[2]!.rev, /^0+$/);
    assert.equal(out[2]!.author, "Not Committed Yet");
  });

  it("does not confuse author-mail with author", () => {
    for (const entry of parseGitBlamePorcelain(FIXTURE)) {
      assert.ok(!entry.author.includes("@"));
      assert.ok(!entry.author.startsWith("author"));
    }
  });

  it("returns empty for empty output", () => {
    assert.deepEqual(parseGitBlamePorcelain(""), []);
  });
});

describe("parseGitCommitMessages", () => {
  it("maps hash → full message (subject + body)", () => {
    const hash = "d29a7f1c0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b";
    const out =
      `${hash}\x1fFix thing\n\nbody line\x1e` +
      `tooshort\x1fignored invalid hash\x1e`;
    const map = parseGitCommitMessages(out);
    assert.equal(map.size, 1);
    assert.equal(map.get(hash), "Fix thing\n\nbody line");
  });

  it("returns empty for empty output", () => {
    assert.equal(parseGitCommitMessages("").size, 0);
  });
});
