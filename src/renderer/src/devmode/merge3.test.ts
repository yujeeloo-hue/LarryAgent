import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { merge3 } from "./merge3.js";

describe("merge3 identity & single-side", () => {
  it("returns ours when theirs equals base (agent untouched)", () => {
    const base = "a\nb\nc\n";
    const r = merge3(base, "a\nB\nc\n", base);
    assert.equal(r.merged, "a\nB\nc\n");
    assert.equal(r.conflictCount, 0);
    assert.ok(r.oursOnlyCount >= 1);
    assert.equal(r.theirsOnlyCount, 0);
  });

  it("returns theirs when ours equals base (clean tab reload path)", () => {
    const base = "a\nb\nc\n";
    const r = merge3(base, base, "a\nb\nC\n");
    assert.equal(r.merged, "a\nb\nC\n");
    assert.equal(r.conflictCount, 0);
    assert.ok(r.theirsOnlyCount >= 1);
    assert.equal(r.oursOnlyCount, 0);
  });

  it("no changes anywhere returns base untouched", () => {
    const r = merge3("x\ny\n", "x\ny\n", "x\ny\n");
    assert.equal(r.merged, "x\ny\n");
    assert.equal(r.conflictCount, 0);
  });
});

describe("merge3 auto-merge of non-colliding edits", () => {
  it("merges edits on distinct regions of the same file", () => {
    const base = "one\ntwo\nthree\nfour\nfive\n";
    const ours = "ONE\ntwo\nthree\nfour\nfive\n";
    const theirs = "one\ntwo\nthree\nfour\nFIVE\n";
    const r = merge3(base, ours, theirs);
    assert.equal(r.merged, "ONE\ntwo\nthree\nfour\nFIVE\n");
    assert.equal(r.conflictCount, 0);
  });

  it("merges adjacent (touching) line edits without conflict", () => {
    const base = "a\nb\nc\n";
    const r = merge3(base, "a\nB\nc\n", "a\nb\nC\n");
    assert.equal(r.merged, "a\nB\nC\n");
    assert.equal(r.conflictCount, 0);
  });

  it("same edit on both sides merges once", () => {
    const base = "a\nb\nc\n";
    const r = merge3(base, "a\nX\nc\n", "a\nX\nc\n");
    assert.equal(r.merged, "a\nX\nc\n");
    assert.equal(r.conflictCount, 0);
  });
});

describe("merge3 collision → theirs wins (decision #8)", () => {
  it("overlapping different edits take the agent's region", () => {
    const base = "a\nb\nc\nd\ne\n";
    const ours = "a\nB1\nB2\nd\ne\n";
    const theirs = "a\nAGENT\nc\nd\ne\n";
    const r = merge3(base, ours, theirs);
    assert.equal(r.merged, "a\nAGENT\nc\nd\ne\n");
    assert.equal(r.conflictCount, 1);
    assert.ok(r.oursOnlyCount === 0);
  });

  it("two insertions at the same point collide (git semantics), theirs wins", () => {
    const base = "a\nb\nc\n";
    const r = merge3(base, "a\nMINE\nb\nc\n", "a\nYOURS\nb\nc\n");
    assert.equal(r.merged, "a\nYOURS\nb\nc\n");
    assert.equal(r.conflictCount, 1);
  });

  it("insertion at the start of the other side's replacement collides", () => {
    const base = "a\nb\nc\n";
    const ours = "a\nX\nb\nc\n";
    const theirs = "a\nB\nc\n";
    const r = merge3(base, ours, theirs);
    assert.equal(r.merged, "a\nB\nc\n");
    assert.equal(r.conflictCount, 1);
  });

  it("ours' contiguous rewrite vs agent rewrite of the same line collides (line granularity)", () => {
    const base = "a\nb\nc\n";
    const ours = "a\nB\nX\nc\n";
    const theirs = "a\nB\nc\n";
    const r = merge3(base, ours, theirs);
    assert.equal(r.merged, "a\nB\nc\n");
    assert.equal(r.conflictCount, 1);
  });

  it("empty base with both sides adding different content collides", () => {
    const r = merge3("", "mine\n", "theirs\n");
    assert.equal(r.merged, "theirs\n");
    assert.equal(r.conflictCount, 1);
  });
});

describe("merge3 trailing newline sentinel", () => {
  it("user's trailing-newline addition survives when agent didn't touch EOF", () => {
    const base = "a\nb";
    const r = merge3(base, "a\nb\n", "A\nb");
    assert.equal(r.merged, "A\nb\n");
    assert.equal(r.conflictCount, 0);
  });

  it("both sides changing EOF differently resolves to theirs", () => {
    const base = "a\nb";
    const r = merge3(base, "a\nb\n", "a\nB");
    assert.equal(r.merged, "a\nB\n");
    assert.equal(r.conflictCount, 0);
  });

  it("keeps no-trailing-newline shape", () => {
    const r = merge3("a\nb", "a\nb", "z\na\nb");
    assert.equal(r.merged, "z\na\nb");
    assert.ok(!r.merged.endsWith("\n"));
  });
});

describe("merge3 eol handling", () => {
  it("rebuilds CRLF files with CRLF", () => {
    const base = "a\r\nb\r\nc\r\n";
    const r = merge3(base, "a\r\nB\r\nc\r\n", "a\r\nb\r\nC\r\n");
    assert.equal(r.merged, "a\r\nB\r\nC\r\n");
    assert.equal(r.conflictCount, 0);
  });
});

describe("merge3 multi-cluster stats", () => {
  it("counts ours-only / theirs-only / conflicts across the file", () => {
    const base = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";
    const ours = "one\n2\n3\n4\n5\n6\n7\n8\nnine\n10\n";
    const theirs = "1\n2\n3\n4\nFIVE\n6\n7\n8\nNINE\n10\n";
    const r = merge3(base, ours, theirs);
    assert.equal(r.merged, "one\n2\n3\n4\nFIVE\n6\n7\n8\nNINE\n10\n");
    assert.equal(r.conflictCount, 1);
    assert.equal(r.oursOnlyCount, 1);
    assert.equal(r.theirsOnlyCount, 1);
  });
});
