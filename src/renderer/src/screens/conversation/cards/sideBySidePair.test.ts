import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DiffLine } from "./diffTypes.js";
import {
  buildSideBySideSegments,
  pairSideBySideRows,
} from "./sideBySidePair.js";

function eq(text: string, oldLine: number): DiffLine {
  return { kind: "equal", text, oldLine, newLine: oldLine };
}
function del(text: string, oldLine: number): DiffLine {
  return { kind: "del", text, oldLine, newLine: null };
}
function add(text: string, newLine: number): DiffLine {
  return { kind: "add", text, oldLine: null, newLine };
}

describe("pairSideBySideRows", () => {
  it("pairs a del run with the following add run", () => {
    const rows = pairSideBySideRows([
      eq("keep", 1),
      del("old a", 2),
      del("old b", 3),
      add("new a", 2),
      add("new b", 3),
      eq("tail", 4),
    ]);
    assert.deepEqual(rows, [
      { kind: "equal", left: eq("keep", 1), right: eq("keep", 1) },
      { kind: "change", left: del("old a", 2), right: add("new a", 2) },
      { kind: "change", left: del("old b", 3), right: add("new b", 3) },
      { kind: "equal", left: eq("tail", 4), right: eq("tail", 4) },
    ]);
  });

  it("pads the shorter side with null", () => {
    const rows = pairSideBySideRows([
      del("old a", 1),
      del("old b", 2),
      add("new a", 1),
    ]);
    assert.deepEqual(rows, [
      { kind: "change", left: del("old a", 1), right: add("new a", 1) },
      { kind: "change", left: del("old b", 2), right: null },
    ]);

    const inserted = pairSideBySideRows([
      eq("keep", 1),
      add("fresh", 2),
      eq("tail", 2),
    ]);
    assert.deepEqual(inserted, [
      { kind: "equal", left: eq("keep", 1), right: eq("keep", 1) },
      { kind: "change", left: null, right: add("fresh", 2) },
      { kind: "equal", left: eq("tail", 2), right: eq("tail", 2) },
    ]);
  });

  it("keeps pure deletions left-only", () => {
    const rows = pairSideBySideRows([eq("a", 1), del("gone", 2), eq("b", 3)]);
    assert.deepEqual(rows[1], { kind: "change", left: del("gone", 2), right: null });
  });

  it("returns empty for empty input", () => {
    assert.deepEqual(pairSideBySideRows([]), []);
  });
});

describe("buildSideBySideSegments", () => {
  it("folds long equal runs and keeps changes visible", () => {
    const lines: DiffLine[] = [
      eq("l1", 1),
      eq("l2", 2),
      eq("l3", 3),
      eq("l4", 4),
      eq("l5", 5),
      eq("l6", 6),
      eq("l7", 7),
      eq("l8", 8),
      eq("l9", 9),
      del("x", 10),
      add("y", 10),
    ];
    const segments = buildSideBySideSegments(lines);
    // context = 3: l1..l6 fold, l7..l9 stay (context above the change).
    assert.equal(segments[0]!.type, "fold");
    if (segments[0]!.type === "fold") {
      assert.equal(segments[0]!.lines.length, 6);
      assert.equal(segments[0]!.lines[0]!.text, "l1");
    }
    const rowsSeg = segments[1]!;
    assert.equal(rowsSeg.type, "rows");
    if (rowsSeg.type === "rows") {
      const kinds = rowsSeg.rows.map((r) => r.kind);
      assert.deepEqual(kinds, ["equal", "equal", "equal", "change"]);
    }
  });

  it("returns a single rows segment when nothing folds", () => {
    const segments = buildSideBySideSegments([
      eq("a", 1),
      del("b", 2),
      add("c", 2),
    ]);
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.type, "rows");
  });

  it("emits all rows unfolded with a huge context", () => {
    const lines: DiffLine[] = [
      eq("l1", 1),
      eq("l2", 2),
      eq("l3", 3),
      del("x", 4),
    ];
    const segments = buildSideBySideSegments(lines, 10);
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.type, "rows");
    if (segments[0]!.type === "rows") {
      assert.equal(segments[0]!.rows.length, 4);
    }
  });
});
