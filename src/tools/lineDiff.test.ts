/**
 * Line diff used for tool-card hunks and the +N/−M badge. The budget guard
 * matters as much as the output shape: this runs inline on the main process
 * for every write, and an unbounded Myers search froze the app for minutes on
 * large rewrites.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLineDiff, countLineChanges } from "./lineDiff.js";

function generatedFile(lines: number, salt: string, tweakAt: number[] = []): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i += 1) {
    const value = tweakAt.includes(i) ? `${salt}_TWEAKED` : salt;
    out.push(`  const value${i} = compute(${i}, "${value}");`);
  }
  return out.join("\n");
}

describe("buildLineDiff", () => {
  it("marks changed lines and keeps surrounding lines equal", () => {
    const diff = buildLineDiff("a\nb\nc\n", "a\nB\nc\n");
    assert.deepEqual(
      diff.map((line) => `${line.kind}:${line.text}`),
      ["equal:a", "del:b", "add:B", "equal:c"],
    );
  });

  it("numbers old and new lines independently", () => {
    const diff = buildLineDiff("a\nb\n", "a\nx\ny\n");
    const added = diff.filter((line) => line.kind === "add");
    assert.deepEqual(
      added.map((line) => line.newLine),
      [2, 3],
    );
    assert.ok(added.every((line) => line.oldLine === null));
  });

  it("honours explicit start line offsets", () => {
    const diff = buildLineDiff("b\n", "B\n", {
      startOldLine: 41,
      startNewLine: 41,
    });
    assert.equal(diff.find((line) => line.kind === "del")?.oldLine, 41);
    assert.equal(diff.find((line) => line.kind === "add")?.newLine, 41);
  });
});

describe("countLineChanges", () => {
  it("counts a small edit exactly", () => {
    assert.deepEqual(countLineChanges("a\nb\nc\n", "a\nB\nc\n"), {
      added: 1,
      removed: 1,
    });
  });

  it("stays exact and fast for a few edits inside a large file", () => {
    const before = generatedFile(20_000, "alpha");
    const after = generatedFile(20_000, "alpha", [3, 10_000, 19_996]);
    const startedAt = Date.now();
    const counts = countLineChanges(before, after);
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(counts, { added: 3, removed: 3 });
    assert.ok(elapsed < 2_000, `large-file edit diff took ${elapsed}ms`);
  });

  it("bounds a full rewrite instead of searching exhaustively", () => {
    const before = generatedFile(20_000, "alpha");
    const after = generatedFile(20_000, "beta");
    const startedAt = Date.now();
    const counts = countLineChanges(before, after);
    const elapsed = Date.now() - startedAt;
    assert.deepEqual(counts, { added: 20_000, removed: 20_000 });
    // The exhaustive search measured ~130s for this input.
    assert.ok(elapsed < 2_000, `full-rewrite diff took ${elapsed}ms`);
  });

  it("reports every line when one side is empty", () => {
    assert.deepEqual(countLineChanges("", "a\nb\n"), { added: 2, removed: 0 });
    assert.deepEqual(countLineChanges("a\nb\n", ""), { added: 0, removed: 2 });
  });
});
